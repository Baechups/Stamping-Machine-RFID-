'use strict';
/**
 * Penghitungan siklus stamping aktual dari sinyal PLC/sensor "siklus selesai".
 * Tidak pernah diperkirakan dari kamera, durasi kerja, atau jumlah tap RFID.
 *
 * Anti hitungan ganda:
 *  1. event_id unik dari perangkat lokal (sinkronisasi ulang aman)
 *  2. nilai counter PLC unik per (mesin, epoch) — sinyal berulang / tertahan tidak menambah hitungan
 *  3. debounce tepi naik di perangkat lokal (lihat docs/INTEGRASI-PERANGKAT.md)
 * Counter diturunkan dari baris di DB sehingga tetap utuh setelah restart perangkat/server.
 */
module.exports = function stampingService(core) {
  const { db } = core;

  function anomaly(m, type, at, count, details, sessionId) {
    db.run('INSERT INTO counter_anomalies (machine_id, type, at, count, details, session_id) VALUES (?, ?, ?, ?, ?, ?)',
      m, type, at, count ?? null, details ? JSON.stringify(details) : null, sessionId || null);
  }

  function handleCycle(m, payload, t, eventId, receivedAt, simulated) {
    core.ensureMachineState(m);
    const st = db.get('SELECT plc_counter, counter_epoch FROM machine_state WHERE machine_id = ?', m);
    let epoch = st.counter_epoch;
    const counter = payload.plc_counter == null ? null : Number(payload.plc_counter);
    const session = core.sessions.sessionAt(m, t);

    if (counter != null && st.plc_counter != null) {
      if (counter <= st.plc_counter) {
        const exists = db.get('SELECT event_id FROM stamping_events WHERE machine_id = ? AND counter_epoch = ? AND plc_counter = ?', m, epoch, counter);
        if (exists) return 'DUPLICATE_COUNTER';
        const inferredReset = counter <= 1 || st.plc_counter - counter > 1000;
        if (inferredReset) {
          epoch += 1;
          anomaly(m, 'RESET', t, null, { from: st.plc_counter, to: counter, inferred: true }, session?.id);
          core.alerts.raise(m, 'COUNTER_RESET', 'warning', `Counter PLC ${m} ter-reset (${st.plc_counter} → ${counter}) tanpa pemberitahuan`, null, false);
          db.run('UPDATE machine_state SET counter_epoch = ? WHERE machine_id = ?', epoch, m);
        } else {
          anomaly(m, 'LATE_FILL', t, 1, { counter, last: st.plc_counter }, session?.id);
        }
      } else if (counter > st.plc_counter + 1) {
        const gap = counter - st.plc_counter - 1;
        anomaly(m, 'GAP', t, gap, { from: st.plc_counter, to: counter }, session?.id);
        core.alerts.raise(m, 'COUNTER_GAP', 'warning', `Kehilangan data stamping ${m}: ${gap} siklus tanpa detail kejadian (counter ${st.plc_counter} → ${counter})`, null, false);
      }
    }

    let job = null;
    if (session) {
      job = db.get('SELECT * FROM session_jobs WHERE session_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?) ORDER BY started_at DESC LIMIT 1', session.id, t, t);
    }
    const shift = session ? { shift_id: session.shift_id, date: session.shift_date } : core.shifts.machineShiftAt(m, t);
    const category = session ? (job ? job.category : 'unassigned') : 'unassigned';
    try {
      db.run(`INSERT INTO stamping_events (event_id, machine_id, session_id, operator_id, shift_id, shift_date, job_id, work_order_id, product_id, stage_id, category,
        device_time, received_at, plc_counter, counter_epoch, no_session, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId, m, session?.id || null, session?.operator_id || null, shift?.shift_id ?? null, shift?.date ?? null, job?.id || null, job?.work_order_id || null,
      job?.product_id || null, job?.stage_id || null, category, t, receivedAt, counter, epoch, session ? 0 : 1, simulated ? 1 : 0);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return 'DUPLICATE_COUNTER';
      throw e;
    }
    if (counter != null && (st.plc_counter == null || counter > st.plc_counter || epoch !== st.counter_epoch)) {
      db.run('UPDATE machine_state SET plc_counter = ?, last_cycle_at = ? WHERE machine_id = ?', counter, t, m);
    } else {
      db.run('UPDATE machine_state SET last_cycle_at = MAX(IFNULL(last_cycle_at, 0), ?) WHERE machine_id = ?', t, m);
    }
    if (!session) core.alerts.raise(m, 'STAMP_NO_SESSION', 'warning', `Stamping tanpa sesi operator terdeteksi di ${m}`);
    else if (!job) core.alerts.raise(m, 'STAMP_NO_JOB', 'info', `Stamping di ${m} belum memiliki pekerjaan/work order terpilih`, session.id);
    core.changed(m);
    return session ? 'COUNTED' : 'COUNTED_NO_SESSION';
  }

  function handleCounterReset(m, payload, t) {
    core.ensureMachineState(m);
    const st = db.get('SELECT plc_counter, counter_epoch FROM machine_state WHERE machine_id = ?', m);
    db.run('UPDATE machine_state SET counter_epoch = ?, plc_counter = ? WHERE machine_id = ?', st.counter_epoch + 1, payload.new_value ?? 0, m);
    anomaly(m, 'RESET', t, null, { from: st.plc_counter, to: payload.new_value ?? 0, reason: payload.reason || 'Dilaporkan perangkat' }, core.sessions.sessionAt(m, t)?.id);
    core.alerts.raise(m, 'COUNTER_RESET', 'warning', `Counter PLC ${m} di-reset (${payload.reason || 'dilaporkan perangkat'})`, null, false);
    core.audit({ label: `perangkat:${m}` }, 'COUNTER_RESET', 'machine', m, { counter: st.plc_counter }, { counter: payload.new_value ?? 0 }, payload.reason);
    return 'RESET_RECORDED';
  }

  /** Gangguan sensor: sinyal tertahan, berulang (bounce), atau sensor gagal. */
  function handleSensorEvent(m, payload, t) {
    const type = payload.kind || 'SENSOR_FAULT';
    anomaly(m, type, t, payload.count ?? null, payload, core.sessions.sessionAt(m, t)?.id);
    if (type === 'SENSOR_RESTORED') { core.devices.setStatus(m, 'sensor', 'ok', 'Normal', t); core.alerts.resolve(m, 'SENSOR'); return 'SENSOR_OK'; }
    const label = { STUCK: 'Sinyal siklus tertahan (tidak dihitung berulang)', BOUNCE: 'Sinyal berulang difilter', SENSOR_FAULT: 'Sensor siklus gangguan' }[type] || type;
    if (type !== 'BOUNCE') {
      core.devices.setStatus(m, 'sensor', 'fault', label, t);
      core.alerts.raise(m, 'SENSOR', 'warning', `${m}: ${label}`);
    }
    return 'ANOMALY_RECORDED';
  }

  function countsBySession(sessionId) {
    const rows = db.all('SELECT category, COUNT(*) AS n FROM stamping_events WHERE session_id = ? GROUP BY category', sessionId);
    const out = { normal: 0, setup: 0, trial: 0, rework: 0, unassigned: 0, total: 0 };
    for (const r of rows) { out[r.category] = r.n; out.total += r.n; }
    return out;
  }

  return { handleCycle, handleCounterReset, handleSensorEvent, countsBySession };
};
