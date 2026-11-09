'use strict';
/**
 * Status perangkat per mesin: perangkat lokal (edge), RFID reader, kamera, sensor siklus, pengendali/PLC.
 * Status diturunkan dari heartbeat perangkat lokal. Tanpa heartbeat → "Tidak diketahui".
 */
module.exports = function devicesService(core) {
  const { db } = core;

  function list(machineId) {
    return machineId ? db.all('SELECT * FROM devices WHERE machine_id = ? ORDER BY type', machineId) : db.all('SELECT * FROM devices ORDER BY machine_id, type');
  }
  function byType(machineId) {
    const out = {};
    for (const d of list(machineId)) out[d.type] = d;
    return out;
  }
  function setStatus(machineId, type, status, detail, now = core.clock.now()) {
    const d = db.get('SELECT id, status FROM devices WHERE machine_id = ? AND type = ?', machineId, type);
    if (!d) return;
    if (d.status !== status) {
      db.run('UPDATE devices SET status = ?, status_detail = ?, last_seen = ? WHERE id = ?', status, detail || null, now, d.id);
      const label = { rfid: 'RFID reader', camera: 'Kamera', sensor: 'Sensor siklus', controller: 'Pengendali/PLC', edge: 'Perangkat lokal', terminal: 'Terminal' }[type];
      if (status === 'ok') core.alerts.resolve(machineId, `DEVICE_${type.toUpperCase()}`);
      else if (status !== 'unknown') core.alerts.raise(machineId, `DEVICE_${type.toUpperCase()}`, type === 'controller' || type === 'edge' ? 'critical' : 'warning', `${label} ${machineId}: ${detail || status}`);
      core.audit({ label: `perangkat:${machineId}` }, 'DEVICE_STATUS', 'device', d.id, { status: d.status }, { status, detail });
    } else {
      db.run('UPDATE devices SET last_seen = ?, status_detail = COALESCE(?, status_detail) WHERE id = ?', now, detail || null, d.id);
    }
  }

  /** Heartbeat perangkat lokal: memuat status komponen & jam perangkat. */
  function heartbeat(machineId, payload, deviceTime, receivedAt, buffered) {
    const edge = db.get("SELECT * FROM devices WHERE machine_id = ? AND type = 'edge'", machineId);
    if (!edge) return;
    if (!buffered) {
      const offset = receivedAt - deviceTime; // positif = jam perangkat tertinggal
      db.run('UPDATE devices SET clock_offset_ms = ?, last_seen = ? WHERE id = ?', offset, receivedAt, edge.id);
      const warn = core.settings.get('clock_skew_warn_ms');
      if (Math.abs(offset) > warn) core.alerts.raise(machineId, 'CLOCK_SKEW', 'warning', `Selisih jam perangkat ${machineId} ${Math.round(offset / 1000)} detik — periksa sinkronisasi NTP`);
      else core.alerts.resolve(machineId, 'CLOCK_SKEW');
    }
    if (edge.status !== 'ok') {
      setStatus(machineId, 'edge', 'ok', 'Terhubung', receivedAt);
      core.alerts.resolve(machineId, 'DEVICE_EDGE');
    }
    for (const [type, st] of Object.entries(payload.components || {})) {
      if (type === 'edge') continue;
      setStatus(machineId, type, st.status || st, st.detail, receivedAt);
    }
    if (payload.components?.controller && (payload.components.controller.status || payload.components.controller) !== 'ok') {
      setPhysical(machineId, 'UNKNOWN', receivedAt);
    }
  }

  function setPhysical(machineId, state, at) {
    const ms = db.get('SELECT physical_state FROM machine_state WHERE machine_id = ?', machineId);
    if (ms && ms.physical_state !== state) {
      db.run('UPDATE machine_state SET physical_state = ?, physical_updated_at = ? WHERE machine_id = ?', state, at, machineId);
    }
  }

  function edgeOnline(machineId) {
    const e = db.get("SELECT status FROM devices WHERE machine_id = ? AND type = 'edge'", machineId);
    return e && e.status === 'ok';
  }

  /** Perangkat lokal tanpa heartbeat dalam batas waktu → terputus; komponen & status fisik tidak diketahui. */
  function checkHeartbeats(now) {
    const timeout = core.settings.get('heartbeat_timeout_s') * 1000;
    const stale = db.all("SELECT * FROM devices WHERE type = 'edge' AND status = 'ok' AND (last_seen IS NULL OR last_seen < ?)", now - timeout);
    for (const e of stale) {
      db.tx(() => {
        setStatus(e.machine_id, 'edge', 'offline', 'Tidak ada heartbeat — jaringan terputus', now);
        db.run("UPDATE devices SET status = 'unknown', status_detail = 'Tidak diketahui (perangkat lokal terputus)' WHERE machine_id = ? AND type != 'edge'", e.machine_id);
        setPhysical(e.machine_id, 'UNKNOWN', now);
      });
      core.changed(e.machine_id);
    }
  }

  return { list, byType, setStatus, heartbeat, setPhysical, edgeOnline, checkHeartbeats };
};
