'use strict';
/**
 * Gerbang penerimaan kejadian dari perangkat lokal (edge). Idempoten: setiap kejadian
 * memiliki event_id unik yang dibuat perangkat; kiriman ulang saat sinkronisasi diabaikan.
 * Menyimpan waktu kejadian perangkat (device_time) dan waktu penerimaan server (received_at).
 */
const TYPES = ['heartbeat', 'rfid_tap', 'presence', 'camera_status', 'cycle_complete', 'counter_reset', 'sensor_event', 'controller_state', 'power', 'command_result', 'monitoring_gap'];
const PHYSICAL = ['RUNNING', 'STOPPED', 'IDLE', 'ESTOP', 'FAULT', 'POWER_OFF', 'UNKNOWN'];

module.exports = function ingestService(core) {
  const { db } = core;

  function validate(e) {
    if (!e || typeof e !== 'object') return 'Format kejadian tidak valid';
    if (!e.event_id || typeof e.event_id !== 'string' || e.event_id.length > 80) return 'event_id wajib';
    if (!e.machine_id) return 'machine_id wajib';
    if (!TYPES.includes(e.type)) return `Tipe kejadian tidak dikenal: ${e.type}`;
    if (!Number.isFinite(Number(e.device_time))) return 'device_time wajib (epoch ms)';
    return null;
  }

  function one(e, receivedAt) {
    const err = validate(e);
    if (err) return { event_id: e?.event_id, status: 'rejected', error: err };
    if (!db.get('SELECT 1 FROM machines WHERE id = ?', e.machine_id)) return { event_id: e.event_id, status: 'rejected', error: 'Mesin tidak dikenal' };
    if (db.get('SELECT 1 FROM raw_events WHERE event_id = ?', e.event_id)) return { event_id: e.event_id, status: 'duplicate' };
    const t = Number(e.device_time);
    const p = e.payload || {};
    const m = e.machine_id;
    const buffered = !!e.buffered;
    db.run(`INSERT INTO raw_events (event_id, machine_id, device_id, type, device_time, received_at, seq, buffered, payload, simulated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.event_id, m, e.device_id || null, e.type, t, receivedAt, e.seq ?? null, buffered ? 1 : 0, JSON.stringify(p), e.simulated ? 1 : 0);
    core.ensureMachineState(m);
    let outcome; let terminal;
    switch (e.type) {
      case 'heartbeat':
        core.devices.heartbeat(m, p, t, receivedAt, buffered);
        outcome = 'OK';
        break;
      case 'rfid_tap': {
        const r = core.sessions.handleTap({ machineId: m, uid: String(p.uid || '').trim().toUpperCase(), deviceTime: t, receivedAt, buffered, eventId: e.event_id, simulated: e.simulated });
        outcome = r.outcome; terminal = r;
        break;
      }
      case 'presence':
        outcome = core.presence.handleObservation(m, p, t);
        break;
      case 'camera_status':
        core.presence.handleCameraStatus(m, p.status, p.detail, t);
        outcome = 'OK';
        break;
      case 'cycle_complete':
        outcome = core.stamping.handleCycle(m, p, t, e.event_id, receivedAt, e.simulated);
        break;
      case 'counter_reset':
        outcome = core.stamping.handleCounterReset(m, p, t);
        break;
      case 'sensor_event':
        outcome = core.stamping.handleSensorEvent(m, p, t);
        break;
      case 'controller_state': {
        const st = PHYSICAL.includes(p.physical_state) ? p.physical_state : 'UNKNOWN';
        core.devices.setPhysical(m, st, t);
        if (st === 'ESTOP') core.alerts.raise(m, 'ESTOP', 'critical', `Emergency stop aktif di ${m}`);
        else core.alerts.resolve(m, 'ESTOP');
        outcome = 'OK';
        break;
      }
      case 'power':
        if (p.state === 'lost') core.sessions.powerLost(m, t); else core.sessions.powerRestored(m, t, p.physical_state);
        outcome = 'OK';
        break;
      case 'command_result':
        core.sessions.onCommandResult(p.command_id, p);
        outcome = 'OK';
        break;
      case 'monitoring_gap':
        core.presence.monitoringGap(m, Number(p.from), Number(p.to), p.cause);
        outcome = 'OK';
        break;
    }
    db.run('UPDATE raw_events SET outcome = ? WHERE event_id = ?', outcome || null, e.event_id);
    if (e.type !== 'heartbeat') core.changed(m);
    return { event_id: e.event_id, status: 'accepted', outcome, terminal };
  }

  /** Menerima satu batch kejadian (urutan dipertahankan). */
  function ingest(events) {
    const list = Array.isArray(events) ? events : [events];
    const receivedAt = core.clock.now();
    const results = [];
    for (const e of list) {
      try { results.push(db.tx(() => one(e, receivedAt))); }
      catch (err) { results.push({ event_id: e?.event_id, status: 'error', error: err.message }); }
    }
    return results;
  }

  return { ingest, TYPES };
};
