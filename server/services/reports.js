'use strict';
/**
 * Laporan: metrik sesi, rekap per jam, timeline, dan produksi.
 * Durasi dihitung dengan partisi interval (lib/intervals) sehingga tidak ada durasi ganda;
 * kejadian yang melewati batas jam/tanggal/istirahat dipecah hanya untuk pelaporan.
 */
const T = require('../lib/time');
const { partition } = require('../lib/intervals');
const { ACTIVE_SQL } = require('../db');

const LABELS = { present: 'Hadir', absent: 'Tidak hadir (di luar istirahat/izin)', break: 'Istirahat terjadwal', leave: 'Izin disetujui', unknown: 'Pemantauan tidak tersedia' };
const CORR_MAP = { PRESENT: 'present', ABSENT: 'absent', BREAK: 'break', LEAVE: 'leave', UNKNOWN: 'unknown' };

module.exports = function reportsService(core) {
  const { db } = core;

  function sessionLayers(session, end) {
    const snap = JSON.parse(session.shift_snapshot || '{}');
    const now = core.clock.now();
    const breaks = (snap.breaks || []).map((b) => ({ start: b.start, end: b.end, name: b.name }));
    const leaves = db.all("SELECT id, start_at AS start, end_at AS end, reason FROM leave_permits WHERE operator_id = ? AND status = 'active' AND start_at < ? AND end_at > ?",
      session.operator_id, end, session.login_at);
    const events = db.all('SELECT * FROM presence_events WHERE session_id = ? ORDER BY start_at', session.id).map((e) => ({ ...e, start: e.start_at, end: e.end_at ?? Math.min(now, end) }));
    return {
      breaks, leaves, events,
      layers: { brk: breaks, leave: leaves, absence: events.filter((e) => e.kind === 'ABSENCE'), unknown: events.filter((e) => e.kind === 'MONITORING_UNAVAILABLE') },
    };
  }

  function classify(active) {
    const corr = [...active.absence, ...active.unknown].find((e) => e.corrected_classification);
    if (corr) return CORR_MAP[corr.corrected_classification];
    if (active.unknown.length) return 'unknown';
    if (active.absence.length) {
      if (active.brk.length) return 'break';
      if (active.leave.length) return 'leave';
      return 'absent';
    }
    return 'present';
  }

  function piecesFor(session, { splitHours = false } = {}) {
    const end = session.logout_at ?? core.clock.now();
    const L = sessionLayers(session, end);
    if (end <= session.login_at) return { pieces: [], ...L, end };
    return { pieces: partition(session.login_at, end, L.layers, classify, { splitHours }), ...L, end };
  }

  /** Metrik satu sesi (dipakai juga untuk ringkasan logout). */
  function sessionMetrics(session) {
    const { pieces, events, end } = piecesFor(session);
    const dur = { present: 0, absent: 0, break: 0, leave: 0, unknown: 0 };
    for (const p of pieces) dur[p.label] += p.end - p.start;
    const absenceEvents = events.filter((e) => e.kind === 'ABSENCE').map((e) => {
      const parts = { absent: 0, break: 0, leave: 0, present: 0, unknown: 0 };
      for (const p of pieces) if (p.active.absence.some((a) => a.id === e.id)) parts[p.label] += p.end - p.start;
      return { id: e.id, start_at: e.start_at, end_at: e.end_at, duration_ms: (e.end_at ?? end) - e.start_at, open: e.end_at == null,
        classification: e.classification, corrected_classification: e.corrected_classification, verification_status: e.verification_status, parts };
    });
    const stamping = core.stamping.countsBySession(session.id);
    // Stamping saat kamera tidak mendeteksi orang → ditandai untuk ditinjau
    const tol = core.settings.get('stamp_while_absent_tolerance_s') * 1000;
    const absentPieces = pieces.filter((p) => p.label === 'absent' && p.end - p.start > 2 * tol);
    let stampWhileAbsent = 0;
    if (absentPieces.length && stamping.total) {
      for (const p of absentPieces) {
        stampWhileAbsent += db.get('SELECT COUNT(*) AS n FROM stamping_events WHERE session_id = ? AND device_time >= ? AND device_time < ?', session.id, p.start + tol, p.end - tol).n;
      }
    }
    const jobs = db.all('SELECT * FROM session_jobs WHERE session_id = ? ORDER BY started_at', session.id);
    const production = core.production.analyzeJobs(jobs);
    return {
      duration_ms: end - session.login_at,
      present_ms: dur.present, absent_ms: dur.absent, break_ms: dur.break, leave_ms: dur.leave, unknown_ms: dur.unknown,
      absence_count: absenceEvents.filter((e) => e.parts.absent > 0).length,
      absence_events: absenceEvents,
      stamping, stamp_while_absent: stampWhileAbsent,
      production: { cycles: production.cycles, qty: production.qty, standard_cycles: production.standard_cycles, diff: production.diff, diff_pct: production.diff_pct,
        status: production.status, status_label: production.status_label, completeness: production.completeness, ratio_total_per_good: production.ratio_total_per_good },
      jobs_count: jobs.length,
      open: session.logout_at == null,
    };
  }

  function sessionFilterSql(f) {
    const where = ['1=1'], params = [];
    if (f.from) { where.push('(s.logout_at IS NULL OR s.logout_at >= ?)'); params.push(Number(f.from)); }
    if (f.to) { where.push('s.login_at < ?'); params.push(Number(f.to)); }
    if (f.machine_id) { where.push('s.machine_id = ?'); params.push(f.machine_id); }
    if (f.operator_id) { where.push('s.operator_id = ?'); params.push(f.operator_id); }
    if (f.shift_id) { where.push('s.shift_id = ?'); params.push(Number(f.shift_id)); }
    if (f.work_order_id) { where.push('EXISTS (SELECT 1 FROM session_jobs j WHERE j.session_id = s.id AND j.work_order_id = ?)'); params.push(f.work_order_id); }
    if (f.product_id) { where.push('EXISTS (SELECT 1 FROM session_jobs j WHERE j.session_id = s.id AND j.product_id = ?)'); params.push(f.product_id); }
    if (f.machines) { where.push(`s.machine_id IN (${f.machines.map(() => '?').join(',')})`); params.push(...f.machines); }
    if (f.open === '1') where.push(`s.status IN ${ACTIVE_SQL}`);
    if (f.not_logged_out === '1') where.push('s.not_logged_out = 1');
    return { where: where.join(' AND '), params };
  }

  function listSessions(f = {}) {
    const { where, params } = sessionFilterSql(f);
    return db.all(`SELECT s.*, o.name AS operator_name, o.employee_no, m.name AS machine_name FROM sessions s
      JOIN operators o ON o.id = s.operator_id JOIN machines m ON m.id = s.machine_id
      WHERE ${where} AND s.status != 'PERMISSION_FAILED' ORDER BY s.login_at DESC LIMIT ?`, ...params, Math.min(Number(f.limit) || 300, 2000));
  }

  function sessionReport(f = {}) {
    const rows = listSessions(f).map((s) => {
      const snap = JSON.parse(s.shift_snapshot || '{}');
      const metrics = sessionMetrics(s);
      if (f.classification) metrics.absence_events = metrics.absence_events.filter((e) => (e.corrected_classification ? CORR_MAP[e.corrected_classification] : (e.parts.absent ? 'absent' : e.parts.break ? 'break' : 'leave')) === f.classification);
      return { id: s.id, machine_id: s.machine_id, machine_name: s.machine_name, operator_id: s.operator_id, operator_name: s.operator_name, employee_no: s.employee_no,
        shift_id: s.shift_id, shift_name: snap.name, shift_date: s.shift_date, login_at: s.login_at, logout_at: s.logout_at, status: s.status,
        status_label: core.sessions.STATUS_LABEL[s.status], not_logged_out: !!s.not_logged_out, late_min: s.late_min, end_reason: s.end_reason, simulated: !!s.simulated, ...metrics };
    });
    return rows;
  }

  /** Rekap per jam: durasi keberadaan & stamping per kategori per jam (WIB). */
  function hourly(f = {}) {
    const buckets = new Map();
    const b = (h) => { if (!buckets.has(h)) buckets.set(h, { hour: h, present: 0, absent: 0, break: 0, leave: 0, unknown: 0, normal: 0, setup: 0, trial: 0, rework: 0, unassigned: 0, no_session: 0, total: 0 }); return buckets.get(h); };
    const from = f.from ? Number(f.from) : null, to = f.to ? Number(f.to) : null;
    for (const s of listSessions({ ...f, limit: 2000 })) {
      const { pieces } = piecesFor(s, { splitHours: true });
      for (const p of pieces) {
        const st = Math.max(p.start, from ?? p.start), en = Math.min(p.end, to ?? p.end);
        if (en > st) b(p.hour)[p.label] += en - st;
      }
    }
    const where = ['1=1'], params = [];
    if (from) { where.push('device_time >= ?'); params.push(from); }
    if (to) { where.push('device_time < ?'); params.push(to); }
    if (f.machine_id) { where.push('machine_id = ?'); params.push(f.machine_id); }
    if (f.machines) { where.push(`machine_id IN (${f.machines.map(() => '?').join(',')})`); params.push(...f.machines); }
    if (f.operator_id) { where.push('operator_id = ?'); params.push(f.operator_id); }
    if (f.shift_id) { where.push('shift_id = ?'); params.push(Number(f.shift_id)); }
    if (f.work_order_id) { where.push('work_order_id = ?'); params.push(f.work_order_id); }
    if (f.product_id) { where.push('product_id = ?'); params.push(f.product_id); }
    const rows = db.all(`SELECT ((device_time + ${T.OFFSET}) / ${T.HOUR}) * ${T.HOUR} - ${T.OFFSET} AS hour, category, no_session, COUNT(*) AS n
      FROM stamping_events WHERE ${where.join(' AND ')} GROUP BY hour, category, no_session`, ...params);
    for (const r of rows) {
      const x = b(r.hour);
      if (r.no_session) x.no_session += r.n; else x[r.category] += r.n;
      x.total += r.n;
    }
    return [...buckets.values()].sort((a, c) => a.hour - c.hour);
  }

  /** Timeline sesi: keberadaan, stamping per menit, pekerjaan, tap, penanda tinjauan. */
  function timeline(sessionId) {
    const s = db.get('SELECT s.*, o.name AS operator_name FROM sessions s JOIN operators o ON o.id = s.operator_id WHERE s.id = ?', sessionId);
    if (!s) return null;
    const { pieces, events, breaks, leaves, end } = piecesFor(s);
    const stamps = db.all(`SELECT (device_time / 60000) * 60000 AS minute, category, COUNT(*) AS n FROM stamping_events WHERE session_id = ? GROUP BY minute, category ORDER BY minute`, s.id);
    const jobs = db.all('SELECT j.*, w.product_id AS wo_product FROM session_jobs j LEFT JOIN work_orders w ON w.id = j.work_order_id WHERE session_id = ? ORDER BY started_at', s.id);
    const taps = db.all('SELECT device_time, received_at, outcome, message FROM tap_events WHERE session_id = ? ORDER BY device_time', s.id);
    const tol = core.settings.get('stamp_while_absent_tolerance_s') * 1000;
    const flagged = [];
    for (const p of pieces.filter((x) => x.label === 'absent' && x.end - x.start > 2 * tol)) {
      const n = db.get('SELECT COUNT(*) AS n, MIN(device_time) AS first FROM stamping_events WHERE session_id = ? AND device_time >= ? AND device_time < ?', s.id, p.start + tol, p.end - tol);
      if (n.n) flagged.push({ start: p.start, end: p.end, count: n.n, note: 'Stamping tercatat saat kamera tidak mendeteksi orang — tinjau mode operasi, kualitas deteksi, dan sinkronisasi waktu' });
    }
    const anomalies = db.all('SELECT * FROM counter_anomalies WHERE machine_id = ? AND at >= ? AND at <= ? ORDER BY at', s.machine_id, s.login_at, end);
    return { session: s, start: s.login_at, end, pieces: pieces.map(({ start, end: e, label }) => ({ start, end: e, label })), events, breaks, leaves, stamps, jobs, taps, flagged, anomalies };
  }

  /** Laporan produksi & penyimpangan per pekerjaan dan dikelompokkan. */
  function production(f = {}) {
    const where = ['1=1'], params = [];
    if (f.from) { where.push('(j.ended_at IS NULL OR j.ended_at >= ?)'); params.push(Number(f.from)); }
    if (f.to) { where.push('j.started_at < ?'); params.push(Number(f.to)); }
    if (f.machine_id) { where.push('j.machine_id = ?'); params.push(f.machine_id); }
    if (f.machines) { where.push(`j.machine_id IN (${f.machines.map(() => '?').join(',')})`); params.push(...f.machines); }
    if (f.operator_id) { where.push('j.operator_id = ?'); params.push(f.operator_id); }
    if (f.shift_id) { where.push('s.shift_id = ?'); params.push(Number(f.shift_id)); }
    if (f.work_order_id) { where.push('j.work_order_id = ?'); params.push(f.work_order_id); }
    if (f.product_id) { where.push('j.product_id = ?'); params.push(f.product_id); }
    const jobs = db.all(`SELECT j.*, s.shift_id, s.shift_date, o.name AS operator_name, p.name AS product_name, ps.name AS stage_name FROM session_jobs j
      JOIN sessions s ON s.id = j.session_id JOIN operators o ON o.id = j.operator_id LEFT JOIN products p ON p.id = j.product_id
      LEFT JOIN process_stages ps ON ps.id = j.stage_id WHERE ${where.join(' AND ')} ORDER BY j.started_at DESC LIMIT 2000`, ...params);
    const rows = jobs.map((j) => {
      const a = core.production.analyzeJob(j);
      return { ...a, job: j };
    });
    const groupKey = { work_order: (j) => j.work_order_id || '-', product: (j) => `${j.product_id || '-'} / ${j.stage_name || '-'}`, machine: (j) => j.machine_id, operator: (j) => `${j.operator_id} ${j.operator_name}`, shift: (j) => `Shift ${j.shift_id} ${j.shift_date}` }[f.group_by || 'work_order'];
    const groups = new Map();
    for (const j of jobs) { const k = groupKey(j); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(j); }
    const grouped = [...groups.entries()].map(([key, js]) => ({ key, jobs: js.length, ...core.production.analyzeJobs(js) }));
    // Stamping tanpa sesi operator di rentang ini
    const nsWhere = ['no_session = 1'], nsParams = [];
    if (f.from) { nsWhere.push('device_time >= ?'); nsParams.push(Number(f.from)); }
    if (f.to) { nsWhere.push('device_time < ?'); nsParams.push(Number(f.to)); }
    if (f.machine_id) { nsWhere.push('machine_id = ?'); nsParams.push(f.machine_id); }
    const noSession = db.all(`SELECT machine_id, COUNT(*) AS n, MIN(device_time) AS first, MAX(device_time) AS last FROM stamping_events WHERE ${nsWhere.join(' AND ')} GROUP BY machine_id`, ...nsParams);
    return { rows, grouped, no_session: noSession };
  }

  function absenceList(f = {}) {
    const where = ['1=1'], params = [];
    if (f.from) { where.push('(e.end_at IS NULL OR e.end_at >= ?)'); params.push(Number(f.from)); }
    if (f.to) { where.push('e.start_at < ?'); params.push(Number(f.to)); }
    if (f.machine_id) { where.push('e.machine_id = ?'); params.push(f.machine_id); }
    if (f.machines) { where.push(`e.machine_id IN (${f.machines.map(() => '?').join(',')})`); params.push(...f.machines); }
    if (f.operator_id) { where.push('e.operator_id = ?'); params.push(f.operator_id); }
    if (f.shift_id) { where.push('e.shift_id = ?'); params.push(Number(f.shift_id)); }
    if (f.kind) { where.push('e.kind = ?'); params.push(f.kind); }
    if (f.classification) { where.push('COALESCE(e.corrected_classification, e.classification) = ?'); params.push(f.classification); }
    if (f.verification_status) { where.push('e.verification_status = ?'); params.push(f.verification_status); }
    return db.all(`SELECT e.*, o.name AS operator_name, COALESCE(e.end_at, ?) - e.start_at AS current_duration_ms FROM presence_events e LEFT JOIN operators o ON o.id = e.operator_id
      WHERE ${where.join(' AND ')} ORDER BY e.start_at DESC LIMIT 1000`, core.clock.now(), ...params);
  }

  return { LABELS, sessionMetrics, sessionReport, hourly, timeline, production, listSessions, absenceList, piecesFor };
};
