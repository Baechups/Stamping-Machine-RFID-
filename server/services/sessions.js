'use strict';
/**
 * Sesi operator & izin operasional.
 *
 * Tiga status dipisahkan:
 *   - sessions.status            : status sesi operator
 *   - sessions.permission_status : izin operasional dari pengendali
 *   - machine_state.physical_state : status fisik mesin (hanya dari umpan balik PLC; default UNKNOWN)
 *
 * Status sesi:
 *   PENDING_PERMISSION → ACTIVE → LOGOUT_REQUESTED → CLOSED
 *   PENDING_PERMISSION → PERMISSION_FAILED (sesi berakhir, izin tidak diberikan)
 *   LOGOUT_REQUESTED → LOGOUT_FAILED (sesi tetap terbuka; perlu ulangi/supervisor)
 *   * → FORCE_CLOSED (tindakan supervisor dengan alasan)
 */
const T = require('../lib/time');
const { ACTIVE_SQL } = require('../db');

const STATUS_LABEL = {
  PENDING_PERMISSION: 'Menunggu izin pengendali', ACTIVE: 'Aktif', LOGOUT_REQUESTED: 'Menunggu penghentian aman',
  LOGOUT_FAILED: 'Logout gagal', CLOSED: 'Selesai', PERMISSION_FAILED: 'Izin gagal', FORCE_CLOSED: 'Ditutup supervisor',
};

module.exports = function sessionsService(core) {
  const { db } = core;

  const activeByMachine = (m) => db.get(`SELECT * FROM sessions WHERE machine_id = ? AND status IN ${ACTIVE_SQL}`, m);
  const activeByOperator = (o) => db.get(`SELECT * FROM sessions WHERE operator_id = ? AND status IN ${ACTIVE_SQL}`, o);
  const get = (id) => db.get('SELECT * FROM sessions WHERE id = ?', id);
  /** Sesi yang mencakup waktu t pada mesin (untuk atribusi kejadian yang datang terlambat). */
  const sessionAt = (machineId, t) => db.get(`SELECT * FROM sessions WHERE machine_id = ? AND login_at <= ?
    AND (logout_at IS NULL OR logout_at > ?) AND status NOT IN ('PERMISSION_FAILED') ORDER BY login_at DESC LIMIT 1`, machineId, t, t);

  function opName(id) { return db.get('SELECT name FROM operators WHERE id = ?', id)?.name || id; }

  function recordTap(ev, card, outcome, message, sessionId) {
    db.run(`INSERT INTO tap_events (event_id, machine_id, card_uid, operator_id, device_time, received_at, outcome, message, session_id, simulated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ev.eventId || null, ev.machineId, ev.uid, card?.operator_id || null, ev.deviceTime, ev.receivedAt,
      outcome, message, sessionId || null, ev.simulated ? 1 : 0);
  }

  /**
   * Memproses tap kartu RFID. Mengembalikan { outcome, message, level, sessionId }.
   * outcome: LOGIN_PENDING | LOGOUT_PENDING | REPERMIT_PENDING | IGNORED_* | REJECTED_*
   */
  function handleTap(ev) {
    const s = core.settings.all();
    const { machineId, uid } = ev;
    const t = ev.deviceTime;
    const res = db.tx(() => {
      const card = db.get('SELECT * FROM rfid_cards WHERE uid = ?', uid);
      const reply = (outcome, message, level, sessionId) => { recordTap(ev, card, outcome, message, sessionId); return { outcome, message, level, sessionId }; };

      // Tap yang tersimpan saat offline dan baru tersinkron tidak boleh memberi izin baru
      if (ev.buffered || ev.receivedAt - t > s.tap_max_age_s * 1000) {
        return reply('IGNORED_STALE', 'Tap tercatat saat koneksi terputus — tidak diproses. Silakan tap ulang.', 'warning');
      }
      const machine = db.get('SELECT * FROM machines WHERE id = ?', machineId);
      if (!machine || !machine.active) return reply('REJECTED_MACHINE', 'Mesin tidak aktif di sistem', 'error');
      if (!card) return reply('REJECTED_UNKNOWN_CARD', 'Kartu tidak dikenal. Hubungi supervisor.', 'error');
      if (card.status !== 'active' || !card.operator_id) return reply('REJECTED_INACTIVE_CARD', `Kartu ${card.status === 'lost' ? 'dilaporkan hilang' : 'nonaktif'}. Hubungi supervisor.`, 'error');
      const op = db.get('SELECT * FROM operators WHERE id = ?', card.operator_id);
      if (!op || op.status !== 'active') return reply('REJECTED_INACTIVE_OPERATOR', 'Status karyawan nonaktif. Hubungi supervisor.', 'error');

      // Debounce: tap kartu sama berulang dalam waktu singkat
      const lastTap = db.get(`SELECT device_time FROM tap_events WHERE machine_id = ? AND card_uid = ? AND outcome NOT LIKE 'IGNORED%' AND outcome NOT LIKE 'REJECTED%'
        ORDER BY device_time DESC LIMIT 1`, machineId, uid);
      if (lastTap && t - lastTap.device_time >= 0 && t - lastTap.device_time < s.tap_debounce_s * 1000) {
        return reply('IGNORED_DUPLICATE', 'Tap berulang diabaikan', 'info');
      }

      const current = activeByMachine(machineId);
      if (current) {
        if (current.operator_id !== op.id) {
          return reply('REJECTED_MACHINE_BUSY', `Mesin sedang digunakan oleh ${opName(current.operator_id)}. Pergantian operator memerlukan logout atau tindakan supervisor.`, 'error', current.id);
        }
        if (current.status === 'PENDING_PERMISSION' || current.status === 'LOGOUT_REQUESTED') {
          return reply('IGNORED_IN_PROGRESS', current.status === 'PENDING_PERMISSION' ? 'Permintaan izin sedang diproses' : 'Penghentian aman sedang diproses', 'info', current.id);
        }
        if (current.status === 'ACTIVE' && current.permission_status === 'SUSPENDED') {
          // Setelah listrik/koneksi pulih: izin diminta ulang secara eksplisit oleh operator
          db.run("UPDATE sessions SET permission_status = 'REQUESTED', status_message = ?, last_tap_at = ? WHERE id = ?", 'Meminta izin ulang ke pengendali', t, current.id);
          core.controller.send(machineId, current.id, 'GRANT_PERMISSION');
          core.audit({ label: op.name }, 'PERMISSION_REREQUEST', 'session', current.id, null, null, 'Tap operator setelah izin ditangguhkan');
          return reply('REPERMIT_PENDING', 'Meminta izin operasional ulang — menunggu konfirmasi pengendali…', 'pending', current.id);
        }
        if (t - current.login_at < s.min_session_before_logout_s * 1000) {
          return reply('IGNORED_TOO_SOON', 'Tap terlalu cepat setelah login — tidak dianggap logout', 'info', current.id);
        }
        requestLogout(current, { label: op.name }, 'Tap kartu operator', t);
        return reply('LOGOUT_PENDING', 'Logout diminta — menunggu konfirmasi kondisi aman dari pengendali…', 'pending', current.id);
      }

      const elsewhere = activeByOperator(op.id);
      if (elsewhere) return reply('REJECTED_OPERATOR_BUSY', `${op.name} masih memiliki sesi aktif di mesin ${elsewhere.machine_id}. Logout terlebih dahulu.`, 'error');

      const perm = db.get('SELECT 1 FROM operator_machine_permissions WHERE operator_id = ? AND machine_id = ?', op.id, machineId);
      if (!perm) return reply('REJECTED_NO_PERMISSION', `${op.name} tidak memiliki izin mengoperasikan mesin ${machineId}`, 'error');

      const devs = core.devices.byType(machineId);
      if (!devs.controller || devs.controller.status !== 'ok') {
        return reply('REJECTED_CONTROLLER', 'Pengendali mesin tidak terhubung — izin operasional tidak dapat diberikan', 'error');
      }
      const ms = db.get('SELECT power_state FROM machine_state WHERE machine_id = ?', machineId);
      if (ms?.power_state === 'OFF') return reply('REJECTED_POWER', 'Daya mesin padam — login tidak dapat diproses', 'error');

      const sh = core.shifts.resolveLoginShift(op.id, machineId, t);
      if (!sh.ok) return reply(`REJECTED_${sh.code}`, sh.reason, 'error');

      const id = core.uid();
      const inst = sh.instance;
      db.run(`INSERT INTO sessions (id, machine_id, operator_id, card_uid, shift_id, shift_date, shift_snapshot, login_at, status, permission_status,
        status_message, late_min, overtime_id, last_tap_at, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_PERMISSION', 'REQUESTED', ?, ?, ?, ?, ?)`,
      id, machineId, op.id, uid, inst.shift_id, inst.date, JSON.stringify(inst), t, 'Menunggu konfirmasi izin dari pengendali',
      sh.lateMin || 0, sh.overtime?.id || null, t, ev.simulated ? 1 : 0);
      core.controller.send(machineId, id, 'GRANT_PERMISSION');
      core.audit({ label: op.name }, 'SESSION_LOGIN_REQUEST', 'session', id, null, { machineId, operator: op.id, shift: inst.name, late_min: sh.lateMin }, null);
      if (sh.lateMin > 0) core.alerts.raise(machineId, 'LATE_LOGIN', 'info', `${op.name} login terlambat ${sh.lateMin} menit (${inst.name})`, id);
      return reply('LOGIN_PENDING', `Kartu valid: ${op.name}. Menunggu konfirmasi izin dari pengendali…`, 'pending', id);
    });
    core.setTerminal(machineId, res.message, res.level);
    if (res.sessionId && res.outcome.endsWith('PENDING')) core.presence.onSessionChange(machineId);
    core.changed(machineId);
    return res;
  }

  function requestLogout(session, actor, reason, at = core.clock.now()) {
    db.run("UPDATE sessions SET status = 'LOGOUT_REQUESTED', permission_status = 'REVOKE_REQUESTED', status_message = ?, last_tap_at = ? WHERE id = ?",
      `Logout diminta (${reason}) — menunggu konfirmasi kondisi aman`, at, session.id);
    core.controller.send(session.machine_id, session.id, 'REQUEST_STOP');
    core.audit(actor, 'SESSION_LOGOUT_REQUEST', 'session', session.id, { status: session.status }, { status: 'LOGOUT_REQUESTED' }, reason);
  }

  /** Menutup sesi: menutup pekerjaan & kejadian keberadaan yang terbuka, menyimpan ringkasan. */
  function closeSession(session, at, status, endReason, actor) {
    db.run("UPDATE session_jobs SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL", at, session.id);
    db.run(`UPDATE sessions SET status = ?, permission_status = ?, logout_at = ?, end_reason = ?, status_message = ?, closed_by = ? WHERE id = ?`,
      status, status === 'PERMISSION_FAILED' ? 'DENIED' : 'REVOKED', at, endReason, STATUS_LABEL[status], actor?.id ?? null, session.id);
    core.presence.onSessionClosed(session.machine_id, session.id, at);
    const fresh = get(session.id);
    if (status !== 'PERMISSION_FAILED') {
      const summary = core.reports.sessionMetrics(fresh);
      db.run('UPDATE sessions SET summary = ? WHERE id = ?', JSON.stringify(summary), session.id);
    }
    core.alerts.resolve(session.machine_id, 'NOT_LOGGED_OUT', session.id);
    core.alerts.resolve(session.machine_id, 'LOGOUT_FAILED', session.id);
    return get(session.id);
  }

  /** Hasil perintah dari pengendali (melalui perangkat lokal atau simulator). */
  function onCommandResult(cmdId, result) {
    const now = core.clock.now();
    let machineId;
    db.tx(() => {
      const cmd = db.get('SELECT * FROM controller_commands WHERE id = ?', cmdId);
      if (!cmd || ['ACKED', 'FAILED', 'TIMEOUT'].includes(cmd.status)) return; // idempoten
      machineId = cmd.machine_id;
      const ok = !!result.ok;
      db.run('UPDATE controller_commands SET status = ?, completed_at = ?, result = ?, error = ? WHERE id = ?',
        ok ? 'ACKED' : 'FAILED', now, JSON.stringify(result), ok ? null : (result.error || 'Ditolak pengendali'), cmdId);
      if (result.physical_state) core.devices.setPhysical(cmd.machine_id, result.physical_state, now);
      applyCommandOutcome(cmd, ok, ok ? null : (result.error || 'Ditolak pengendali'), result, now);
    });
    if (machineId) { core.presence.onSessionChange(machineId); core.changed(machineId); }
  }

  function applyCommandOutcome(cmd, ok, error, result, now) {
    const session = cmd.session_id ? get(cmd.session_id) : null;
    const m = cmd.machine_id;
    if (cmd.type === 'GRANT_PERMISSION') {
      if (!session || !['PENDING_PERMISSION', 'ACTIVE'].includes(session.status) || session.permission_status !== 'REQUESTED') return;
      const name = opName(session.operator_id);
      if (ok) {
        db.run("UPDATE sessions SET status = 'ACTIVE', permission_status = 'GRANTED', status_message = ? WHERE id = ?", 'Izin operasional aktif', session.id);
        core.setTerminal(m, `Login berhasil — operator aktif: ${name}. Mesin diizinkan beroperasi; jalankan dengan tombol Start sesuai prosedur keselamatan.`, 'success');
        core.audit({ label: `pengendali:${m}` }, 'PERMISSION_GRANTED', 'session', session.id);
      } else if (session.status === 'PENDING_PERMISSION') {
        closeSession(session, now, 'PERMISSION_FAILED', `Izin operasional gagal: ${error}`);
        core.setTerminal(m, `Login gagal — izin operasional tidak dikonfirmasi pengendali (${error}). Mesin tidak diizinkan beroperasi. Hubungi teknisi/supervisor.`, 'error');
        core.alerts.raise(m, 'PERMISSION_FAILED', 'warning', `Izin operasional gagal untuk ${name}: ${error}`, session.id, false);
        core.audit({ label: `pengendali:${m}` }, 'PERMISSION_FAILED', 'session', session.id, null, null, error);
      } else {
        db.run("UPDATE sessions SET permission_status = 'SUSPENDED', status_message = ? WHERE id = ?", `Izin ulang gagal: ${error}`, session.id);
        core.setTerminal(m, `Izin ulang gagal (${error}). Tap ulang kartu atau hubungi supervisor.`, 'error');
      }
    } else if (cmd.type === 'REQUEST_STOP') {
      if (!session || !['LOGOUT_REQUESTED', 'LOGOUT_FAILED'].includes(session.status)) return;
      // Sesi ditutup hanya jika pengendali mengonfirmasi kondisi aman
      const safe = ok && result?.safe_state !== false && ['STOPPED', 'IDLE', 'SAFE'].includes(result?.physical_state || 'STOPPED');
      if (safe) {
        const closed = closeSession(session, now, 'CLOSED', session.end_reason || 'Logout operator');
        const sum = JSON.parse(closed.summary || '{}');
        core.setTerminal(m, `Logout berhasil — ${opName(session.operator_id)}. Ringkasan: durasi ${T.fmtDuration(sum.duration_ms)}, stamping ${sum.stamping?.total ?? 0} siklus, tidak terdeteksi ${T.fmtDuration(sum.absent_ms)}.`, 'success');
        core.audit({ label: `pengendali:${m}` }, 'SESSION_CLOSED', 'session', session.id, null, sum);
      } else {
        const reason = error || 'Kondisi aman belum dikonfirmasi';
        db.run("UPDATE sessions SET status = 'LOGOUT_FAILED', permission_status = 'GRANTED', status_message = ? WHERE id = ?", `Logout gagal: ${reason}`, session.id);
        core.setTerminal(m, `Logout gagal — ${reason}. Sesi masih terbuka. Tap ulang kartu atau hubungi supervisor.`, 'error');
        core.alerts.raise(m, 'LOGOUT_FAILED', 'critical', `Logout ${opName(session.operator_id)} gagal: ${reason}`, session.id);
        core.audit({ label: `pengendali:${m}` }, 'LOGOUT_FAILED', 'session', session.id, null, null, reason);
      }
    }
  }

  function checkCommandTimeouts(now) {
    const timeout = core.settings.get('command_timeout_s') * 1000;
    const rows = db.all("SELECT * FROM controller_commands WHERE status IN ('PENDING','SENT') AND created_at < ?", now - timeout);
    for (const cmd of rows) {
      db.tx(() => {
        db.run("UPDATE controller_commands SET status = 'TIMEOUT', completed_at = ?, error = 'Tidak ada respons pengendali' WHERE id = ?", now, cmd.id);
        applyCommandOutcome(cmd, false, 'tidak ada respons pengendali (timeout)', null, now);
      });
      core.presence.onSessionChange(cmd.machine_id);
      core.changed(cmd.machine_id);
    }
  }

  function failPendingCommandsOnStartup() {
    const now = core.clock.now();
    for (const cmd of db.all("SELECT * FROM controller_commands WHERE status IN ('PENDING','SENT')")) {
      db.tx(() => {
        db.run("UPDATE controller_commands SET status = 'TIMEOUT', completed_at = ?, error = 'Server dimulai ulang sebelum respons' WHERE id = ?", now, cmd.id);
        applyCommandOutcome(cmd, false, 'server dimulai ulang sebelum konfirmasi', null, now);
      });
    }
  }

  /** Shift berakhir tetapi belum logout → peringatan saja, mesin tidak dihentikan. */
  function checkShiftEnd(now) {
    const rows = db.all(`SELECT * FROM sessions WHERE status IN ${ACTIVE_SQL} AND not_logged_out = 0`);
    for (const s of rows) {
      const snap = JSON.parse(s.shift_snapshot || '{}');
      if (!snap.end) continue;
      if (now > snap.end + (snap.logout_grace_min || 0) * 60000) {
        db.run('UPDATE sessions SET not_logged_out = 1 WHERE id = ?', s.id);
        core.alerts.raise(s.machine_id, 'NOT_LOGGED_OUT', 'warning', `Belum logout: ${opName(s.operator_id)} di ${s.machine_id} (${snap.name} berakhir ${T.timeStr(snap.end, false)})`, s.id);
        core.setTerminal(s.machine_id, `Belum logout — ${snap.name} telah berakhir pukul ${T.timeStr(snap.end, false)}. Lakukan logout atau hubungi supervisor.`, 'warning');
        core.changed(s.machine_id);
      }
    }
  }

  // ---------- Tindakan supervisor ----------
  function assertReason(reason) { if (!reason || String(reason).trim().length < 5) { const e = new Error('Alasan wajib diisi (minimal 5 karakter)'); e.status = 400; throw e; } }

  function supervisorLogout(sessionId, actor, reason) {
    assertReason(reason);
    const s = get(sessionId);
    if (!s || !['ACTIVE', 'LOGOUT_FAILED'].includes(s.status)) { const e = new Error('Sesi tidak dalam status yang dapat di-logout'); e.status = 409; throw e; }
    db.tx(() => {
      db.run('UPDATE sessions SET end_reason = ? WHERE id = ?', `Logout oleh supervisor: ${reason}`, s.id);
      requestLogout(s, actor, `Supervisor: ${reason}`);
    });
    core.setTerminal(s.machine_id, 'Supervisor meminta logout — menunggu konfirmasi kondisi aman…', 'pending');
    core.changed(s.machine_id);
  }

  /** Penutupan paksa: hanya jika supervisor memeriksa kondisi aman secara langsung. */
  function forceClose(sessionId, actor, reason, safetyConfirmed) {
    assertReason(reason);
    if (!safetyConfirmed) { const e = new Error('Supervisor wajib mengonfirmasi kondisi mesin aman (diperiksa langsung)'); e.status = 400; throw e; }
    const s = get(sessionId);
    if (!s || !['PENDING_PERMISSION', 'ACTIVE', 'LOGOUT_REQUESTED', 'LOGOUT_FAILED'].includes(s.status)) { const e = new Error('Sesi sudah ditutup'); e.status = 409; throw e; }
    const now = core.clock.now();
    db.tx(() => {
      core.controller.send(s.machine_id, null, 'REVOKE_PERMISSION');
      closeSession(s, now, 'FORCE_CLOSED', `Ditutup supervisor: ${reason}`, actor);
      core.audit(actor, 'SESSION_FORCE_CLOSE', 'session', s.id, { status: s.status }, { status: 'FORCE_CLOSED' }, `${reason} (kondisi aman dikonfirmasi supervisor)`);
    });
    core.setTerminal(s.machine_id, 'Sesi ditutup oleh supervisor. Tidak ada operator aktif.', 'warning');
    core.presence.onSessionChange(s.machine_id);
    core.changed(s.machine_id);
  }

  /**
   * Pergantian shift untuk operator yang sama yang melanjutkan kerja (mis. lembur disetujui):
   * sesi lama ditutup pada batas waktu, sesi baru dibuat untuk shift berikutnya. Izin operasional
   * dilanjutkan tanpa menghentikan mesin, dan seluruh langkah tercatat di audit log.
   */
  function shiftHandover(sessionId, actor, reason) {
    assertReason(reason);
    const s = get(sessionId);
    if (!s || s.status !== 'ACTIVE' || s.permission_status !== 'GRANTED') { const e = new Error('Hanya sesi aktif dengan izin aktif yang dapat dipindahkan ke shift berikutnya'); e.status = 409; throw e; }
    const now = core.clock.now();
    const sh = core.shifts.resolveLoginShift(s.operator_id, s.machine_id, now);
    if (!sh.ok) { const e = new Error(`Shift berikutnya tidak valid untuk operator: ${sh.reason}`); e.status = 409; throw e; }
    if (sh.instance.shift_id === s.shift_id && sh.instance.date === s.shift_date) { const e = new Error('Operator masih berada pada shift yang sama'); e.status = 409; throw e; }
    let newId;
    db.tx(() => {
      const jobs = db.all('SELECT * FROM session_jobs WHERE session_id = ? AND ended_at IS NULL', s.id);
      closeSession(s, now, 'CLOSED', `Pergantian shift: ${reason}`, actor);
      newId = core.uid();
      const inst = sh.instance;
      db.run(`INSERT INTO sessions (id, machine_id, operator_id, card_uid, shift_id, shift_date, shift_snapshot, login_at, status, permission_status, status_message, overtime_id, handover_from, simulated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'GRANTED', ?, ?, ?, ?)`, newId, s.machine_id, s.operator_id, s.card_uid, inst.shift_id, inst.date, JSON.stringify(inst), now,
      `Dilanjutkan dari sesi sebelumnya (${inst.name})`, sh.overtime?.id || null, s.id, s.simulated);
      for (const j of jobs) {
        db.run(`INSERT INTO session_jobs (session_id, machine_id, operator_id, work_order_id, product_id, stage_id, category, started_at, standard_id, standard_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId, j.machine_id, j.operator_id, j.work_order_id, j.product_id, j.stage_id, j.category, now, j.standard_id, j.standard_snapshot);
      }
      core.audit(actor, 'SESSION_SHIFT_HANDOVER', 'session', newId, { session: s.id, shift: s.shift_id }, { session: newId, shift: inst.shift_id }, reason);
    });
    core.setTerminal(s.machine_id, `Pergantian shift tercatat — operator aktif: ${opName(s.operator_id)} (${sh.instance.name})`, 'success');
    core.presence.onSessionChange(s.machine_id);
    core.changed(s.machine_id);
    return get(newId);
  }

  /** Pilih / ganti pekerjaan. Pergantian menutup pekerjaan lama sehingga pencatatan terpisah. */
  function selectJob(sessionId, { work_order_id, category = 'normal' }, actor) {
    const s = get(sessionId);
    if (!s || !['ACTIVE', 'PENDING_PERMISSION', 'LOGOUT_FAILED'].includes(s.status)) { const e = new Error('Tidak ada sesi aktif'); e.status = 409; throw e; }
    if (!['normal', 'setup', 'trial', 'rework'].includes(category)) { const e = new Error('Kategori tidak valid'); e.status = 400; throw e; }
    const wo = db.get('SELECT * FROM work_orders WHERE id = ?', work_order_id);
    if (!wo || wo.status !== 'open') { const e = new Error('Work order tidak ditemukan atau sudah ditutup'); e.status = 400; throw e; }
    const now = core.clock.now();
    const cur = db.get('SELECT * FROM session_jobs WHERE session_id = ? AND ended_at IS NULL', s.id);
    if (cur && cur.work_order_id === wo.id && cur.category === category) return cur;
    const std = core.production.standardFor(wo.product_id, wo.stage_id, now);
    let id;
    db.tx(() => {
      if (cur) db.run('UPDATE session_jobs SET ended_at = ? WHERE id = ?', now, cur.id);
      const r = db.run(`INSERT INTO session_jobs (session_id, machine_id, operator_id, work_order_id, product_id, stage_id, category, started_at, standard_id, standard_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, s.id, s.machine_id, s.operator_id, wo.id, wo.product_id, wo.stage_id, category, now, std?.id || null, std ? JSON.stringify(std) : null);
      id = Number(r.lastInsertRowid);
      core.audit(actor, cur ? 'JOB_CHANGE' : 'JOB_SELECT', 'session_job', id, cur ? { work_order: cur.work_order_id, category: cur.category } : null, { work_order: wo.id, category });
    });
    core.changed(s.machine_id);
    return db.get('SELECT * FROM session_jobs WHERE id = ?', id);
  }

  // ---------- Daya ----------
  function powerLost(machineId, at) {
    db.run("UPDATE machine_state SET power_state = 'OFF' WHERE machine_id = ?", machineId);
    core.devices.setPhysical(machineId, 'POWER_OFF', at);
    const s = activeByMachine(machineId);
    if (s && s.permission_status === 'GRANTED') {
      db.run("UPDATE sessions SET permission_status = 'SUSPENDED', status_message = ? WHERE id = ?", 'Izin ditangguhkan: daya padam', s.id);
    }
    core.alerts.raise(machineId, 'POWER', 'critical', `Daya mesin ${machineId} padam`);
    core.audit({ label: `perangkat:${machineId}` }, 'POWER_LOST', 'machine', machineId);
  }
  /** Listrik pulih: TIDAK ada restart otomatis maupun pemberian izin otomatis. */
  function powerRestored(machineId, at, physical) {
    db.run("UPDATE machine_state SET power_state = 'ON' WHERE machine_id = ?", machineId);
    core.devices.setPhysical(machineId, physical || 'STOPPED', at);
    core.alerts.resolve(machineId, 'POWER');
    const s = activeByMachine(machineId);
    if (s && s.permission_status === 'GRANTED') db.run("UPDATE sessions SET permission_status = 'SUSPENDED', status_message = ? WHERE id = ?", 'Izin ditangguhkan: daya baru pulih', s.id);
    if (s) core.setTerminal(machineId, 'Listrik pulih. Mesin TIDAK dijalankan otomatis. Tap kartu Anda untuk meminta izin operasional ulang, lalu jalankan sesuai prosedur.', 'warning');
    core.audit({ label: `perangkat:${machineId}` }, 'POWER_RESTORED', 'machine', machineId, null, { auto_restart: false });
  }

  return {
    STATUS_LABEL, activeByMachine, activeByOperator, get, sessionAt, handleTap, requestLogout, onCommandResult, checkCommandTimeouts,
    failPendingCommandsOnStartup, checkShiftEnd, supervisorLogout, forceClose, shiftHandover, selectJob, powerLost, powerRestored, closeSession,
  };
};
