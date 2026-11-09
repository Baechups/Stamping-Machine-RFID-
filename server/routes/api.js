'use strict';
/** REST API. Hak akses: admin, supervisor (dibatasi mesin kewenangannya), operator (melalui terminal + RFID). */
const express = require('express');
const crypto = require('node:crypto');
const T = require('../lib/time');
const { verifyPassword, hashPassword } = require('../seed');
const { ACTIVE_SQL } = require('../db');

module.exports = function api(core, sim) {
  const r = express.Router();
  const { db } = core;
  const wrap = (fn) => (req, res) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.then((v) => { if (!res.headersSent) res.json(v ?? { ok: true }); }).catch((e) => fail(res, e));
      else if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) { fail(res, e); }
  };
  const fail = (res, e) => {
    if (!e.status) console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Terjadi kesalahan server: ' + e.message });
  };
  const err = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  const actorOf = (req) => (req.user ? { id: req.user.id, name: `${req.user.name} (${req.user.role})` } : { label: 'anonim' });

  // ---------- Autentikasi ----------
  function parseCookies(h) { return Object.fromEntries(String(h || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
  function auth(req, _res, next) {
    const token = parseCookies(req.headers.cookie).sm_token || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (token) {
      const row = db.get('SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.expires_at > ? AND u.active = 1', token, Date.now());
      if (row) req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
    }
    next();
  }
  r.use(auth);
  const need = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Silakan login' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Akses ditolak untuk peran Anda' });
    next();
  };
  const scope = (req) => {
    if (!req.user || req.user.role === 'admin') return null;
    const rows = db.all('SELECT machine_id FROM supervisor_machines WHERE user_id = ?', req.user.id);
    return rows.length ? rows.map((x) => x.machine_id) : null;
  };
  const assertMachine = (req, m) => { const sc = scope(req); if (sc && !sc.includes(m)) throw err(403, `Mesin ${m} di luar kewenangan Anda`); };

  const loginAttempts = new Map();
  r.post('/auth/login', wrap((req, res) => {
    const { username, password } = req.body || {};
    const key = `${req.ip}|${username}`;
    const att = loginAttempts.get(key) || { n: 0, until: 0 };
    if (att.until > Date.now()) throw err(429, 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.');
    const u = db.get('SELECT * FROM users WHERE username = ? AND active = 1', String(username || ''));
    if (!u || !verifyPassword(String(password || ''), u.password_hash)) {
      att.n += 1; if (att.n >= 5) { att.until = Date.now() + 5 * 60000; att.n = 0; }
      loginAttempts.set(key, att);
      core.audit({ label: String(username || '?') }, 'USER_LOGIN_FAILED', 'user', username, null, null, null, req.ip);
      throw err(401, 'Nama pengguna atau kata sandi salah');
    }
    loginAttempts.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.run('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', token, u.id, Date.now(), Date.now() + 12 * 3600e3);
    res.setHeader('Set-Cookie', `sm_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    core.audit({ id: u.id, name: u.name }, 'USER_LOGIN', 'user', u.id, null, null, null, req.ip);
    return { user: { id: u.id, username: u.username, name: u.name, role: u.role } };
  }));
  r.post('/auth/logout', wrap((req, res) => {
    const token = parseCookies(req.headers.cookie).sm_token;
    if (token) db.run('DELETE FROM auth_tokens WHERE token = ?', token);
    if (req.user) core.audit(actorOf(req), 'USER_LOGOUT', 'user', req.user.id);
    res.setHeader('Set-Cookie', 'sm_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  }));
  r.get('/auth/me', wrap((req) => ({ user: req.user || null, scope: scope(req) })));

  r.get('/public/info', wrap(() => {
    const s = core.settings.all();
    return { plant_name: s.plant_name, simulation: core.simulation, monitoring_notice: s.monitoring_notice, record_video: s.record_video, now: core.clock.now(), tz: T.TZ };
  }));

  // ---------- Perangkat lokal (edge) ----------
  function edgeAuth(req) {
    const key = req.headers['x-device-key'];
    const dev = key && db.get("SELECT * FROM devices WHERE type = 'edge' AND api_key = ?", key);
    if (!dev) throw err(401, 'Kunci perangkat tidak valid');
    return dev;
  }
  r.post('/edge/events', wrap((req) => {
    const dev = edgeAuth(req);
    const events = Array.isArray(req.body) ? req.body : req.body.events;
    if (!Array.isArray(events) || events.length > 5000) throw err(400, 'events harus array (maks 5000)');
    for (const e of events) if (e.machine_id !== dev.machine_id) throw err(403, 'Perangkat hanya boleh mengirim kejadian mesinnya sendiri');
    return { results: core.ingest.ingest(events.map((e) => ({ ...e, simulated: false }))), server_time: core.clock.now() };
  }));
  r.get('/edge/commands', wrap((req) => {
    const dev = edgeAuth(req);
    return { commands: core.controller.pending(dev.machine_id), server_time: core.clock.now() };
  }));

  // ---------- Terminal operator ----------
  function terminalAuth(req, m) {
    if (core.simulation || req.user) return;
    const key = req.query.key || req.headers['x-terminal-key'];
    const dev = db.get("SELECT * FROM devices WHERE type = 'terminal' AND machine_id = ? AND api_key = ?", m, key || '');
    if (!dev) throw err(401, 'Terminal tidak terotorisasi');
  }
  r.get('/terminal/:m', wrap((req) => {
    const m = req.params.m;
    terminalAuth(req, m);
    const machine = db.get('SELECT * FROM machines WHERE id = ?', m);
    if (!machine) throw err(404, 'Mesin tidak ditemukan');
    const card = core.dashboard.machineCard(machine);
    const s = card.session;
    const settings = core.settings.all();
    let jobs = [], results = [], canEnter = false;
    if (s) {
      jobs = db.all(`SELECT j.*, p.name AS product_name, ps.name AS stage_name FROM session_jobs j LEFT JOIN products p ON p.id = j.product_id LEFT JOIN process_stages ps ON ps.id = j.stage_id
        WHERE j.session_id = ? ORDER BY j.started_at`, s.id).map((j) => ({ ...j, cycles: core.production.jobCycles(j.id), result: db.get('SELECT * FROM production_results WHERE job_id = ?', j.id) }));
      const op = db.get('SELECT can_enter_results FROM operators WHERE id = ?', s.operator_id);
      canEnter = !!settings.operator_can_enter_results && !!op?.can_enter_results;
    }
    const lastSummary = !s ? db.get("SELECT s.summary, s.logout_at, o.name FROM sessions s JOIN operators o ON o.id = s.operator_id WHERE s.machine_id = ? AND s.status IN ('CLOSED','FORCE_CLOSED') ORDER BY s.logout_at DESC LIMIT 1", m) : null;
    const camCfg = db.get('SELECT roi, enabled FROM camera_config WHERE machine_id = ?', m);
    const camP = core.presence.params(m);
    return {
      card, jobs, can_enter_results: canEnter,
      // Parameter deteksi efektif (konfigurasi kamera atau pengaturan global) untuk analitik kamera / demo
      camera: {
        roi: camCfg ? JSON.parse(camCfg.roi) : null, enabled: !!camCfg?.enabled,
        absence_threshold_s: camP.threshold / 1000, return_confirm_s: camP.confirm / 1000,
        min_confidence: camP.minConfidence, min_quality: camP.minQuality, min_roi_overlap: camP.minRoi,
      },
      presence_events: s ? db.all(`SELECT id, kind, start_at, end_at, duration_ms, classification, corrected_classification, cause
        FROM presence_events WHERE session_id = ? ORDER BY start_at DESC LIMIT 8`, s.id) : [],
      work_orders: db.all("SELECT w.id, w.product_id, p.name AS product_name, ps.name AS stage_name FROM work_orders w JOIN products p ON p.id = w.product_id LEFT JOIN process_stages ps ON ps.id = w.stage_id WHERE w.status = 'open' ORDER BY w.id"),
      last_summary: lastSummary && lastSummary.logout_at > core.clock.now() - 120000 ? { ...JSON.parse(lastSummary.summary || '{}'), operator_name: lastSummary.name, logout_at: lastSummary.logout_at } : null,
      monitoring_notice: settings.monitoring_notice, simulation: core.simulation, sim: sim ? sim.stateOf(m) : null, now: core.clock.now(),
    };
  }));
  function terminalSession(m) {
    const s = core.sessions.activeByMachine(m);
    if (!s || !['ACTIVE', 'LOGOUT_FAILED'].includes(s.status)) throw err(409, 'Tidak ada operator aktif pada mesin ini');
    return s;
  }
  r.post('/terminal/:m/job', wrap((req) => {
    terminalAuth(req, req.params.m);
    const s = terminalSession(req.params.m);
    const op = db.get('SELECT name FROM operators WHERE id = ?', s.operator_id);
    return core.sessions.selectJob(s.id, req.body, { label: `${op.name} (operator, terminal ${req.params.m})` });
  }));
  r.post('/terminal/:m/result', wrap((req) => {
    terminalAuth(req, req.params.m);
    const s = terminalSession(req.params.m);
    const settings = core.settings.all();
    const op = db.get('SELECT * FROM operators WHERE id = ?', s.operator_id);
    if (!settings.operator_can_enter_results || !op.can_enter_results) throw err(403, 'Operator tidak diizinkan mencatat hasil produksi');
    const job = db.get('SELECT * FROM session_jobs WHERE id = ? AND session_id = ?', req.body.job_id, s.id);
    if (!job) throw err(404, 'Pekerjaan tidak termasuk sesi aktif');
    return core.production.saveResult(job.id, req.body, { label: `${op.name} (operator)` }, { source: 'operator', reason: req.body.reason });
  }));

  // ---------- Simulasi ----------
  if (sim) {
    r.get('/sim/cards', wrap(() => sim.cards()));
    r.get('/sim/scenario', wrap(() => sim.scenario()));
    r.post('/sim/scenario/start', wrap(async (req) => { if (!req.user && !core.simulation) throw err(401, 'Login'); return sim.runScenario(); }));
    r.post('/sim/scenario/stop', wrap(() => sim.stopScenario()));
    r.get('/sim/:m', wrap((req) => sim.stateOf(req.params.m)));
    r.post('/sim/:m/:action', wrap((req) => sim.act(req.params.m, req.params.action, req.body || {})));
  }

  // ===== Mulai dari sini memerlukan login admin/supervisor =====
  const staff = need('admin', 'supervisor');
  const admin = need('admin');

  r.get('/dashboard', staff, wrap((req) => core.dashboard.overview({ machines: scope(req) })));

  r.get('/stream', staff, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const sc = scope(req);
    let pending = new Set(); let t = null;
    const onChange = (m) => {
      if (sc && !sc.includes(m)) return;
      pending.add(m);
      if (!t) t = setTimeout(() => { res.write(`event: machines\ndata: ${JSON.stringify([...pending])}\n\n`); pending = new Set(); t = null; }, 500);
    };
    core.bus.on('machine-changed', onChange);
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { core.bus.off('machine-changed', onChange); clearInterval(ka); if (t) clearTimeout(t); });
  });

  r.get('/machines', staff, wrap((req) => {
    const sc = scope(req);
    return db.all('SELECT * FROM machines ORDER BY number').filter((m) => !sc || sc.includes(m.id));
  }));
  r.put('/machines/:id', admin, wrap((req) => {
    const before = db.get('SELECT * FROM machines WHERE id = ?', req.params.id);
    if (!before) throw err(404, 'Mesin tidak ditemukan');
    const { name = before.name, area = before.area, active = before.active, notes = before.notes } = req.body;
    db.run('UPDATE machines SET name = ?, area = ?, active = ?, notes = ? WHERE id = ?', name, area, active ? 1 : 0, notes, before.id);
    core.audit(actorOf(req), 'MACHINE_UPDATE', 'machine', before.id, before, req.body);
    return db.get('SELECT * FROM machines WHERE id = ?', before.id);
  }));
  r.get('/machines/:id', staff, wrap((req) => {
    const m = db.get('SELECT * FROM machines WHERE id = ?', req.params.id);
    if (!m) throw err(404, 'Mesin tidak ditemukan');
    assertMachine(req, m.id);
    const now = core.clock.now();
    const card = core.dashboard.machineCard(m, now);
    const sessions = core.reports.sessionReport({ machine_id: m.id, from: now - 3 * T.DAY, limit: 30 });
    const jobs = card.session ? db.all(`SELECT j.*, p.name AS product_name, ps.name AS stage_name FROM session_jobs j LEFT JOIN products p ON p.id = j.product_id
      LEFT JOIN process_stages ps ON ps.id = j.stage_id WHERE j.session_id = ? ORDER BY j.started_at`, card.session.id).map((j) => core.production.analyzeJob(j)) : [];
    return {
      card, sessions, jobs,
      hourly: core.reports.hourly({ machine_id: m.id, from: T.hourFloor(now) - 11 * T.HOUR, to: now + 1 }),
      devices: core.devices.list(m.id).map((d) => ({ ...d, api_key: undefined })),
      anomalies: db.all('SELECT * FROM counter_anomalies WHERE machine_id = ? ORDER BY at DESC LIMIT 30', m.id),
      taps: db.all('SELECT * FROM tap_events WHERE machine_id = ? ORDER BY device_time DESC LIMIT 30', m.id),
      commands: db.all('SELECT * FROM controller_commands WHERE machine_id = ? ORDER BY created_at DESC LIMIT 15', m.id),
      leaves: card.session ? db.all("SELECT * FROM leave_permits WHERE operator_id = ? AND status = 'active' AND end_at > ? ORDER BY start_at", card.session.operator_id, now - T.DAY) : [],
      work_orders: db.all("SELECT w.id, p.name AS product_name FROM work_orders w JOIN products p ON p.id = w.product_id WHERE w.status = 'open' ORDER BY w.id"),
      sim: sim ? sim.stateOf(m.id) : null,
    };
  }));

  // ---------- Sesi & tindakan supervisor ----------
  const sessionGuard = (req) => { const s = core.sessions.get(req.params.id); if (!s) throw err(404, 'Sesi tidak ditemukan'); assertMachine(req, s.machine_id); return s; };
  r.get('/sessions/:id/timeline', staff, wrap((req) => { sessionGuard(req); return core.reports.timeline(req.params.id); }));
  r.post('/sessions/:id/logout', staff, wrap((req) => { sessionGuard(req); core.sessions.supervisorLogout(req.params.id, actorOf(req), req.body.reason); }));
  r.post('/sessions/:id/force-close', staff, wrap((req) => { sessionGuard(req); core.sessions.forceClose(req.params.id, actorOf(req), req.body.reason, !!req.body.safety_confirmed); }));
  r.post('/sessions/:id/handover', staff, wrap((req) => { sessionGuard(req); return core.sessions.shiftHandover(req.params.id, actorOf(req), req.body.reason); }));
  r.post('/sessions/:id/job', staff, wrap((req) => { sessionGuard(req); return core.sessions.selectJob(req.params.id, req.body, actorOf(req)); }));

  r.post('/leave', staff, wrap((req) => {
    const { operator_id, session_id, start_at, end_at, reason } = req.body;
    const start = Number(start_at), end = Number(end_at);
    if (!operator_id || !(end > start)) throw err(400, 'Operator dan rentang waktu izin wajib valid');
    if (!reason || reason.trim().length < 5) throw err(400, 'Alasan izin wajib diisi');
    if (session_id) sessionGuard({ ...req, params: { id: session_id } });
    const x = db.run('INSERT INTO leave_permits (operator_id, session_id, start_at, end_at, reason, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', operator_id, session_id || null, start, end, reason, req.user.id, Date.now());
    core.audit(actorOf(req), 'LEAVE_APPROVED', 'leave_permit', Number(x.lastInsertRowid), null, { operator_id, start, end }, reason);
    const s = session_id && core.sessions.get(session_id); if (s) core.changed(s.machine_id);
    return { id: Number(x.lastInsertRowid) };
  }));
  r.post('/leave/:id/cancel', staff, wrap((req) => {
    db.run("UPDATE leave_permits SET status = 'cancelled' WHERE id = ?", req.params.id);
    core.audit(actorOf(req), 'LEAVE_CANCELLED', 'leave_permit', req.params.id, null, null, req.body.reason);
  }));

  r.post('/presence/:id/correct', staff, wrap((req) => {
    const ev = db.get('SELECT machine_id FROM presence_events WHERE id = ?', req.params.id); if (!ev) throw err(404, 'Kejadian tidak ditemukan'); assertMachine(req, ev.machine_id);
    return core.presence.correct(Number(req.params.id), req.body.classification, req.body.reason, actorOf(req));
  }));
  r.post('/presence/:id/verify', staff, wrap((req) => {
    const ev = db.get('SELECT machine_id FROM presence_events WHERE id = ?', req.params.id); if (!ev) throw err(404, 'Kejadian tidak ditemukan'); assertMachine(req, ev.machine_id);
    core.presence.verify(Number(req.params.id), actorOf(req), req.body.note);
  }));
  r.get('/presence/:id/corrections', staff, wrap((req) => db.all('SELECT c.*, u.name AS user_name FROM presence_corrections c LEFT JOIN users u ON u.id = c.user_id WHERE presence_event_id = ? ORDER BY at', req.params.id)));

  // ---------- Operator & RFID ----------
  r.get('/operators', staff, wrap(() => db.all(`SELECT o.*, (SELECT GROUP_CONCAT(uid || ':' || status) FROM rfid_cards c WHERE c.operator_id = o.id) AS cards,
    (SELECT COUNT(*) FROM operator_machine_permissions p WHERE p.operator_id = o.id) AS machine_count,
    (SELECT machine_id FROM sessions s WHERE s.operator_id = o.id AND s.status IN ${ACTIVE_SQL}) AS active_machine FROM operators o ORDER BY o.id`)));
  r.get('/operators/:id', staff, wrap((req) => {
    const o = db.get('SELECT * FROM operators WHERE id = ?', req.params.id); if (!o) throw err(404, 'Operator tidak ditemukan');
    return { ...o, cards: db.all('SELECT * FROM rfid_cards WHERE operator_id = ?', o.id), machines: db.all('SELECT machine_id FROM operator_machine_permissions WHERE operator_id = ?', o.id).map((x) => x.machine_id),
      assignments: db.all('SELECT a.*, s.name AS shift_name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.operator_id = ? AND a.active = 1', o.id) };
  }));
  r.post('/operators', admin, wrap((req) => {
    const { id, employee_no, name, department, photo_url, can_enter_results = 1 } = req.body;
    if (!id || !employee_no || !name) throw err(400, 'ID, nomor karyawan, dan nama wajib diisi');
    if (db.get('SELECT 1 FROM operators WHERE id = ? OR employee_no = ?', id, employee_no)) throw err(409, 'ID atau nomor karyawan sudah digunakan');
    db.run('INSERT INTO operators (id, employee_no, name, department, photo_url, can_enter_results, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, employee_no, name, department || null, photo_url || null, can_enter_results ? 1 : 0, Date.now());
    core.audit(actorOf(req), 'OPERATOR_CREATE', 'operator', id, null, req.body);
    return db.get('SELECT * FROM operators WHERE id = ?', id);
  }));
  r.put('/operators/:id', admin, wrap((req) => {
    const b = db.get('SELECT * FROM operators WHERE id = ?', req.params.id); if (!b) throw err(404, 'Operator tidak ditemukan');
    const d = { ...b, ...req.body };
    if (!['active', 'inactive'].includes(d.status)) throw err(400, 'Status tidak valid');
    db.run('UPDATE operators SET name = ?, department = ?, photo_url = ?, status = ?, can_enter_results = ? WHERE id = ?', d.name, d.department, d.photo_url || null, d.status, d.can_enter_results ? 1 : 0, b.id);
    if (Array.isArray(req.body.machines)) {
      db.run('DELETE FROM operator_machine_permissions WHERE operator_id = ?', b.id);
      for (const m of req.body.machines) db.run('INSERT OR IGNORE INTO operator_machine_permissions (operator_id, machine_id) VALUES (?, ?)', b.id, m);
    }
    core.audit(actorOf(req), 'OPERATOR_UPDATE', 'operator', b.id, b, req.body);
    return db.get('SELECT * FROM operators WHERE id = ?', b.id);
  }));
  r.post('/cards', admin, wrap((req) => {
    const uid = String(req.body.uid || '').trim().toUpperCase();
    if (!/^[0-9A-F]{4,32}$/.test(uid)) throw err(400, 'UID kartu harus heksadesimal 4–32 karakter');
    if (db.get('SELECT 1 FROM rfid_cards WHERE uid = ?', uid)) throw err(409, 'UID kartu sudah terdaftar');
    if (!db.get('SELECT 1 FROM operators WHERE id = ?', req.body.operator_id)) throw err(400, 'Operator tidak ditemukan');
    db.run("INSERT INTO rfid_cards (uid, operator_id, status, issued_at, note) VALUES (?, ?, 'active', ?, ?)", uid, req.body.operator_id, Date.now(), req.body.note || null);
    core.audit(actorOf(req), 'CARD_ISSUE', 'rfid_card', uid, null, { operator_id: req.body.operator_id });
    return db.get('SELECT * FROM rfid_cards WHERE uid = ?', uid);
  }));
  r.put('/cards/:uid', admin, wrap((req) => {
    const b = db.get('SELECT * FROM rfid_cards WHERE uid = ?', req.params.uid); if (!b) throw err(404, 'Kartu tidak ditemukan');
    const status = req.body.status;
    if (!['active', 'inactive', 'lost'].includes(status)) throw err(400, 'Status tidak valid');
    db.run('UPDATE rfid_cards SET status = ?, revoked_at = ?, note = ? WHERE uid = ?', status, status === 'active' ? null : Date.now(), req.body.note ?? b.note, b.uid);
    core.audit(actorOf(req), 'CARD_STATUS', 'rfid_card', b.uid, { status: b.status }, { status }, req.body.note);
    return db.get('SELECT * FROM rfid_cards WHERE uid = ?', b.uid);
  }));

  // ---------- Shift, penugasan, lembur ----------
  r.get('/shifts', staff, wrap(() => {
    const now = core.clock.now();
    return { shifts: core.shifts.listShifts(), current: core.shifts.instancesAround(now, { includeEarly: false }), now };
  }));
  r.put('/shifts/:id', admin, wrap((req) => core.shifts.saveShift(Number(req.params.id), req.body, actorOf(req))));
  r.get('/shifts/:id/versions', staff, wrap((req) => db.all('SELECT * FROM shift_versions WHERE shift_id = ? ORDER BY version DESC', req.params.id)));
  r.get('/assignments', staff, wrap((req) => db.all(`SELECT a.*, o.name AS operator_name, s.name AS shift_name FROM shift_assignments a JOIN operators o ON o.id = a.operator_id
    JOIN shifts s ON s.id = a.shift_id WHERE a.active = 1 ${req.query.shift_id ? 'AND a.shift_id = ' + Number(req.query.shift_id) : ''} ORDER BY a.shift_id, a.machine_id`)));
  r.post('/assignments', admin, wrap((req) => {
    const a = { shift_id: Number(req.body.shift_id), operator_id: req.body.operator_id, machine_id: req.body.machine_id, valid_from: req.body.valid_from || T.dateStr(Date.now()), valid_to: req.body.valid_to || null };
    if (!a.operator_id || !a.machine_id || !a.shift_id) throw err(400, 'Shift, operator, dan mesin wajib diisi');
    if (a.valid_to && a.valid_to < a.valid_from) throw err(400, 'Tanggal akhir sebelum tanggal mulai');
    const conflicts = core.shifts.assignmentConflicts(a);
    if (conflicts.length) throw err(409, 'Penugasan bertabrakan: ' + conflicts.join('; '));
    const x = db.run('INSERT INTO shift_assignments (shift_id, operator_id, machine_id, valid_from, valid_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', a.shift_id, a.operator_id, a.machine_id, a.valid_from, a.valid_to, req.user.id, Date.now());
    core.audit(actorOf(req), 'ASSIGNMENT_CREATE', 'shift_assignment', Number(x.lastInsertRowid), null, a);
    return { id: Number(x.lastInsertRowid) };
  }));
  r.delete('/assignments/:id', admin, wrap((req) => {
    const b = db.get('SELECT * FROM shift_assignments WHERE id = ?', req.params.id); if (!b) throw err(404, 'Penugasan tidak ditemukan');
    db.run('UPDATE shift_assignments SET active = 0, valid_to = ? WHERE id = ?', T.dateStr(Date.now()), b.id);
    core.audit(actorOf(req), 'ASSIGNMENT_END', 'shift_assignment', b.id, b, null, req.body?.reason);
  }));
  r.get('/overtime', staff, wrap(() => db.all('SELECT t.*, o.name AS operator_name FROM overtime_requests t JOIN operators o ON o.id = t.operator_id ORDER BY t.created_at DESC LIMIT 200')));
  r.post('/overtime', staff, wrap((req) => {
    const { operator_id, machine_id, shift_id, start_at, end_at, reason } = req.body;
    if (!operator_id || !machine_id || !(Number(end_at) > Number(start_at))) throw err(400, 'Data lembur tidak lengkap');
    assertMachine(req, machine_id);
    if (shift_id) { const sh = core.shifts.getShift(Number(shift_id)); if (sh && !sh.overtime_enabled) throw err(400, 'Lembur tidak diaktifkan untuk shift ini'); }
    const x = db.run("INSERT INTO overtime_requests (operator_id, machine_id, shift_id, start_at, end_at, reason, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      operator_id, machine_id, shift_id || null, Number(start_at), Number(end_at), reason || null, req.user.id, Date.now());
    core.audit(actorOf(req), 'OVERTIME_REQUEST', 'overtime', Number(x.lastInsertRowid), null, req.body, reason);
    return { id: Number(x.lastInsertRowid) };
  }));
  r.post('/overtime/:id/:decision(approve|reject)', staff, wrap((req) => {
    const o = db.get('SELECT * FROM overtime_requests WHERE id = ?', req.params.id); if (!o) throw err(404, 'Tidak ditemukan');
    assertMachine(req, o.machine_id);
    const st = req.params.decision === 'approve' ? 'approved' : 'rejected';
    db.run('UPDATE overtime_requests SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?', st, req.user.id, Date.now(), o.id);
    core.audit(actorOf(req), st === 'approved' ? 'OVERTIME_APPROVE' : 'OVERTIME_REJECT', 'overtime', o.id, { status: o.status }, { status: st }, req.body.reason);
  }));

  // ---------- Produk, tahap, standar ----------
  r.get('/products', staff, wrap(() => db.all('SELECT * FROM products ORDER BY id').map((p) => ({
    ...p,
    stages: db.all('SELECT * FROM process_stages WHERE product_id = ? ORDER BY seq', p.id).map((s) => ({
      ...s, standards: db.all('SELECT * FROM stamping_standards WHERE stage_id = ? ORDER BY effective_from DESC', s.id),
      current: core.production.standardFor(p.id, s.id, core.clock.now()),
    })),
  }))));
  r.post('/products', admin, wrap((req) => {
    const { id, name, description } = req.body;
    if (!id || !name) throw err(400, 'Kode dan nama produk wajib diisi');
    if (db.get('SELECT 1 FROM products WHERE id = ?', id)) throw err(409, 'Kode produk sudah ada');
    db.run('INSERT INTO products (id, name, description) VALUES (?, ?, ?)', id, name, description || null);
    core.audit(actorOf(req), 'PRODUCT_CREATE', 'product', id, null, req.body);
  }));
  r.put('/products/:id', admin, wrap((req) => {
    const b = db.get('SELECT * FROM products WHERE id = ?', req.params.id); if (!b) throw err(404, 'Produk tidak ditemukan');
    db.run('UPDATE products SET name = ?, description = ?, active = ? WHERE id = ?', req.body.name ?? b.name, req.body.description ?? b.description, req.body.active == null ? b.active : (req.body.active ? 1 : 0), b.id);
    core.audit(actorOf(req), 'PRODUCT_UPDATE', 'product', b.id, b, req.body);
  }));
  r.post('/products/:id/stages', admin, wrap((req) => {
    const { code, name, seq = 1 } = req.body;
    if (!code || !name) throw err(400, 'Kode dan nama tahap wajib diisi');
    const x = db.run('INSERT INTO process_stages (product_id, code, name, seq) VALUES (?, ?, ?, ?)', req.params.id, code, name, Number(seq));
    core.audit(actorOf(req), 'STAGE_CREATE', 'process_stage', Number(x.lastInsertRowid), null, req.body);
  }));
  r.post('/standards', admin, wrap((req) => core.production.saveStandard(req.body, actorOf(req))));

  // ---------- Work order & hasil produksi ----------
  r.get('/work-orders', staff, wrap(() => db.all(`SELECT w.*, p.name AS product_name, ps.name AS stage_name,
    (SELECT COUNT(*) FROM stamping_events e WHERE e.work_order_id = w.id) AS cycles,
    (SELECT IFNULL(SUM(good_qty + rework_good_qty), 0) FROM production_results r WHERE r.work_order_id = w.id) AS good
    FROM work_orders w JOIN products p ON p.id = w.product_id LEFT JOIN process_stages ps ON ps.id = w.stage_id ORDER BY w.created_at DESC, w.id`)));
  r.post('/work-orders', admin, wrap((req) => {
    const { id, product_id, stage_id, target_qty, due_date, note } = req.body;
    if (!id || !product_id || !stage_id) throw err(400, 'Nomor WO, produk, dan tahap wajib diisi');
    if (!db.get('SELECT 1 FROM process_stages WHERE id = ? AND product_id = ?', stage_id, product_id)) throw err(400, 'Tahap tidak sesuai produk');
    if (db.get('SELECT 1 FROM work_orders WHERE id = ?', id)) throw err(409, 'Nomor WO sudah ada');
    db.run('INSERT INTO work_orders (id, product_id, stage_id, target_qty, due_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, product_id, Number(stage_id), Number(target_qty) || 0, due_date || null, note || null, Date.now());
    core.audit(actorOf(req), 'WO_CREATE', 'work_order', id, null, req.body);
  }));
  r.put('/work-orders/:id', staff, wrap((req) => {
    const b = db.get('SELECT * FROM work_orders WHERE id = ?', req.params.id); if (!b) throw err(404, 'WO tidak ditemukan');
    const status = req.body.status || b.status;
    db.run('UPDATE work_orders SET status = ?, target_qty = ?, due_date = ?, note = ? WHERE id = ?', status, Number(req.body.target_qty ?? b.target_qty), req.body.due_date ?? b.due_date, req.body.note ?? b.note, b.id);
    core.audit(actorOf(req), 'WO_UPDATE', 'work_order', b.id, b, req.body);
  }));
  r.get('/jobs', staff, wrap((req) => {
    const f = { ...req.query, machines: scope(req) };
    return core.reports.production(f).rows.slice(0, Number(req.query.limit) || 300);
  }));
  r.post('/jobs/:id/result', staff, wrap((req) => {
    const job = db.get('SELECT * FROM session_jobs WHERE id = ?', req.params.id); if (!job) throw err(404, 'Pekerjaan tidak ditemukan');
    assertMachine(req, job.machine_id);
    return core.production.saveResult(job.id, req.body, actorOf(req), { source: 'supervisor', reason: req.body.reason });
  }));
  r.post('/results/:id/verify', staff, wrap((req) => {
    const x = db.get('SELECT machine_id FROM production_results WHERE id = ?', req.params.id); if (!x) throw err(404, 'Tidak ditemukan');
    assertMachine(req, x.machine_id);
    return core.production.verifyResult(Number(req.params.id), actorOf(req), req.body);
  }));
  r.get('/results/:id/history', staff, wrap((req) => db.all('SELECT * FROM production_result_history WHERE result_id = ? ORDER BY version DESC', req.params.id)));

  // ---------- Kamera ----------
  r.get('/cameras', staff, wrap(() => db.all(`SELECT c.*, m.name AS machine_name, d.status AS device_status, d.status_detail, ms.camera_state, ms.presence_raw, ms.last_quality
    FROM camera_config c JOIN machines m ON m.id = c.machine_id LEFT JOIN devices d ON d.machine_id = c.machine_id AND d.type = 'camera'
    LEFT JOIN machine_state ms ON ms.machine_id = c.machine_id ORDER BY m.number`)));
  r.put('/cameras/:m', admin, wrap((req) => {
    const b = db.get('SELECT * FROM camera_config WHERE machine_id = ?', req.params.m); if (!b) throw err(404, 'Kamera tidak ditemukan');
    const d = { ...b, ...req.body };
    const roi = typeof d.roi === 'string' ? JSON.parse(d.roi) : d.roi;
    if (!Array.isArray(roi) || roi.length < 3 || roi.some((p) => !Array.isArray(p) || p.length !== 2 || p.some((v) => v < 0 || v > 1))) throw err(400, 'ROI harus poligon ≥3 titik dengan koordinat 0..1');
    const num = (v, lo, hi) => (v === '' || v == null ? null : (Number(v) >= lo && Number(v) <= hi ? Number(v) : (() => { throw err(400, 'Nilai parameter di luar rentang'); })()));
    db.run('UPDATE camera_config SET roi = ?, absence_threshold_s = ?, return_confirm_s = ?, min_confidence = ?, min_quality = ?, min_roi_overlap = ?, enabled = ?, updated_at = ? WHERE machine_id = ?',
      JSON.stringify(roi), num(d.absence_threshold_s, 5, 3600), num(d.return_confirm_s, 1, 600), num(d.min_confidence, 0, 1), num(d.min_quality, 0, 1), num(d.min_roi_overlap, 0, 1), d.enabled ? 1 : 0, Date.now(), b.machine_id);
    core.audit(actorOf(req), 'CAMERA_CONFIG', 'camera', b.machine_id, b, req.body);
  }));

  // ---------- Laporan ----------
  const filters = (req) => ({ ...req.query, machines: scope(req) });
  r.get('/reports/sessions', staff, wrap((req) => core.reports.sessionReport(filters(req))));
  r.get('/reports/hourly', staff, wrap((req) => core.reports.hourly(filters(req))));
  r.get('/reports/production', staff, wrap((req) => core.reports.production(filters(req))));
  r.get('/reports/absences', staff, wrap((req) => core.reports.absenceList(filters(req))));

  // ---------- Perangkat, alert, audit ----------
  r.get('/devices', staff, wrap((req) => {
    const sc = scope(req);
    return { devices: core.devices.list().filter((d) => !sc || sc.includes(d.machine_id)).map((d) => ({ ...d, api_key: req.user.role === 'admin' ? d.api_key : undefined })),
      anomalies: db.all('SELECT * FROM counter_anomalies ORDER BY at DESC LIMIT 100').filter((a) => !sc || sc.includes(a.machine_id)) };
  }));
  r.put('/devices/:id', admin, wrap((req) => {
    const b = db.get('SELECT * FROM devices WHERE id = ?', req.params.id); if (!b) throw err(404, 'Perangkat tidak ditemukan');
    db.run('UPDATE devices SET name = ?, address = ? WHERE id = ?', req.body.name ?? b.name, req.body.address ?? b.address, b.id);
    if (req.body.rotate_key) db.run('UPDATE devices SET api_key = ? WHERE id = ?', crypto.randomBytes(16).toString('hex'), b.id);
    core.audit(actorOf(req), 'DEVICE_UPDATE', 'device', b.id, { name: b.name, address: b.address }, { name: req.body.name, address: req.body.address, rotate_key: !!req.body.rotate_key });
  }));
  r.get('/alerts', staff, wrap((req) => {
    const sc = scope(req);
    const open = req.query.all === '1' ? '' : 'WHERE resolved_at IS NULL';
    return db.all(`SELECT * FROM alerts ${open} ORDER BY created_at DESC LIMIT 300`).filter((a) => !sc || !a.machine_id || sc.includes(a.machine_id));
  }));
  r.post('/alerts/:id/ack', staff, wrap((req) => {
    db.run('UPDATE alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', req.user.id, Date.now(), req.params.id);
    if (req.body.resolve) db.run('UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL', Date.now(), req.params.id);
    core.audit(actorOf(req), 'ALERT_ACK', 'alert', req.params.id, null, { resolve: !!req.body.resolve }, req.body.note);
  }));
  r.get('/audit', admin, wrap((req) => {
    const where = ['1=1'], p = [];
    if (req.query.action) { where.push('action LIKE ?'); p.push(`%${req.query.action}%`); }
    if (req.query.entity) { where.push('entity = ?'); p.push(req.query.entity); }
    if (req.query.q) { where.push('(actor LIKE ? OR entity_id LIKE ? OR reason LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`); }
    if (req.query.from) { where.push('at >= ?'); p.push(Number(req.query.from)); }
    if (req.query.to) { where.push('at < ?'); p.push(Number(req.query.to)); }
    return db.all(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT 500`, ...p);
  }));

  // ---------- Pengaturan & pengguna ----------
  r.get('/settings', staff, wrap(() => core.settings.all()));
  r.put('/settings', admin, wrap((req) => {
    const before = core.settings.all();
    const allowed = Object.keys(core.settings.defaults);
    for (const [k, v] of Object.entries(req.body)) {
      if (!allowed.includes(k)) throw err(400, `Pengaturan tidak dikenal: ${k}`);
      const def = core.settings.defaults[k];
      if (typeof def === 'number' && !(Number(v) >= 0)) throw err(400, `Nilai ${k} tidak valid`);
      core.settings.set(k, typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? !!v : v);
    }
    core.audit(actorOf(req), 'SETTINGS_UPDATE', 'settings', null, Object.fromEntries(Object.keys(req.body).map((k) => [k, before[k]])), req.body);
    return core.settings.all();
  }));
  r.get('/users', admin, wrap(() => db.all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').map((u) => ({ ...u, machines: db.all('SELECT machine_id FROM supervisor_machines WHERE user_id = ?', u.id).map((x) => x.machine_id) }))));
  r.post('/users', admin, wrap((req) => {
    const { username, name, role, password } = req.body;
    if (!username || !name || !['admin', 'supervisor'].includes(role)) throw err(400, 'Data pengguna tidak lengkap');
    if (!password || password.length < 8) throw err(400, 'Kata sandi minimal 8 karakter');
    if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw err(409, 'Nama pengguna sudah ada');
    const x = db.run('INSERT INTO users (username, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', username, name, role, hashPassword(password), Date.now());
    for (const m of req.body.machines || []) db.run('INSERT INTO supervisor_machines (user_id, machine_id) VALUES (?, ?)', Number(x.lastInsertRowid), m);
    core.audit(actorOf(req), 'USER_CREATE', 'user', Number(x.lastInsertRowid), null, { username, name, role, machines: req.body.machines });
  }));
  r.put('/users/:id', admin, wrap((req) => {
    const b = db.get('SELECT id, username, name, role, active FROM users WHERE id = ?', req.params.id); if (!b) throw err(404, 'Pengguna tidak ditemukan');
    const d = { ...b, ...req.body };
    if (!['admin', 'supervisor'].includes(d.role)) throw err(400, 'Peran tidak valid');
    db.run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', d.name, d.role, d.active ? 1 : 0, b.id);
    if (req.body.password) { if (req.body.password.length < 8) throw err(400, 'Kata sandi minimal 8 karakter'); db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), b.id); }
    if (Array.isArray(req.body.machines)) { db.run('DELETE FROM supervisor_machines WHERE user_id = ?', b.id); for (const m of req.body.machines) db.run('INSERT INTO supervisor_machines (user_id, machine_id) VALUES (?, ?)', b.id, m); }
    if (!d.active) db.run('DELETE FROM auth_tokens WHERE user_id = ?', b.id);
    core.audit(actorOf(req), 'USER_UPDATE', 'user', b.id, b, { ...req.body, password: req.body.password ? '***' : undefined });
  }));
  r.post('/maintenance/retention', admin, wrap((req) => {
    const days = core.settings.get('data_retention_days');
    const cutoff = Date.now() - days * T.DAY;
    const out = {};
    db.tx(() => {
      out.raw_events = Number(db.run('DELETE FROM raw_events WHERE received_at < ?', cutoff).changes);
      out.tap_events = Number(db.run('DELETE FROM tap_events WHERE received_at < ?', cutoff).changes);
      out.auth_tokens = Number(db.run('DELETE FROM auth_tokens WHERE expires_at < ?', Date.now()).changes);
    });
    core.audit(actorOf(req), 'RETENTION_RUN', 'system', null, null, out, `Retensi ${days} hari (data sesi, stamping, produksi & audit dipertahankan)`);
    return out;
  }));

  return r;
};
