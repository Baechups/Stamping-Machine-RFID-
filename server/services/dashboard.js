'use strict';
/** Ringkasan kartu mesin untuk dashboard & terminal. */
const { ACTIVE_SQL } = require('../db');

const PHYSICAL_LABEL = { RUNNING: 'Berjalan', STOPPED: 'Berhenti', IDLE: 'Siaga', ESTOP: 'Emergency stop', FAULT: 'Gangguan', POWER_OFF: 'Daya padam', UNKNOWN: 'Tidak diketahui' };
const PERMISSION_LABEL = { REQUESTED: 'Menunggu konfirmasi', GRANTED: 'Diizinkan', DENIED: 'Ditolak', SUSPENDED: 'Ditangguhkan', REVOKE_REQUESTED: 'Pencabutan diminta', REVOKED: 'Dicabut', NONE: 'Tidak ada' };
const DEVICE_LABEL = { ok: 'Normal', offline: 'Terputus', unknown: 'Tidak diketahui', fault: 'Gangguan', degraded: 'Tidak andal', obstructed: 'Tertutup' };

module.exports = function dashboardService(core) {
  const { db } = core;

  function machineCard(m, now = core.clock.now()) {
    const ms = db.get('SELECT * FROM machine_state WHERE machine_id = ?', m.id) || {};
    const s = db.get(`SELECT s.*, o.name AS operator_name, o.employee_no, o.photo_url FROM sessions s JOIN operators o ON o.id = s.operator_id WHERE s.machine_id = ? AND s.status IN ${ACTIVE_SQL}`, m.id);
    const devices = {};
    for (const d of core.devices.list(m.id)) devices[d.type] = { status: d.status, label: DEVICE_LABEL[d.status] || d.status, detail: d.status_detail, last_seen: d.last_seen, clock_offset_ms: d.clock_offset_ms, simulated: !!d.simulated };
    const edgeOk = devices.edge?.status === 'ok';
    const ctrlOk = devices.controller?.status === 'ok';
    const physical = edgeOk && ctrlOk ? ms.physical_state || 'UNKNOWN' : 'UNKNOWN';
    const card = {
      id: m.id, number: m.number, name: m.name, area: m.area,
      physical_state: physical, physical_label: PHYSICAL_LABEL[physical] || physical,
      devices, terminal: { message: ms.terminal_message, level: ms.terminal_level, at: ms.terminal_message_at },
      presence: core.presence.currentStatus(m.id, now),
      session: null, alerts: [], flags: [],
    };
    if (s) {
      const snap = JSON.parse(s.shift_snapshot || '{}');
      const metrics = core.reports.sessionMetrics(s);
      const job = db.get(`SELECT j.*, p.name AS product_name, ps.name AS stage_name FROM session_jobs j LEFT JOIN products p ON p.id = j.product_id
        LEFT JOIN process_stages ps ON ps.id = j.stage_id WHERE j.session_id = ? AND j.ended_at IS NULL`, s.id);
      card.session = {
        id: s.id, operator_id: s.operator_id, operator_name: s.operator_name, employee_no: s.employee_no, photo_url: s.photo_url,
        shift_id: s.shift_id, shift_name: snap.name, shift_end: snap.end, login_at: s.login_at, duration_ms: now - s.login_at,
        status: s.status, status_label: core.sessions.STATUS_LABEL[s.status], status_message: s.status_message,
        permission_status: s.permission_status, permission_label: PERMISSION_LABEL[s.permission_status],
        not_logged_out: !!s.not_logged_out, late_min: s.late_min, simulated: !!s.simulated,
        absent_total_ms: metrics.absent_ms, unknown_ms: metrics.unknown_ms, absence_count: metrics.absence_count,
        stamping: metrics.stamping, production: metrics.production, stamp_while_absent: metrics.stamp_while_absent,
        job: job ? { id: job.id, work_order_id: job.work_order_id, product_id: job.product_id, product_name: job.product_name, stage_name: job.stage_name, category: job.category, standard: job.standard_snapshot ? JSON.parse(job.standard_snapshot) : null } : null,
      };
      if (s.not_logged_out) card.flags.push('Belum logout');
      if (s.status === 'LOGOUT_FAILED') card.flags.push('Logout gagal');
      if (metrics.production.status === 'REVIEW') card.flags.push('Penyimpangan produksi');
      if (metrics.stamp_while_absent > 0) card.flags.push('Stamping saat tidak terdeteksi');
      if (!job) card.flags.push('Pekerjaan belum dipilih');
    }
    card.alerts = db.all('SELECT id, type, severity, message, created_at FROM alerts WHERE machine_id = ? AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 5', m.id);
    if (card.alerts.some((a) => a.type === 'STAMP_NO_SESSION')) card.flags.push('Stamping tanpa sesi operator');
    const faulty = Object.entries(devices).filter(([, d]) => d.status !== 'ok');
    card.has_fault = faulty.length > 0 || ['ESTOP', 'FAULT', 'POWER_OFF'].includes(physical);
    card.needs_review = card.flags.some((f) => ['Penyimpangan produksi', 'Stamping saat tidak terdeteksi', 'Stamping tanpa sesi operator', 'Belum logout', 'Logout gagal'].includes(f));
    card.status_group = card.has_fault ? 'fault' : card.session ? 'active' : 'idle';
    return card;
  }

  function overview({ machines } = {}) {
    const now = core.clock.now();
    let list = db.all('SELECT * FROM machines WHERE active = 1 ORDER BY number');
    if (machines) list = list.filter((m) => machines.includes(m.id));
    const cards = list.map((m) => machineCard(m, now));
    const summary = {
      total: cards.length,
      active: cards.filter((c) => c.session).length,
      idle: cards.filter((c) => !c.session).length,
      fault: cards.filter((c) => c.has_fault).length,
      review: cards.filter((c) => c.needs_review).length,
      absent_now: cards.filter((c) => c.presence.code === 'ABSENT').length,
      stamping_total: cards.reduce((a, c) => a + (c.session?.stamping.total || 0), 0),
    };
    return { now, simulation: core.simulation, summary, cards, shifts: core.shifts.instancesAround(now, { includeEarly: false }).map((i) => ({ shift_id: i.shift_id, name: i.name, start: i.start, end: i.end })) };
  }

  return { machineCard, overview, PHYSICAL_LABEL, PERMISSION_LABEL };
};
