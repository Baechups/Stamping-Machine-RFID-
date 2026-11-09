'use strict';
/**
 * MODE SIMULASI — perangkat virtual per mesin: perangkat lokal (edge) dengan antrean offline,
 * RFID reader, analitik kamera, sensor siklus, dan pengendali/PLC.
 * Semua kejadian simulasi diberi tanda simulated=1 dan melewati jalur ingest yang SAMA
 * dengan perangkat fisik, sehingga logika server teruji tanpa perangkat.
 *
 * Perilaku keselamatan yang ditiru PLC virtual:
 *  - GRANT_PERMISSION hanya mengizinkan; mesin tetap "Siaga" sampai tombol Start ditekan.
 *  - Tombol Stop & E-stop selalu bekerja tanpa kartu RFID.
 *  - Setelah daya pulih, mesin tetap berhenti dan izin hilang (tanpa restart otomatis).
 */
const crypto = require('node:crypto');

function createSimulator(core) {
  const { db } = core;
  const agents = new Map();
  let timer = null;
  let scenario = { running: false, startedAt: null };

  const defaults = (m) => ({
    machine_id: m, online: true, plc_counter: 0, seq: 0, queue: [], last_flushed: [],
    controller_mode: 'ack', controller_link: true, camera: 'ok', present: false, outside_roi: false, quality: 0.92,
    power: 'on', physical: 'STOPPED', permission: false, sensor_stuck: false,
    auto: false, cycle_ms: 5000, next_cycle_at: 0, auto_presence: false, presence_until: 0, local_message: null,
  });

  function load(m) {
    if (agents.has(m)) return agents.get(m);
    const row = db.get('SELECT state FROM sim_state WHERE machine_id = ?', m);
    const st = row ? { ...defaults(m), ...JSON.parse(row.state) } : defaults(m);
    agents.set(m, st);
    return st;
  }
  function save(st) {
    db.run('INSERT INTO sim_state (machine_id, state) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET state = excluded.state', st.machine_id, JSON.stringify(st));
  }

  function emit(st, type, payload = {}, opts = {}) {
    st.seq += 1;
    const ev = { event_id: `${st.machine_id}-${crypto.randomUUID()}`, machine_id: st.machine_id, device_id: `${st.machine_id}-EDGE`, type,
      device_time: opts.device_time ?? core.clock.now(), seq: st.seq, payload, simulated: true };
    if (!st.online) { st.queue.push({ ...ev, buffered: true }); save(st); return { status: 'queued' }; }
    const [r] = core.ingest.ingest([ev]);
    save(st);
    return r;
  }

  function components(st) {
    return {
      rfid: { status: 'ok' },
      terminal: { status: 'ok', detail: 'Layar terminal aktif' },
      camera: { status: st.camera === 'ok' ? 'ok' : st.camera === 'unreliable' ? 'degraded' : st.camera, detail: st.camera === 'ok' ? 'Normal' : undefined },
      sensor: { status: st.sensor_stuck ? 'fault' : 'ok', detail: st.sensor_stuck ? 'Sinyal tertahan' : 'Normal' },
      controller: { status: st.controller_link && st.power === 'on' ? 'ok' : 'offline', detail: st.power !== 'on' ? 'Daya padam' : st.controller_link ? 'Terhubung' : 'Tidak merespons' },
    };
  }
  const heartbeat = (st) => emit(st, 'heartbeat', { components: components(st) });

  function observe(st) {
    if (st.camera !== 'ok') return;
    emit(st, 'presence', { present: st.present, roi_overlap: st.present ? (st.outside_roi ? 0.1 : 0.85) : null, confidence: st.present ? 0.88 : 0.9, quality: st.quality });
  }

  // ---------- Respons pengendali virtual ----------
  core.bus.on('command', (cmd) => {
    const st = load(cmd.machineId);
    if (!st.online || !st.controller_link || st.power !== 'on') return; // tidak ada respons → timeout
    // Hanya perintah yang benar-benar tersimpan (transaksi berhasil) yang dieksekusi
    const row = db.get('SELECT status FROM controller_commands WHERE id = ?', cmd.id);
    if (!row || row.status !== 'PENDING') return;
    db.run("UPDATE controller_commands SET status = 'SENT', sent_at = ? WHERE id = ?", core.clock.now(), cmd.id);
    if (st.controller_mode === 'timeout') return;
    setTimeout(() => {
      const fail = st.controller_mode === 'fail';
      let result;
      if (cmd.type === 'GRANT_PERMISSION') {
        if (fail) result = { ok: false, error: 'Ditolak PLC (interlock/pelindung belum tertutup)' };
        else { st.permission = true; if (st.physical === 'STOPPED') st.physical = 'IDLE'; result = { ok: true, physical_state: st.physical }; }
      } else if (cmd.type === 'REQUEST_STOP') {
        if (fail) result = { ok: false, error: 'PLC menolak perintah stop' };
        else if (st.controller_mode === 'unsafe') result = { ok: false, safe_state: false, physical_state: st.physical, error: 'Mesin belum berada pada kondisi aman (siklus berjalan)' };
        else { st.permission = false; st.auto = false; st.physical = 'STOPPED'; result = { ok: true, safe_state: true, physical_state: 'STOPPED' }; }
      } else {
        st.permission = false; st.auto = false; if (st.physical === 'RUNNING' || st.physical === 'IDLE') st.physical = 'STOPPED';
        result = { ok: true, physical_state: st.physical };
      }
      emit(st, 'command_result', { command_id: cmd.id, ...result });
      if (result.ok) emit(st, 'controller_state', { physical_state: st.physical });
    }, 400);
  });

  // ---------- Aksi panel simulasi ----------
  const actions = {
    tap(st, { uid }) { return emit(st, 'rfid_tap', { uid }); },
    double_tap(st, { uid }) { const a = emit(st, 'rfid_tap', { uid }); const b = emit(st, 'rfid_tap', { uid }); return [a, b]; },
    presence(st, { present, outside_roi }) { st.present = !!present; st.outside_roi = !!outside_roi; observe(st); return { ok: true }; },
    camera(st, { status }) {
      st.camera = status;
      emit(st, 'camera_status', { status, detail: { offline: 'Kamera terputus (simulasi)', obstructed: 'Lensa tertutup (simulasi)', unreliable: 'Pencahayaan buruk (simulasi)', ok: 'Normal' }[status] });
      if (status === 'ok') observe(st);
      return { ok: true };
    },
    quality(st, { quality }) { st.quality = Number(quality); observe(st); return { ok: true }; },
    /**
     * Hasil analitik kamera NYATA dari halaman Demo Deteksi Orang (model COCO-SSD di browser).
     * Selama demo, keberadaan acak mesin ini dinonaktifkan; data tetap ditandai simulasi.
     * Keadaan kamera simulasi sebelum demo disimpan agar dapat dipulihkan utuh (camera_demo_end).
     */
    camera_frame(st, { present, confidence, quality, roi_overlap }) {
      const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.min(1, Math.max(0, Number(v))));
      if (!st.demo) st.demo = { present: st.present, outside_roi: st.outside_roi, quality: st.quality, camera: st.camera, auto_presence: st.auto_presence };
      st.auto_presence = false;
      if (st.camera !== 'ok') { st.camera = 'ok'; emit(st, 'camera_status', { status: 'ok', detail: 'Normal (demo kamera)' }); }
      const ov = num(roi_overlap);
      st.present = !!present && (ov == null || ov >= core.presence.params(st.machine_id).minRoi);
      return emit(st, 'presence', { present: !!present, confidence: num(confidence), quality: num(quality), roi_overlap: ov, source: 'demo-kamera' });
    },
    /** Demo kamera berhenti: kembalikan keadaan kamera simulasi seperti sebelum demo dan kirim observasinya. */
    camera_demo_end(st) {
      const prev = st.demo;
      if (!prev) return { ok: true, restored: false };
      st.demo = null;
      Object.assign(st, { present: prev.present, outside_roi: prev.outside_roi, quality: prev.quality, auto_presence: prev.auto_presence });
      if (prev.camera !== 'ok') {
        st.camera = prev.camera;
        emit(st, 'camera_status', { status: prev.camera, detail: 'Kembali ke kondisi simulasi sebelum demo' });
      } else {
        st.camera = 'ok';
        observe(st);
      }
      return { ok: true, restored: true };
    },
    start(st) {
      if (st.power !== 'on') return { ok: false, error: 'Daya padam' };
      if (st.physical === 'ESTOP') return { ok: false, error: 'E-stop aktif — reset terlebih dahulu' };
      if (!st.permission) return { ok: false, error: 'PLC: izin operasional belum diberikan — Start diblokir' };
      st.physical = 'RUNNING'; st.auto = true; st.next_cycle_at = core.clock.now() + st.cycle_ms;
      emit(st, 'controller_state', { physical_state: 'RUNNING' });
      return { ok: true };
    },
    stop(st) { st.auto = false; if (st.physical === 'RUNNING') st.physical = st.permission ? 'IDLE' : 'STOPPED'; emit(st, 'controller_state', { physical_state: st.physical }); return { ok: true }; },
    estop(st) { st.auto = false; st.physical = 'ESTOP'; emit(st, 'controller_state', { physical_state: 'ESTOP' }); return { ok: true }; },
    estop_reset(st) { if (st.physical === 'ESTOP') { st.physical = st.permission ? 'IDLE' : 'STOPPED'; emit(st, 'controller_state', { physical_state: st.physical }); } return { ok: true }; },
    cycle(st) { st.plc_counter += 1; return emit(st, 'cycle_complete', { plc_counter: st.plc_counter }); },
    bounce(st) {
      // Sinyal memantul 3x dalam <50 ms: perangkat lokal memfilter tepi naik → hanya 1 siklus dikirim
      st.plc_counter += 1;
      emit(st, 'sensor_event', { kind: 'BOUNCE', count: 3, detail: '3 tepi naik dalam 40 ms, 2 difilter' });
      return emit(st, 'cycle_complete', { plc_counter: st.plc_counter });
    },
    resend_counter(st) {
      // Mengirim ulang nilai counter yang sama (mis. sinkronisasi ulang PLC) dengan event_id berbeda
      return emit(st, 'cycle_complete', { plc_counter: st.plc_counter });
    },
    stuck(st, { on }) { st.sensor_stuck = !!on; emit(st, 'sensor_event', { kind: on ? 'STUCK' : 'SENSOR_RESTORED', detail: on ? 'Sinyal HIGH > 5 detik' : 'Sinyal normal' }); return { ok: true }; },
    counter_reset(st) { st.plc_counter = 0; return emit(st, 'counter_reset', { new_value: 0, reason: 'Reset counter PLC (simulasi)' }); },
    network(st, { online }) {
      if (!online) { st.online = false; st.local_message = 'Jaringan terputus — kejadian disimpan lokal. Login baru tidak dapat diproses.'; save(st); return { ok: true }; }
      st.online = true; st.local_message = null;
      const batch = st.queue.splice(0);
      st.last_flushed = batch.slice(-200);
      const results = batch.length ? core.ingest.ingest(batch) : [];
      heartbeat(st);
      save(st);
      return { ok: true, synced: results.length, duplicates: results.filter((r) => r.status === 'duplicate').length };
    },
    resync(st) {
      // Mengirim ulang batch terakhir (mis. perangkat restart dan tidak yakin batch sudah diterima)
      const results = st.last_flushed.length ? core.ingest.ingest(st.last_flushed) : [];
      return { ok: true, resent: results.length, duplicates: results.filter((r) => r.status === 'duplicate').length };
    },
    edge_restart(st) {
      // Restart perangkat lokal: counter PLC & antrean persisten tetap; kejadian terakhir dikirim ulang
      const recent = db.all('SELECT * FROM raw_events WHERE machine_id = ? ORDER BY received_at DESC LIMIT 20', st.machine_id)
        .map((r) => ({ event_id: r.event_id, machine_id: r.machine_id, device_id: r.device_id, type: r.type, device_time: r.device_time, seq: r.seq, payload: JSON.parse(r.payload || '{}'), simulated: true, buffered: true }));
      const results = core.ingest.ingest(recent.reverse());
      heartbeat(st);
      return { ok: true, resent: results.length, duplicates: results.filter((r) => r.status === 'duplicate').length };
    },
    controller_mode(st, { mode }) { st.controller_mode = mode; save(st); return { ok: true }; },
    controller_link(st, { on }) { st.controller_link = !!on; heartbeat(st); return { ok: true }; },
    power(st, { on }) {
      if (!on) { st.power = 'off'; st.auto = false; st.permission = false; st.physical = 'POWER_OFF'; emit(st, 'power', { state: 'lost' }); heartbeat(st); }
      else { st.power = 'on'; st.physical = 'STOPPED'; st.permission = false; st.auto = false; emit(st, 'power', { state: 'restored', physical_state: 'STOPPED' }); heartbeat(st); }
      return { ok: true };
    },
    cycle_ms(st, { ms }) { st.cycle_ms = Math.max(800, Number(ms) || 5000); return { ok: true }; },
    auto_presence(st, { on }) { st.auto_presence = !!on; return { ok: true }; },
  };

  function act(machineId, action, params = {}) {
    if (!db.get('SELECT 1 FROM machines WHERE id = ?', machineId)) { const e = new Error('Mesin tidak dikenal'); e.status = 404; throw e; }
    const st = load(machineId);
    const fn = actions[action];
    if (!fn) { const e = new Error('Aksi simulasi tidak dikenal'); e.status = 400; throw e; }
    const r = fn(st, params);
    save(st);
    core.changed(machineId);
    return r;
  }

  // ---------- Loop simulasi ----------
  let hbCounter = 0;
  function loop() {
    const now = core.clock.now();
    hbCounter++;
    for (const m of db.all('SELECT id FROM machines WHERE active = 1')) {
      const st = load(m.id);
      if (st.online && hbCounter % 5 === 0) heartbeat(st);
      if (st.auto && st.physical === 'RUNNING' && !st.sensor_stuck && now >= st.next_cycle_at) {
        st.plc_counter += 1;
        emit(st, 'cycle_complete', { plc_counter: st.plc_counter });
        st.next_cycle_at = now + st.cycle_ms * (0.7 + Math.random() * 0.6);
      }
      if (st.auto_presence && st.camera === 'ok') {
        if (st.present && Math.random() < 0.004) { st.present = false; st.presence_until = now + (10 + Math.random() * 80) * 1000; observe(st); }
        else if (!st.present && now >= st.presence_until) { st.present = true; observe(st); }
      }
      save(st);
    }
  }

  function start() {
    for (const m of db.all('SELECT id FROM machines')) { const st = load(m.id); if (st.online) heartbeat(st); }
    timer = setInterval(() => { try { loop(); } catch (e) { console.error('[simulasi]', e); } }, 1000);
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  /** Skenario 30 mesin: login operator shift berjalan, pilih pekerjaan, start, siklus otomatis, keberadaan acak. */
  async function runScenario() {
    const now = core.clock.now();
    const insts = core.shifts.instancesAround(now, { includeEarly: true });
    const report = [];
    if (!insts.length) return { ok: false, error: 'Tidak ada shift aktif pada saat ini' };
    const inst = insts.find((i) => now >= i.start) || insts[0];
    const assigns = db.all(`SELECT a.*, c.uid FROM shift_assignments a JOIN rfid_cards c ON c.operator_id = a.operator_id AND c.status = 'active'
      WHERE a.shift_id = ? AND a.active = 1 ORDER BY a.machine_id`, inst.shift_id);
    const wos = db.all("SELECT * FROM work_orders WHERE status = 'open' ORDER BY id");
    scenario = { running: true, startedAt: now, shift: inst.name };
    for (const a of assigns) {
      const st = load(a.machine_id);
      if (!st.online) { st.online = true; }
      st.controller_mode = 'ack'; st.camera = st.camera === 'ok' ? 'ok' : st.camera; st.power = 'on';
      if (st.physical === 'POWER_OFF' || st.physical === 'ESTOP') st.physical = 'STOPPED';
      heartbeat(st);
      st.present = true; observe(st);
      const r = emit(st, 'rfid_tap', { uid: a.uid });
      report.push({ machine: a.machine_id, outcome: r.outcome });
    }
    await new Promise((res) => setTimeout(res, 1200));
    let i = 0;
    for (const a of assigns) {
      const s = core.sessions.activeByMachine(a.machine_id);
      if (!s || s.status !== 'ACTIVE') continue;
      const wo = wos[i++ % wos.length];
      try { core.sessions.selectJob(s.id, { work_order_id: wo.id, category: 'normal' }, { label: 'simulasi' }); } catch { /* abaikan */ }
      const st = load(a.machine_id);
      st.cycle_ms = 3000 + Math.floor(Math.random() * 5000);
      st.auto_presence = true;
      actions.start(st);
      save(st);
    }
    return { ok: true, shift: inst.name, machines: report };
  }

  function stopScenario() {
    for (const m of db.all('SELECT id FROM machines')) { const st = load(m.id); st.auto = false; st.auto_presence = false; if (st.physical === 'RUNNING') { st.physical = st.permission ? 'IDLE' : 'STOPPED'; emit(st, 'controller_state', { physical_state: st.physical }); } save(st); }
    scenario = { running: false };
    return { ok: true };
  }

  function stateOf(machineId) { const st = load(machineId); return { ...st, queue_length: st.queue.length, queue: undefined, last_flushed: undefined }; }
  function cards() {
    return db.all(`SELECT c.uid, c.status, o.id AS operator_id, o.name, o.status AS operator_status FROM rfid_cards c LEFT JOIN operators o ON o.id = c.operator_id ORDER BY o.id LIMIT 400`);
  }

  return { start, stop, act, stateOf, runScenario, stopScenario, cards, scenario: () => scenario, actions };
}

module.exports = { createSimulator };
