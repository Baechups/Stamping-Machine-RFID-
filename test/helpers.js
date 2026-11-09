'use strict';
const { createCore } = require('../server/core');
const { seed } = require('../server/seed');
const T = require('../server/lib/time');

/** Membuat inti aplikasi terisolasi dengan jam yang dapat dikendalikan. */
function setup({ at = '2026-11-09 07:05', dbPath = ':memory:', reseed = true } = {}) {
  const [d, t] = at.split(' ');
  const clock = { t: T.fromLocal(d, t), now() { return this.t; } };
  const core = createCore({ dbPath, clock, simulation: false });
  if (reseed) seed(core, { quiet: true });
  core.recoverOnStartup();
  let n = 0;
  const h = {
    core, clock, T,
    ev(m, type, payload = {}, extra = {}) {
      const id = extra.event_id || `ev-${process.hrtime.bigint()}-${++n}`;
      return core.ingest.ingest([{ event_id: id, machine_id: m, type, device_time: extra.device_time ?? clock.t, payload, ...extra }])[0];
    },
    heartbeat(machines) {
      const list = machines || core.db.all('SELECT id FROM machines').map((x) => x.id);
      for (const m of list) h.ev(m, 'heartbeat', { components: { rfid: 'ok', camera: 'ok', sensor: 'ok', controller: 'ok', terminal: 'ok' } });
    },
    /** Memajukan jam; heartbeat dikirim agar perangkat tetap "terhubung" (kecuali yang dikecualikan). */
    advance(ms, { except = [], tick = true } = {}) {
      clock.t += ms;
      const list = core.db.all('SELECT id FROM machines').map((x) => x.id).filter((m) => !except.includes(m));
      h.heartbeat(list);
      if (tick) core.tick();
    },
    setTime(at2) { const [dd, tt] = at2.split(' '); clock.t = T.fromLocal(dd, tt); h.heartbeat(); },
    tap(m, uid, extra) { return h.ev(m, 'rfid_tap', { uid }, extra).terminal; },
    lastCmd(m) { return core.db.get("SELECT * FROM controller_commands WHERE machine_id = ? ORDER BY rowid DESC LIMIT 1", m); },
    ack(m, result = { ok: true, physical_state: 'IDLE' }) {
      const c = core.db.get("SELECT * FROM controller_commands WHERE machine_id = ? AND status IN ('PENDING','SENT') ORDER BY rowid DESC LIMIT 1", m);
      if (!c) throw new Error(`Tidak ada perintah tertunda untuk ${m}`);
      core.sessions.onCommandResult(c.id, c.type === 'REQUEST_STOP' && result.ok && !result.physical_state ? { ...result, physical_state: 'STOPPED', safe_state: true } : result);
      return c;
    },
    login(m, uid) { const r = h.tap(m, uid); if (r.outcome !== 'LOGIN_PENDING') throw new Error(`Login gagal: ${r.outcome} ${r.message}`); h.ack(m); return core.sessions.activeByMachine(m); },
    logout(m, uid) { const r = h.tap(m, uid); if (r.outcome !== 'LOGOUT_PENDING') throw new Error(`Logout gagal: ${r.outcome} ${r.message}`); h.ack(m, { ok: true, physical_state: 'STOPPED', safe_state: true }); },
    counter: {},
    cycle(m, extra = {}) { h.counter[m] = (h.counter[m] || 0) + 1; return h.ev(m, 'cycle_complete', { plc_counter: h.counter[m] }, extra); },
    presence(m, present, extra = {}) { return h.ev(m, 'presence', { present, confidence: 0.9, quality: 0.9, roi_overlap: present ? 0.9 : null, ...extra.payload }, extra); },
    card: (opNum) => `04A1${String(opNum).padStart(4, '0')}`,
  };
  h.heartbeat();
  return h;
}
module.exports = { setup };
