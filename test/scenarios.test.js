'use strict';
/**
 * Skenario verifikasi (lihat README bagian "Verifikasi"). Semua perangkat disimulasikan
 * melalui jalur ingest yang sama dengan perangkat fisik.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');

const S = 1000, MIN = 60 * S;

test('1. Login dan logout normal (izin menunggu konfirmasi pengendali)', () => {
  const h = setup();
  const r = h.tap('M01', h.card(1));
  assert.equal(r.outcome, 'LOGIN_PENDING');
  let s = h.core.sessions.activeByMachine('M01');
  assert.equal(s.status, 'PENDING_PERMISSION');
  assert.equal(s.permission_status, 'REQUESTED');
  assert.doesNotMatch(r.message, /Login berhasil/, 'tidak boleh menampilkan siap sebelum konfirmasi');
  assert.equal(h.lastCmd('M01').type, 'GRANT_PERMISSION');
  h.ack('M01');
  s = h.core.sessions.get(s.id);
  assert.equal(s.status, 'ACTIVE');
  assert.equal(s.permission_status, 'GRANTED');
  assert.equal(s.shift_id, 1);
  const card = h.core.dashboard.machineCard(h.core.db.get("SELECT * FROM machines WHERE id='M01'"));
  assert.match(card.terminal.message, /^Login berhasil — operator aktif: /);
  assert.equal(card.session.operator_id, 'OP001');
  h.advance(5 * MIN);
  const lo = h.tap('M01', h.card(1));
  assert.equal(lo.outcome, 'LOGOUT_PENDING');
  assert.equal(h.core.sessions.get(s.id).status, 'LOGOUT_REQUESTED', 'sesi belum ditutup sebelum kondisi aman');
  assert.equal(h.lastCmd('M01').type, 'REQUEST_STOP');
  h.ack('M01', { ok: true, physical_state: 'STOPPED', safe_state: true });
  s = h.core.sessions.get(s.id);
  assert.equal(s.status, 'CLOSED');
  assert.ok(s.logout_at);
  const sum = JSON.parse(s.summary);
  assert.equal(sum.duration_ms, 5 * MIN);
  assert.equal(h.core.sessions.activeByMachine('M01'), undefined);
  const card2 = h.core.dashboard.machineCard(h.core.db.get("SELECT * FROM machines WHERE id='M01'"));
  assert.equal(card2.session, null);
  assert.match(card2.terminal.message, /Logout berhasil/);
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'SESSION_CLOSED'"));
});

test('2. Tap ganda dan kartu tidak valid', () => {
  const h = setup();
  assert.equal(h.tap('M01', h.card(1)).outcome, 'LOGIN_PENDING');
  h.clock.t += 800;
  assert.equal(h.tap('M01', h.card(1)).outcome, 'IGNORED_DUPLICATE');
  h.ack('M01');
  h.clock.t += 4 * S;
  assert.equal(h.tap('M01', h.card(1)).outcome, 'IGNORED_TOO_SOON', 'tap cepat setelah login tidak menyebabkan logout');
  assert.equal(h.core.db.get('SELECT COUNT(*) AS n FROM sessions').n, 1);
  assert.equal(h.core.sessions.activeByMachine('M01').status, 'ACTIVE');
  assert.equal(h.tap('M02', 'DEADBEEF').outcome, 'REJECTED_UNKNOWN_CARD');
  assert.equal(h.tap('M02', h.card(98)).outcome, 'REJECTED_INACTIVE_CARD');
  assert.equal(h.tap('M02', '04FFLOST').outcome, 'REJECTED_INACTIVE_CARD');
  assert.equal(h.tap('M02', h.card(99)).outcome, 'REJECTED_INACTIVE_OPERATOR');
  assert.match(h.tap('M03', 'DEADBEEF').message, /Kartu tidak dikenal/);
});

test('3. Login operator ke dua mesin ditolak & 4. kartu berbeda saat sesi aktif', () => {
  const h = setup();
  h.core.settings.set('allow_login_unassigned_machine', true);
  h.login('M01', h.card(1));
  const r = h.tap('M02', h.card(1));
  assert.equal(r.outcome, 'REJECTED_OPERATOR_BUSY');
  assert.match(r.message, /M01/);
  const before = h.core.sessions.activeByMachine('M01');
  const r2 = h.tap('M01', h.card(2));
  assert.equal(r2.outcome, 'REJECTED_MACHINE_BUSY');
  const after = h.core.sessions.activeByMachine('M01');
  assert.equal(after.id, before.id);
  assert.equal(after.operator_id, 'OP001', 'kartu operator lain tidak mengganti / mengakhiri sesi');
  assert.equal(after.status, 'ACTIVE');
});

test('5. Pergantian operator oleh supervisor dengan alasan & audit', () => {
  const h = setup();
  h.core.settings.set('allow_login_unassigned_machine', true);
  const s = h.login('M01', h.card(1));
  const spv = { id: 2, name: 'Supervisor' };
  assert.throws(() => h.core.sessions.supervisorLogout(s.id, spv, ''), /Alasan wajib/);
  h.core.sessions.supervisorLogout(s.id, spv, 'Operator dipindah ke inspeksi');
  assert.equal(h.core.sessions.get(s.id).status, 'LOGOUT_REQUESTED');
  h.ack('M01', { ok: true, physical_state: 'STOPPED', safe_state: true });
  assert.equal(h.core.sessions.get(s.id).status, 'CLOSED');
  h.clock.t += 5 * S;
  const s2 = h.login('M01', h.card(2));
  assert.equal(s2.operator_id, 'OP002');
  const a = h.core.db.get("SELECT * FROM audit_log WHERE action = 'SESSION_LOGOUT_REQUEST' AND user_id = 2");
  assert.match(a.reason, /dipindah ke inspeksi/);
});

test('6. Pergantian shift & shift melewati tengah malam', () => {
  const h = setup({ at: '2026-11-09 22:40' });
  const s2 = h.login('M01', h.card(31)); // Shift 2 (15:00–23:00)
  assert.equal(s2.shift_id, 2);
  h.setTime('2026-11-09 23:01');
  assert.equal(h.tap('M01', h.card(61)).outcome, 'REJECTED_MACHINE_BUSY', 'operator shift 3 menunggu logout operator shift 2');
  h.logout('M01', h.card(31));
  h.clock.t += 5 * S;
  const s3 = h.login('M01', h.card(61));
  assert.equal(s3.shift_id, 3);
  assert.equal(s3.shift_date, '2026-11-09');
  const snap = JSON.parse(s3.shift_snapshot);
  assert.equal(h.T.dateTimeStr(snap.end), '2026-11-10 07:00:00');
  assert.equal(h.T.dateTimeStr(snap.breaks[0].start), '2026-11-10 03:00:00', 'istirahat setelah tengah malam berada di hari berikutnya');
  assert.notEqual(s2.id, s3.id, 'pergantian shift menghasilkan sesi terpisah');
  // Login setelah tengah malam memakai instans shift 3 tanggal sebelumnya
  h.setTime('2026-11-10 02:00');
  const s4 = h.login('M02', h.card(62));
  assert.equal(s4.shift_id, 3);
  assert.equal(s4.shift_date, '2026-11-09');
  // Penugasan bertabrakan ditolak
  const conflicts = h.core.shifts.assignmentConflicts({ shift_id: 1, operator_id: 'OP002', machine_id: 'M01', valid_from: '2026-11-09', valid_to: null });
  assert.ok(conflicts.some((c) => /Mesin M01/.test(c)) && conflicts.some((c) => /Operator OP002/.test(c)));
  assert.equal(h.core.shifts.shiftsOverlap(h.core.shifts.getShift(3), h.core.shifts.getShift(1)), false);
});

test('6b. Pergantian shift operator yang sama (lembur disetujui) tanpa menghentikan mesin', () => {
  const h = setup({ at: '2026-11-09 14:30' });
  const s1 = h.login('M01', h.card(1));
  const { fromLocal } = h.T;
  h.core.db.run("INSERT INTO overtime_requests (operator_id, machine_id, shift_id, start_at, end_at, reason, status, approved_by, created_at) VALUES ('OP001','M01',2,?,?,'Target WO','approved',2,?)",
    fromLocal('2026-11-09', '15:00'), fromLocal('2026-11-09', '17:00'), h.clock.t);
  h.setTime('2026-11-09 15:00');
  const cmds = h.core.db.get('SELECT COUNT(*) AS n FROM controller_commands').n;
  const s2 = h.core.sessions.shiftHandover(s1.id, { id: 2, name: 'Supervisor' }, 'Lembur disetujui untuk WO prioritas');
  assert.equal(h.core.sessions.get(s1.id).status, 'CLOSED');
  assert.equal(s2.status, 'ACTIVE');
  assert.equal(s2.handover_from, s1.id);
  assert.equal(s2.overtime_id != null, true);
  assert.equal(h.core.db.get('SELECT COUNT(*) AS n FROM controller_commands').n, cmds, 'tidak ada perintah stop');
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'SESSION_SHIFT_HANDOVER'"));
});

test('7. Shift berakhir tanpa logout → peringatan, mesin tidak dihentikan', () => {
  const h = setup({ at: '2026-11-09 14:00' });
  const s = h.login('M01', h.card(1));
  const nCmd = h.core.db.get('SELECT COUNT(*) AS n FROM controller_commands').n;
  h.setTime('2026-11-09 15:10'); h.core.tick();
  assert.equal(h.core.sessions.get(s.id).not_logged_out, 0, 'masih dalam batas toleransi');
  h.setTime('2026-11-09 15:16'); h.core.tick();
  const s2 = h.core.sessions.get(s.id);
  assert.equal(s2.not_logged_out, 1);
  assert.equal(s2.status, 'ACTIVE');
  assert.equal(s2.permission_status, 'GRANTED');
  assert.equal(h.core.db.get('SELECT COUNT(*) AS n FROM controller_commands').n, nCmd, 'tidak ada perintah stop otomatis');
  assert.ok(h.core.db.get("SELECT 1 FROM alerts WHERE type = 'NOT_LOGGED_OUT' AND resolved_at IS NULL"));
  const card = h.core.dashboard.machineCard(h.core.db.get("SELECT * FROM machines WHERE id='M01'"));
  assert.ok(card.flags.includes('Belum logout'));
});

test('8. Ketidakhadiran singkat (di bawah ambang) dan panjang', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  h.presence('M01', true);
  h.advance(60 * S);
  h.presence('M01', false);
  h.advance(20 * S);
  h.presence('M01', true); // 20 d < 30 d → bukan kejadian
  h.advance(10 * S);
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM presence_events WHERE kind = 'ABSENCE'").n, 0);
  const t0 = h.clock.t;
  h.presence('M01', false);
  for (let i = 0; i < 4; i++) h.advance(10 * S);
  const ev = h.core.db.get("SELECT * FROM presence_events WHERE kind = 'ABSENCE'");
  assert.ok(ev, 'kejadian dibuat setelah melewati ambang');
  assert.equal(ev.start_at, t0, 'waktu mulai = awal tidak terdeteksi');
  h.advance(60 * S);
  const back = h.clock.t;
  h.presence('M01', true);
  h.advance(2 * S);
  h.presence('M01', false); // kembali sebentar lalu pergi lagi → belum terkonfirmasi
  h.advance(10 * S);
  assert.equal(h.core.db.get('SELECT end_at FROM presence_events WHERE id = ?', ev.id).end_at, null);
  const back2 = h.clock.t;
  h.presence('M01', true);
  h.advance(3 * S); h.advance(3 * S);
  const closed = h.core.db.get('SELECT * FROM presence_events WHERE id = ?', ev.id);
  assert.equal(closed.end_at, back2);
  assert.equal(closed.duration_ms, back2 - t0);
  assert.ok(back < back2);
  const m = h.core.reports.sessionMetrics(h.core.sessions.get(s.id));
  assert.equal(m.absence_count, 1);
  assert.equal(m.absent_ms, back2 - t0);
  assert.equal(m.present_ms + m.absent_ms + m.break_ms + m.leave_ms + m.unknown_ms, m.duration_ms, 'tidak ada durasi ganda');
});

test('9. Kejadian melewati batas jam & istirahat dipecah tanpa menggandakan kejadian', () => {
  const h = setup({ at: '2026-11-09 09:00' });
  const s = h.login('M01', h.card(1));
  h.presence('M01', true);
  // 09:25–09:45 melewati istirahat 09:30–09:40
  h.setTime('2026-11-09 09:25'); h.presence('M01', false);
  h.setTime('2026-11-09 09:26'); h.core.tick();
  h.setTime('2026-11-09 09:45'); h.presence('M01', true);
  h.setTime('2026-11-09 09:45:10'); h.core.tick();
  // 09:50–10:10 melewati batas jam
  h.setTime('2026-11-09 09:50'); h.presence('M01', false);
  h.setTime('2026-11-09 09:51'); h.core.tick();
  h.setTime('2026-11-09 10:10'); h.presence('M01', true);
  h.setTime('2026-11-09 10:10:10'); h.core.tick();
  h.setTime('2026-11-09 10:30');
  const evs = h.core.db.all("SELECT * FROM presence_events WHERE kind = 'ABSENCE' ORDER BY start_at");
  assert.equal(evs.length, 2, 'kejadian asli tetap 2');
  const m = h.core.reports.sessionMetrics(h.core.sessions.get(s.id));
  const e1 = m.absence_events[0];
  assert.equal(e1.parts.absent, 10 * MIN);
  assert.equal(e1.parts.break, 10 * MIN);
  assert.equal(m.absent_ms, 30 * MIN);
  assert.equal(m.break_ms, 10 * MIN);
  const hourly = h.core.reports.hourly({ machine_id: 'M01' });
  const h9 = hourly.find((x) => h.T.timeStr(x.hour, false) === '09:00');
  const h10 = hourly.find((x) => h.T.timeStr(x.hour, false) === '10:00');
  assert.equal(h9.absent, 20 * MIN, '09:25–09:30 + 09:40–09:45 + 09:50–10:00');
  assert.equal(h9.break, 10 * MIN);
  assert.equal(h10.absent, 10 * MIN, '10:00–10:10 masuk periode 10.00–11.00');
  const total = hourly.reduce((a, x) => a + x.present + x.absent + x.break + x.leave + x.unknown, 0);
  assert.equal(total, m.duration_ms, 'jumlah per jam = durasi sesi');
});

test('9b. Izin disetujui & koreksi klasifikasi oleh supervisor (asli tetap tersimpan)', () => {
  const h = setup({ at: '2026-11-09 08:00' });
  const s = h.login('M01', h.card(1));
  h.presence('M01', true);
  h.core.db.run("INSERT INTO leave_permits (operator_id, session_id, start_at, end_at, reason, approved_by, created_at) VALUES ('OP001', ?, ?, ?, 'Ke klinik', 2, ?)", s.id, h.clock.t + MIN, h.clock.t + 11 * MIN, h.clock.t);
  h.advance(MIN); h.presence('M01', false);
  h.advance(MIN);
  h.advance(9 * MIN); h.presence('M01', true); h.advance(10 * S);
  let m = h.core.reports.sessionMetrics(h.core.sessions.get(s.id));
  assert.equal(m.leave_ms, 10 * MIN);
  assert.equal(m.absent_ms, 0);
  h.advance(MIN); h.presence('M01', false); h.advance(MIN); h.advance(MIN); h.presence('M01', true); h.advance(10 * S);
  const ev = h.core.db.get("SELECT * FROM presence_events WHERE kind='ABSENCE' ORDER BY start_at DESC LIMIT 1");
  assert.throws(() => h.core.presence.correct(ev.id, 'PRESENT', '', { id: 2 }), /Alasan/);
  h.core.presence.correct(ev.id, 'PRESENT', 'Operator di belakang mesin mengambil material (blind spot kamera)', { id: 2, name: 'Supervisor' });
  const ev2 = h.core.db.get('SELECT * FROM presence_events WHERE id = ?', ev.id);
  assert.equal(ev2.classification, 'ABSENT', 'klasifikasi asli tetap');
  assert.equal(ev2.corrected_classification, 'PRESENT');
  m = h.core.reports.sessionMetrics(h.core.sessions.get(s.id));
  assert.equal(m.absent_ms, 0);
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'PRESENCE_CORRECTION'"));
});

test('10. Kamera, sensor, atau jaringan terputus tidak dihitung sebagai ketidakhadiran', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  h.presence('M01', true);
  h.advance(MIN);
  h.presence('M01', false);
  h.advance(10 * S);
  h.ev('M01', 'camera_status', { status: 'offline', detail: 'Kabel terlepas' });
  h.advance(5 * MIN);
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM presence_events WHERE kind = 'ABSENCE'").n, 0);
  assert.equal(h.core.presence.currentStatus('M01').code, 'UNKNOWN');
  h.ev('M01', 'camera_status', { status: 'ok' });
  h.presence('M01', true);
  h.advance(MIN);
  h.presence('M01', false, { payload: { quality: 0.1 } }); // deteksi tidak andal
  h.advance(2 * MIN);
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM presence_events WHERE kind = 'ABSENCE'").n, 0);
  h.presence('M01', true);
  const m = h.core.reports.sessionMetrics(h.core.sessions.get(s.id));
  assert.equal(m.absent_ms, 0);
  assert.equal(m.unknown_ms, 5 * MIN + 2 * MIN);
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM presence_events WHERE kind = 'MONITORING_UNAVAILABLE'").n, 2);

  // Jaringan terputus: perangkat lokal tidak mengirim heartbeat → status tidak diketahui
  h.advance(25 * S, { except: ['M01'] });
  const card = h.core.dashboard.machineCard(h.core.db.get("SELECT * FROM machines WHERE id='M01'"));
  assert.equal(card.devices.edge.status, 'offline');
  assert.equal(card.physical_state, 'UNKNOWN', 'status fisik "Tidak diketahui" tanpa umpan balik');
  assert.equal(card.devices.camera.status, 'unknown');
  assert.equal(h.core.sessions.activeByMachine('M01').status, 'ACTIVE', 'sesi tidak diputus');
  // Kejadian tersimpan lokal lalu disinkronkan (buffered) — dihitung berdasarkan waktu perangkat
  const t1 = h.clock.t;
  h.presence('M01', false, { device_time: t1, buffered: true });
  h.cycle('M01', { device_time: t1 + 5 * S, buffered: true });
  const tapOffline = h.ev('M01', 'rfid_tap', { uid: h.card(1) }, { device_time: t1 + 6 * S, buffered: true });
  assert.equal(tapOffline.outcome, 'IGNORED_STALE', 'tap offline tidak memberi izin / logout');
  h.presence('M01', true, { device_time: t1 + 90 * S, buffered: true });
  h.clock.t = t1 + 100 * S; h.heartbeat(); h.core.tick();
  const ab = h.core.db.get("SELECT * FROM presence_events WHERE kind = 'ABSENCE'");
  assert.equal(ab.start_at, t1);
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM stamping_events WHERE session_id = ?", s.id).n, 1);
  assert.equal(h.core.sessions.activeByMachine('M01').status, 'ACTIVE');
});

test('11. Perintah pengendali gagal (izin & logout)', () => {
  const h = setup();
  h.tap('M01', h.card(1));
  h.ack('M01', { ok: false, error: 'Interlock pintu terbuka' });
  const s = h.core.db.get('SELECT * FROM sessions ORDER BY login_at DESC LIMIT 1');
  assert.equal(s.status, 'PERMISSION_FAILED');
  assert.equal(s.permission_status, 'DENIED');
  const card = h.core.dashboard.machineCard(h.core.db.get("SELECT * FROM machines WHERE id='M01'"));
  assert.match(card.terminal.message, /Login gagal — izin operasional tidak dikonfirmasi/);
  assert.equal(card.session, null);
  // Timeout tanpa respons
  h.advance(4 * S);
  assert.equal(h.tap('M01', h.card(1)).outcome, 'LOGIN_PENDING');
  h.advance(5 * S); h.advance(6 * S);
  assert.equal(h.core.db.get("SELECT status FROM controller_commands ORDER BY rowid DESC LIMIT 1").status, 'TIMEOUT');
  assert.equal(h.core.sessions.activeByMachine('M01'), undefined);
  // Logout tidak terkonfirmasi aman → sesi tetap terbuka
  h.advance(4 * S);
  const s2 = h.login('M01', h.card(1));
  h.advance(MIN);
  h.tap('M01', h.card(1));
  h.ack('M01', { ok: false, safe_state: false, physical_state: 'RUNNING', error: 'Siklus masih berjalan' });
  assert.equal(h.core.sessions.get(s2.id).status, 'LOGOUT_FAILED');
  assert.ok(h.core.db.get("SELECT 1 FROM alerts WHERE type = 'LOGOUT_FAILED' AND resolved_at IS NULL"));
  h.cycle('M01');
  assert.equal(h.core.db.get('SELECT session_id FROM stamping_events ORDER BY device_time DESC LIMIT 1').session_id, s2.id);
  h.advance(5 * S);
  assert.equal(h.tap('M01', h.card(1)).outcome, 'LOGOUT_PENDING', 'tap ulang mencoba logout lagi');
  h.ack('M01', { ok: true, physical_state: 'STOPPED', safe_state: true });
  assert.equal(h.core.sessions.get(s2.id).status, 'CLOSED');
  // Penutupan paksa memerlukan konfirmasi keselamatan
  h.advance(5 * S);
  const s3 = h.login('M01', h.card(1));
  assert.throws(() => h.core.sessions.forceClose(s3.id, { id: 2 }, 'PLC rusak, tidak merespons', false), /kondisi mesin aman/);
  h.core.sessions.forceClose(s3.id, { id: 2, name: 'Supervisor' }, 'PLC rusak, tidak merespons', true);
  assert.equal(h.core.sessions.get(s3.id).status, 'FORCE_CLOSED');
});

test('12. Sinyal sensor ganda, tertahan, celah data', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  for (const c of [1, 2]) h.ev('M01', 'cycle_complete', { plc_counter: c });
  assert.equal(h.ev('M01', 'cycle_complete', { plc_counter: 2 }).outcome, 'DUPLICATE_COUNTER', 'counter sama = satu siklus');
  const dupId = 'fixed-event-1';
  h.ev('M01', 'cycle_complete', { plc_counter: 3 }, { event_id: dupId });
  assert.equal(h.ev('M01', 'cycle_complete', { plc_counter: 3 }, { event_id: dupId }).status, 'duplicate');
  h.ev('M01', 'sensor_event', { kind: 'STUCK', detail: 'HIGH > 5 d' });
  assert.equal(h.core.devices.byType('M01').sensor.status, 'fault');
  h.ev('M01', 'sensor_event', { kind: 'SENSOR_RESTORED' });
  h.ev('M01', 'cycle_complete', { plc_counter: 6 });
  assert.equal(h.core.stamping.countsBySession(s.id).total, 4);
  const gap = h.core.db.get("SELECT * FROM counter_anomalies WHERE type = 'GAP'");
  assert.equal(gap.count, 2, 'kehilangan data dicatat');
  assert.ok(h.core.db.get("SELECT 1 FROM counter_anomalies WHERE type = 'STUCK'"));
  h.ev('M01', 'counter_reset', { new_value: 0, reason: 'Penggantian PLC' });
  h.ev('M01', 'cycle_complete', { plc_counter: 1 });
  assert.equal(h.core.stamping.countsBySession(s.id).total, 5, 'setelah reset, counter 1 pada epoch baru dihitung');
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'COUNTER_RESET'"));
});

test('13. Restart server & sinkronisasi ulang tanpa duplikasi; tanpa izin otomatis', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stamp-'));
  const file = path.join(dir, 't.db');
  const h = setup({ dbPath: file });
  const s = h.login('M01', h.card(1));
  const batch = [];
  for (let i = 1; i <= 10; i++) batch.push({ event_id: `b-${i}`, machine_id: 'M01', type: 'cycle_complete', device_time: h.clock.t + i * S, payload: { plc_counter: i } });
  h.core.ingest.ingest(batch);
  h.tap('M02', h.card(2)); // perintah izin tertunda saat server mati
  h.core.db.close();
  const h2 = setup({ dbPath: file, reseed: false, at: '2026-11-09 07:06' });
  assert.equal(h2.core.stamping.countsBySession(s.id).total, 10, 'hitungan tetap setelah restart');
  const res = h2.core.ingest.ingest(batch);
  assert.ok(res.every((r) => r.status === 'duplicate'));
  assert.equal(h2.core.stamping.countsBySession(s.id).total, 10);
  const rs = h2.core.ingest.ingest(batch.map((e) => ({ ...e, event_id: e.event_id + '-resync' })));
  assert.ok(rs.every((r) => r.outcome === 'DUPLICATE_COUNTER'), 'sinkronisasi ulang dengan ID baru juga tidak menggandakan');
  const m2 = h2.core.db.get("SELECT * FROM sessions WHERE machine_id = 'M02' ORDER BY login_at DESC LIMIT 1");
  assert.equal(m2.status, 'PERMISSION_FAILED', 'perintah tertunda tidak diberikan otomatis setelah restart');
  h2.core.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('14. Stamping tanpa sesi operator dicatat & tidak diatribusikan ke operator sebelumnya', () => {
  const h = setup();
  h.login('M01', h.card(1));
  h.cycle('M01');
  h.advance(MIN);
  h.logout('M01', h.card(1));
  h.advance(10 * S);
  const r = h.cycle('M01');
  assert.equal(r.outcome, 'COUNTED_NO_SESSION');
  const e = h.core.db.get('SELECT * FROM stamping_events ORDER BY device_time DESC LIMIT 1');
  assert.equal(e.no_session, 1);
  assert.equal(e.operator_id, null);
  assert.equal(e.session_id, null);
  assert.equal(e.shift_id, 1);
  assert.ok(h.core.db.get("SELECT 1 FROM alerts WHERE type = 'STAMP_NO_SESSION' AND machine_id = 'M01'"));
  const prod = h.core.reports.production({ machine_id: 'M01' });
  assert.equal(prod.no_session[0].n, 1);
});

test('15. Pergantian produk di tengah shift memisahkan pencatatan; salinan standar tetap', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  const wos = h.core.db.all('SELECT * FROM work_orders ORDER BY id');
  const j1 = h.core.sessions.selectJob(s.id, { work_order_id: wos[0].id }, { label: 'op' });
  for (let i = 0; i < 5; i++) { h.advance(5 * S); h.cycle('M01'); }
  h.advance(S);
  const j2 = h.core.sessions.selectJob(s.id, { work_order_id: wos[1].id, category: 'setup' }, { label: 'op' });
  for (let i = 0; i < 3; i++) { h.advance(5 * S); h.cycle('M01'); }
  const j3 = h.core.sessions.selectJob(s.id, { work_order_id: wos[1].id, category: 'normal' }, { label: 'op' });
  for (let i = 0; i < 6; i++) { h.advance(5 * S); h.cycle('M01'); }
  assert.equal(h.core.production.jobCycles(j1.id).normal, 5);
  assert.equal(h.core.production.jobCycles(j2.id).setup, 3);
  assert.equal(h.core.production.jobCycles(j3.id).normal, 6);
  assert.equal(h.core.db.get('SELECT ended_at FROM session_jobs WHERE id = ?', j1.id).ended_at != null, true);
  // Perubahan standar tidak mengubah laporan historis
  h.core.production.saveStandard({ product_id: wos[0].product_id, stage_id: wos[0].stage_id, cycles_per_set: 2, pcs_per_set: 1, tolerance_pct: 5, note: 'Uji' }, { id: 1, name: 'Admin' });
  const snap = JSON.parse(h.core.db.get('SELECT standard_snapshot FROM session_jobs WHERE id = ?', j1.id).standard_snapshot);
  assert.equal(snap.cycles_per_set, 1);
  assert.equal(h.core.production.standardFor(wos[0].product_id, wos[0].stage_id, h.clock.t + 1).cycles_per_set, 2);
});

test('16. Produk dengan beberapa stamping per pcs / beberapa pcs per siklus (contoh spesifikasi)', () => {
  const h = setup();
  const P = h.core.production;
  const job = (std) => ({ job: { category: 'normal' }, cycles: { normal: 3000, setup: 0, trial: 0, rework: 0, unassigned: 0, total: 3000 },
    result: { good_qty: 1000, reject_completed_qty: 0, reject_incomplete_qty: 0, rework_qty: 0, wip_qty: 0, is_final: 1, verification_status: 'UNVERIFIED', reconciliation_cycles: 0 }, std });
  const a = P.compute([job({ cycles_per_set: 1, pcs_per_set: 1, tolerance_pct: 5 })]);
  assert.equal(a.standard_cycles, 1000); assert.equal(a.diff, 2000); assert.equal(a.diff_pct, 200); assert.equal(a.status_label, 'Perlu ditinjau');
  const b = P.compute([job({ cycles_per_set: 3, pcs_per_set: 1, tolerance_pct: 5 })]);
  assert.equal(b.diff, 0); assert.equal(b.status_label, 'Sesuai standar');
  const c0 = job({ cycles_per_set: 1, pcs_per_set: 2, tolerance_pct: 5 }); c0.cycles.normal = 500; c0.cycles.total = 500;
  const c = P.compute([c0]);
  assert.equal(c.standard_cycles, 500); assert.equal(c.status, 'OK');
  const d = P.compute([job(null)]);
  assert.equal(d.status_label, 'Standar belum tersedia'); assert.equal(d.diff, null);
  const e0 = job({ cycles_per_set: 1, pcs_per_set: 1, tolerance_pct: 5 }); e0.result.is_final = 0;
  assert.equal(P.compute([e0]).status_label, 'Sementara — perlu rekonsiliasi');
  const f0 = job({ cycles_per_set: 1, pcs_per_set: 1, tolerance_pct: 5 }); f0.result.wip_qty = 50;
  assert.equal(P.compute([f0]).status, 'PROVISIONAL', 'WIP harus direkonsiliasi');
  f0.result.reconciliation_cycles = 50; f0.cycles.normal = 1050; f0.cycles.total = 1050;
  const f = P.compute([f0]);
  assert.equal(f.status, 'OK'); assert.equal(f.diff, 0);
  assert.equal(a.ratio_total_per_good, 3);

  // Alur nyata Produk B (3 siklus/pcs) + rework yang menjadi baik tidak dihitung dua kali
  const s = h.login('M01', h.card(1));
  const woB = h.core.db.get("SELECT * FROM work_orders WHERE product_id = 'PRD-B' LIMIT 1");
  const jn = h.core.sessions.selectJob(s.id, { work_order_id: woB.id }, { label: 'op' });
  for (let i = 0; i < 33; i++) h.cycle('M01', { device_time: h.clock.t + i * 100 });
  h.clock.t += 5 * S;
  P.saveResult(jn.id, { good_qty: 9, rework_qty: 2, rework_reasons: 'Sudut kurang', is_final: true }, { label: 'op' }, { source: 'operator' });
  const jr = h.core.sessions.selectJob(s.id, { work_order_id: woB.id, category: 'rework' }, { label: 'op' });
  for (let i = 0; i < 2; i++) h.cycle('M01', { device_time: h.clock.t + i * 100 });
  P.saveResult(jr.id, { rework_qty: 2, rework_good_qty: 2, is_final: true }, { label: 'op' }, { source: 'operator' });
  const all = P.analyzeJobs(h.core.db.all('SELECT * FROM session_jobs WHERE session_id = ?', s.id));
  assert.equal(all.qty.good_total, 11, '9 baik + 2 rework menjadi baik = 11 (bukan 13)');
  assert.equal(all.qty.basis_pcs, 11);
  assert.equal(all.standard_cycles, 33);
  assert.equal(all.diff, 0);
  assert.equal(all.cycles.rework, 2);
});

test('17. Koreksi hasil produksi dengan histori & audit log; verifikasi supervisor', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  const wo = h.core.db.get("SELECT * FROM work_orders WHERE product_id = 'PRD-A' LIMIT 1");
  const j = h.core.sessions.selectJob(s.id, { work_order_id: wo.id }, { label: 'op' });
  for (let i = 0; i < 30; i++) h.cycle('M01', { device_time: h.clock.t + i * 100 });
  const P = h.core.production;
  const r1 = P.saveResult(j.id, { good_qty: 10, is_final: true }, { label: 'op' }, { source: 'operator' });
  assert.equal(P.analyzeJob(h.core.db.get('SELECT * FROM session_jobs WHERE id = ?', j.id)).status, 'REVIEW');
  assert.throws(() => P.saveResult(j.id, { good_qty: 30, is_final: true }, { id: 2, name: 'Spv' }, { source: 'supervisor' }), /alasan/);
  assert.throws(() => P.saveResult(j.id, { good_qty: 28, reject_completed_qty: 2, is_final: true }, { id: 2, name: 'Spv' }, { source: 'supervisor', reason: 'Salah hitung' }), /Alasan reject/);
  const r2 = P.saveResult(j.id, { good_qty: 28, reject_completed_qty: 2, reject_reasons: 'Retak', is_final: true }, { id: 2, name: 'Spv' }, { source: 'supervisor', reason: 'Hitung ulang di rak hasil' });
  assert.equal(r2.version, 2);
  assert.equal(r2.source, 'supervisor');
  assert.equal(h.core.db.get('SELECT COUNT(*) AS n FROM production_result_history WHERE result_id = ?', r1.id).n, 1);
  const hist = JSON.parse(h.core.db.get('SELECT snapshot FROM production_result_history WHERE result_id = ?', r1.id).snapshot);
  assert.equal(hist.good_qty, 10, 'nilai asli tersimpan');
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'PRODUCTION_CORRECTION' AND reason = 'Hitung ulang di rak hasil'"));
  const an = P.analyzeJob(h.core.db.get('SELECT * FROM session_jobs WHERE id = ?', j.id));
  assert.equal(an.status, 'OK');
  const v = P.verifyResult(r2.id, { id: 2, name: 'Spv' }, { status: 'VERIFIED', explanation: 'Sesuai' });
  assert.equal(v.verification_status, 'VERIFIED');
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'PRODUCTION_VERIFY'"));
});

test('18. Pemulihan listrik tanpa restart / izin otomatis', () => {
  const h = setup();
  const s = h.login('M01', h.card(1));
  h.advance(MIN);
  h.ev('M01', 'power', { state: 'lost' });
  assert.equal(h.core.sessions.get(s.id).permission_status, 'SUSPENDED');
  assert.equal(h.tap('M02', h.card(2)).outcome, 'LOGIN_PENDING', 'mesin lain tidak terpengaruh');
  h.advance(MIN);
  const nCmd = h.core.db.get("SELECT COUNT(*) AS n FROM controller_commands WHERE machine_id = 'M01'").n;
  h.ev('M01', 'power', { state: 'restored', physical_state: 'STOPPED' });
  assert.equal(h.core.sessions.get(s.id).permission_status, 'SUSPENDED', 'izin tidak dipulihkan otomatis');
  assert.equal(h.core.db.get("SELECT COUNT(*) AS n FROM controller_commands WHERE machine_id = 'M01'").n, nCmd, 'tidak ada perintah otomatis');
  assert.equal(h.core.db.get("SELECT physical_state FROM machine_state WHERE machine_id = 'M01'").physical_state, 'STOPPED');
  assert.ok(h.core.db.get("SELECT 1 FROM audit_log WHERE action = 'POWER_RESTORED' AND after_data LIKE '%\"auto_restart\":false%'"));
  h.advance(5 * S);
  assert.equal(h.tap('M01', h.card(1)).outcome, 'REPERMIT_PENDING', 'operator meminta izin ulang secara eksplisit');
  h.ack('M01');
  assert.equal(h.core.sessions.get(s.id).permission_status, 'GRANTED');
  assert.equal(h.core.sessions.get(s.id).status, 'ACTIVE');
});

test('19. 30 mesin beroperasi bersamaan', () => {
  const h = setup();
  const machines = h.core.db.all('SELECT id, number FROM machines ORDER BY number');
  for (const m of machines) assert.equal(h.tap(m.id, h.card(m.number)).outcome, 'LOGIN_PENDING');
  for (const m of machines) h.ack(m.id);
  const wos = h.core.db.all('SELECT id FROM work_orders');
  for (const m of machines) h.core.sessions.selectJob(h.core.sessions.activeByMachine(m.id).id, { work_order_id: wos[m.number % wos.length].id }, { label: 'op' });
  for (let i = 0; i < 20; i++) {
    h.clock.t += 3 * S;
    for (const m of machines) h.cycle(m.id);
    if (i % 5 === 0) h.heartbeat();
  }
  h.core.tick();
  const ov = h.core.dashboard.overview();
  assert.equal(ov.summary.total, 30);
  assert.equal(ov.summary.active, 30);
  assert.equal(ov.summary.stamping_total, 600);
  for (const c of ov.cards) assert.equal(c.session.stamping.total, 20);
  assert.equal(new Set(ov.cards.map((c) => c.session.operator_id)).size, 30);
  const rep = h.core.reports.sessionReport({});
  assert.equal(rep.length, 30);
});
