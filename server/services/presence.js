'use strict';
/**
 * Deteksi keberadaan berbasis kamera (tanpa pengenalan wajah). Identitas berasal dari RFID;
 * kamera hanya memastikan ada orang di area kerja (ROI) mesin.
 *
 * Mesin status per mesin (disimpan di machine_state):
 *   - tidak ada orang → mulai penghitung sementara (absence_pending_since)
 *   - melewati ambang → kejadian ABSENCE dibuat dengan start = awal tidak terdeteksi
 *   - di bawah ambang → tidak dihitung
 *   - orang kembali → return_pending_since; setelah terkonfirmasi selama return_confirm_s, kejadian ditutup
 *     dengan end = saat orang pertama terlihat kembali
 *   - kamera terputus/tertutup/tidak andal → kejadian MONITORING_UNAVAILABLE (bukan ketidakhadiran)
 * Kamera TIDAK pernah menghentikan mesin.
 */
module.exports = function presenceService(core) {
  const { db } = core;

  function params(machineId) {
    const s = core.settings.all();
    const c = db.get('SELECT * FROM camera_config WHERE machine_id = ?', machineId) || {};
    return {
      threshold: (c.absence_threshold_s ?? s.absence_threshold_s) * 1000,
      confirm: (c.return_confirm_s ?? s.return_confirm_s) * 1000,
      minConfidence: c.min_confidence ?? s.min_confidence,
      minQuality: c.min_quality ?? s.min_quality,
      minRoi: c.min_roi_overlap ?? s.min_roi_overlap,
      enabled: c.enabled ?? 1,
    };
  }
  const state = (m) => { core.ensureMachineState(m); return db.get('SELECT * FROM machine_state WHERE machine_id = ?', m); };
  const setState = (m, fields) => {
    const keys = Object.keys(fields);
    db.run(`UPDATE machine_state SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE machine_id = ?`, ...keys.map((k) => fields[k]), m);
  };

  function classifyAt(session, t) {
    const snap = JSON.parse(session.shift_snapshot || '{}');
    if ((snap.breaks || []).some((b) => t >= b.start && t < b.end)) return 'BREAK';
    const lv = db.get("SELECT 1 FROM leave_permits WHERE operator_id = ? AND status = 'active' AND start_at <= ? AND end_at > ?", session.operator_id, t, t);
    if (lv) return 'LEAVE';
    return 'ABSENT';
  }

  function openEvent(m, session, kind, start, classification, cause, simulated) {
    const r = db.run(`INSERT INTO presence_events (machine_id, session_id, operator_id, shift_id, kind, start_at, classification, cause, simulated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, m, session.id, session.operator_id, session.shift_id, kind, start, classification, cause || null, simulated ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    setState(m, { open_presence_event_id: id });
    return id;
  }
  function closeOpen(m, end) {
    const st = state(m);
    if (!st.open_presence_event_id) return null;
    const ev = db.get('SELECT * FROM presence_events WHERE id = ?', st.open_presence_event_id);
    if (ev && ev.end_at == null) {
      const e = Math.max(end, ev.start_at);
      db.run('UPDATE presence_events SET end_at = ?, duration_ms = ? WHERE id = ?', e, e - ev.start_at, ev.id);
    }
    setState(m, { open_presence_event_id: null, return_pending_since: null });
    return ev;
  }
  const openKind = (st) => st.open_presence_event_id ? db.get('SELECT kind FROM presence_events WHERE id = ?', st.open_presence_event_id)?.kind : null;

  /** Memproses berlalunya waktu hingga `now`. */
  function evaluate(m, now) {
    const st = state(m);
    const session = core.sessions.activeByMachine(m);
    if (!session) return;
    const p = params(m);
    if (st.absence_pending_since != null && !st.open_presence_event_id && now - st.absence_pending_since >= p.threshold) {
      const start = Math.max(st.absence_pending_since, session.login_at);
      openEvent(m, session, 'ABSENCE', start, classifyAt(session, start), 'Tidak ada orang terdeteksi di area kerja', session.simulated);
      setState(m, { absence_pending_since: null });
      if (classifyAt(session, start) === 'ABSENT') core.alerts.raise(m, 'ABSENCE', 'info', `Operator tidak terdeteksi di area kerja ${m}`, session.id);
      core.changed(m);
    }
    const st2 = state(m);
    if (st2.open_presence_event_id && openKind(st2) === 'ABSENCE' && st2.return_pending_since != null && now - st2.return_pending_since >= p.confirm) {
      closeOpen(m, st2.return_pending_since);
      core.alerts.resolve(m, 'ABSENCE', session.id);
      core.changed(m);
    }
  }

  function evaluateAll(now) {
    // Mesin dengan perangkat lokal terputus tidak dievaluasi: data kamera akan disinkronkan kemudian
    const rows = db.all(`SELECT ms.machine_id FROM machine_state ms JOIN devices d ON d.machine_id = ms.machine_id AND d.type = 'edge' AND d.status = 'ok'
      WHERE ms.absence_pending_since IS NOT NULL OR ms.return_pending_since IS NOT NULL`);
    for (const r of rows) db.tx(() => evaluate(r.machine_id, now));
  }

  function markUnavailable(m, t, status, cause) {
    const st = state(m);
    const session = core.sessions.activeByMachine(m);
    if (st.open_presence_event_id && openKind(st) === 'ABSENCE') closeOpen(m, t);
    setState(m, { camera_state: status, presence_raw: 'unknown', presence_raw_since: t, absence_pending_since: null, return_pending_since: null });
    const st2 = state(m);
    if (session && !st2.open_presence_event_id) openEvent(m, session, 'MONITORING_UNAVAILABLE', Math.max(t, session.login_at), 'UNKNOWN', cause, session.simulated);
    core.changed(m);
  }
  function markAvailable(m, t) {
    const st = state(m);
    if (st.open_presence_event_id && openKind(st) === 'MONITORING_UNAVAILABLE') closeOpen(m, t);
    setState(m, { camera_state: 'ok', presence_raw: 'unknown', presence_raw_since: t });
  }

  /** Observasi dari analitik kamera di perangkat lokal. obs: { present, confidence, quality, roi_overlap } */
  function handleObservation(m, obs, t) {
    evaluate(m, t);
    const p = params(m);
    const st = state(m);
    const reliable = (obs.quality == null || obs.quality >= p.minQuality) && (obs.confidence == null || obs.confidence >= p.minConfidence);
    if (!reliable) {
      if (st.camera_state !== 'unreliable') markUnavailable(m, t, 'unreliable', `Deteksi tidak andal (kualitas ${obs.quality ?? '-'}, keyakinan ${obs.confidence ?? '-'})`);
      setState(m, { last_observation_at: t, last_quality: obs.quality ?? null });
      return 'UNRELIABLE';
    }
    if (st.camera_state !== 'ok') markAvailable(m, t);
    // Orang yang hanya lewat / sebagian besar di luar ROI tidak dihitung sebagai operator
    const present = !!obs.present && (obs.roi_overlap == null || obs.roi_overlap >= p.minRoi);
    const cur = state(m);
    const session = core.sessions.activeByMachine(m);
    if (present) {
      const f = { absence_pending_since: null, last_observation_at: t, last_quality: obs.quality ?? null };
      if (cur.presence_raw !== 'present') { f.presence_raw = 'present'; f.presence_raw_since = t; }
      if (cur.open_presence_event_id && cur.return_pending_since == null && openKind(cur) === 'ABSENCE') f.return_pending_since = t;
      setState(m, f);
    } else {
      const f = { last_observation_at: t, last_quality: obs.quality ?? null };
      if (cur.presence_raw !== 'absent') {
        f.presence_raw = 'absent'; f.presence_raw_since = t;
        if (cur.open_presence_event_id) f.return_pending_since = null; // keluar lagi sebelum terkonfirmasi kembali
        else if (session) f.absence_pending_since = Math.max(t, session.login_at);
      }
      setState(m, f);
    }
    evaluate(m, t);
    core.changed(m);
    return present ? 'PRESENT' : 'ABSENT';
  }

  function handleCameraStatus(m, status, detail, t) {
    evaluate(m, t);
    if (status === 'ok') { markAvailable(m, t); core.devices.setStatus(m, 'camera', 'ok', detail || 'Normal', t); }
    else {
      const label = { offline: 'Kamera terputus', obstructed: 'Kamera tertutup/terhalang', unreliable: 'Deteksi tidak andal' }[status] || status;
      markUnavailable(m, t, status, detail || label);
      core.devices.setStatus(m, 'camera', status === 'unreliable' ? 'degraded' : status, detail || label, t);
    }
  }

  /** Celah data yang dilaporkan perangkat lokal (mis. buffer penuh) → pemantauan tidak tersedia. */
  function monitoringGap(m, from, to, cause) {
    const s = core.sessions.sessionAt(m, from);
    if (!s) return;
    const start = Math.max(from, s.login_at), end = Math.min(to, s.logout_at || to);
    if (end <= start) return;
    db.run(`INSERT INTO presence_events (machine_id, session_id, operator_id, shift_id, kind, start_at, end_at, duration_ms, classification, cause, simulated)
      VALUES (?, ?, ?, ?, 'MONITORING_UNAVAILABLE', ?, ?, ?, 'UNKNOWN', ?, ?)`, m, s.id, s.operator_id, s.shift_id, start, end, end - start, cause || 'Data kamera hilang', s.simulated);
  }

  /** Dipanggil saat sesi dimulai/berubah. */
  function onSessionChange(m) {
    const session = core.sessions.activeByMachine(m);
    if (!session) return;
    db.tx(() => {
      const st = state(m);
      const now = core.clock.now();
      if (['offline', 'obstructed', 'unreliable'].includes(st.camera_state)) {
        if (!st.open_presence_event_id) openEvent(m, session, 'MONITORING_UNAVAILABLE', session.login_at, 'UNKNOWN', 'Kamera tidak tersedia saat sesi dimulai', session.simulated);
      } else if (st.presence_raw === 'absent' && st.absence_pending_since == null && !st.open_presence_event_id) {
        setState(m, { absence_pending_since: Math.max(session.login_at, st.presence_raw_since || session.login_at) });
      }
      evaluate(m, now);
    });
  }

  function onSessionClosed(m, sessionId, at) {
    const st = state(m);
    if (st.open_presence_event_id) {
      const ev = db.get('SELECT session_id FROM presence_events WHERE id = ?', st.open_presence_event_id);
      if (!ev || ev.session_id === sessionId) closeOpen(m, at);
    }
    setState(m, { absence_pending_since: null, return_pending_since: null });
    // Kejadian lain dari sesi ini yang masih terbuka (mis. akibat sinkronisasi) ikut ditutup
    db.run('UPDATE presence_events SET end_at = ?, duration_ms = ? - start_at WHERE session_id = ? AND end_at IS NULL', at, at, sessionId);
    core.alerts.resolve(m, 'ABSENCE', sessionId);
  }

  /** Status keberadaan untuk tampilan. */
  function currentStatus(m, now = core.clock.now()) {
    const st = state(m);
    const session = core.sessions.activeByMachine(m);
    if (!session) return { code: 'NO_SESSION', label: 'Tidak ada sesi' };
    if (['offline', 'obstructed', 'unreliable'].includes(st.camera_state)) return { code: 'UNKNOWN', label: 'Tidak diketahui (pemantauan terganggu)' };
    if (!core.devices.edgeOnline(m)) return { code: 'UNKNOWN', label: 'Tidak diketahui (perangkat lokal terputus)' };
    const open = st.open_presence_event_id ? db.get('SELECT * FROM presence_events WHERE id = ?', st.open_presence_event_id) : null;
    if (open && open.kind === 'ABSENCE') {
      const cls = classifyAt(session, now);
      const label = cls === 'BREAK' ? 'Istirahat terjadwal' : cls === 'LEAVE' ? 'Izin disetujui' : 'Tidak terdeteksi';
      return { code: cls === 'ABSENT' ? 'ABSENT' : cls, label, since: open.start_at, ongoing_ms: now - open.start_at, returning: st.return_pending_since != null };
    }
    if (st.absence_pending_since != null) return { code: 'CHECKING', label: 'Tidak terdeteksi (di bawah ambang)', since: st.absence_pending_since, ongoing_ms: now - st.absence_pending_since };
    if (st.presence_raw === 'present') return { code: 'PRESENT', label: 'Hadir' };
    return { code: 'UNKNOWN', label: 'Menunggu data kamera' };
  }

  /** Koreksi klasifikasi oleh supervisor; klasifikasi asli tetap tersimpan. */
  function correct(eventId, newClass, reason, actor) {
    const allowed = ['PRESENT', 'ABSENT', 'BREAK', 'LEAVE', 'UNKNOWN'];
    if (!allowed.includes(newClass)) { const e = new Error('Klasifikasi tidak valid'); e.status = 400; throw e; }
    if (!reason || reason.trim().length < 5) { const e = new Error('Alasan koreksi wajib diisi (minimal 5 karakter)'); e.status = 400; throw e; }
    const ev = db.get('SELECT * FROM presence_events WHERE id = ?', eventId);
    if (!ev) { const e = new Error('Kejadian tidak ditemukan'); e.status = 404; throw e; }
    const now = core.clock.now();
    db.tx(() => {
      db.run('INSERT INTO presence_corrections (presence_event_id, old_classification, new_classification, reason, user_id, at) VALUES (?, ?, ?, ?, ?, ?)',
        ev.id, ev.corrected_classification || ev.classification, newClass, reason, actor?.id ?? null, now);
      db.run("UPDATE presence_events SET corrected_classification = ?, correction_reason = ?, corrected_by = ?, corrected_at = ?, verification_status = 'CORRECTED' WHERE id = ?",
        newClass, reason, actor?.id ?? null, now, ev.id);
      core.audit(actor, 'PRESENCE_CORRECTION', 'presence_event', ev.id, { classification: ev.corrected_classification || ev.classification }, { classification: newClass }, reason);
    });
    return db.get('SELECT * FROM presence_events WHERE id = ?', eventId);
  }
  function verify(eventId, actor, note) {
    const ev = db.get('SELECT * FROM presence_events WHERE id = ?', eventId);
    if (!ev) { const e = new Error('Kejadian tidak ditemukan'); e.status = 404; throw e; }
    db.run("UPDATE presence_events SET verification_status = CASE WHEN corrected_classification IS NULL THEN 'VERIFIED' ELSE 'CORRECTED' END, corrected_by = COALESCE(corrected_by, ?), corrected_at = COALESCE(corrected_at, ?) WHERE id = ?", actor?.id ?? null, core.clock.now(), eventId);
    core.audit(actor, 'PRESENCE_VERIFY', 'presence_event', eventId, null, null, note || null);
  }

  return { params, evaluate, evaluateAll, handleObservation, handleCameraStatus, monitoringGap, onSessionChange, onSessionClosed, currentStatus, correct, verify, classifyAt };
};
