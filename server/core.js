'use strict';
/**
 * Inti aplikasi: menyatukan database, jam, bus kejadian, pengaturan, audit, alert,
 * dan seluruh layanan domain. Dibuat sebagai pabrik agar dapat diuji (jam & DB terisolasi).
 */
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { openDb } = require('./db');

const DEFAULT_SETTINGS = {
  plant_name: 'PT Contoh Kursi Bus — Lini Stamping',
  tap_debounce_s: 3,                 // tap kartu sama dalam rentang ini diabaikan
  min_session_before_logout_s: 10,   // tap kartu sama terlalu cepat setelah login tidak dianggap logout
  tap_max_age_s: 15,                 // tap yang terlambat diterima (tersimpan offline) tidak memberi izin
  command_timeout_s: 10,             // batas waktu konfirmasi pengendali
  absence_threshold_s: 30,           // ambang ketidakhadiran
  return_confirm_s: 5,               // durasi konfirmasi orang kembali
  min_confidence: 0.6,               // keyakinan deteksi minimum
  min_quality: 0.5,                  // kualitas citra minimum
  min_roi_overlap: 0.3,              // proporsi kotak deteksi yang harus berada di ROI
  heartbeat_timeout_s: 20,           // perangkat lokal dianggap terputus
  clock_skew_warn_ms: 2000,          // peringatan selisih jam perangkat
  stamp_while_absent_tolerance_s: 3, // toleransi sinkronisasi waktu untuk penandaan stamping saat tidak terdeteksi
  operator_can_enter_results: true,
  allow_login_unassigned_machine: false,
  offline_policy: 'keep_session_no_new_login',
  record_video: false,
  video_retention_days: 7,
  data_retention_days: 730,
  monitoring_notice:
    'Area kerja ini dipantau dengan RFID, kamera, dan sinyal mesin untuk mencatat sesi kerja, keberadaan di area kerja (tanpa pengenalan wajah), dan jumlah siklus stamping. Rekaman video tidak disimpan secara default. Data digunakan untuk perencanaan produksi dan pemeriksaan; setiap temuan diverifikasi supervisor sebelum digunakan untuk penilaian. Hubungi HR/supervisor untuk pertanyaan atau koreksi data.',
};

function createCore({ dbPath = ':memory:', clock, simulation = false, controller } = {}) {
  const db = openDb(dbPath);
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const realClock = { now: () => Date.now() };
  const core = { db, bus, clock: clock || realClock, simulation, uid: () => crypto.randomUUID() };

  // ---------- Pengaturan ----------
  core.settings = {
    all() {
      const out = { ...DEFAULT_SETTINGS };
      for (const r of db.all('SELECT key, value FROM settings')) {
        try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
      }
      return out;
    },
    get(key) {
      const r = db.get('SELECT value FROM settings WHERE key = ?', key);
      if (!r) return DEFAULT_SETTINGS[key];
      try { return JSON.parse(r.value); } catch { return r.value; }
    },
    set(key, value) {
      db.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    },
    defaults: DEFAULT_SETTINGS,
  };

  // ---------- Audit log ----------
  core.audit = (actor, action, entity, entityId, before, after, reason, ip) => {
    db.run(
      `INSERT INTO audit_log (at, user_id, actor, action, entity, entity_id, before_data, after_data, reason, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      core.clock.now(), actor?.id ?? null, actor?.name || actor?.label || 'sistem', action, entity || null,
      entityId != null ? String(entityId) : null,
      before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after),
      reason || null, ip || null,
    );
  };

  // ---------- Alert ----------
  core.alerts = {
    /** Membuat alert; jika `dedupe` true dan alert sejenis masih terbuka, tidak membuat ganda. */
    raise(machineId, type, severity, message, ref, dedupe = true) {
      if (dedupe) {
        const ex = db.get("SELECT id FROM alerts WHERE resolved_at IS NULL AND type = ? AND IFNULL(machine_id, '') = IFNULL(?, '') AND IFNULL(ref, '') = IFNULL(?, '')", type, machineId, ref ?? null);
        if (ex) return ex.id;
      }
      const r = db.run('INSERT INTO alerts (machine_id, type, severity, message, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        machineId, type, severity, message, ref ?? null, core.clock.now());
      bus.emit('alert', { machineId, type, severity, message });
      return Number(r.lastInsertRowid);
    },
    resolve(machineId, type, ref) {
      if (ref === undefined) db.run('UPDATE alerts SET resolved_at = ? WHERE resolved_at IS NULL AND type = ? AND machine_id = ?', core.clock.now(), type, machineId);
      else db.run('UPDATE alerts SET resolved_at = ? WHERE resolved_at IS NULL AND type = ? AND machine_id = ? AND ref = ?', core.clock.now(), type, machineId, ref);
    },
  };

  core.changed = (machineId) => bus.emit('machine-changed', machineId);

  core.setTerminal = (machineId, message, level = 'info') => {
    db.run('UPDATE machine_state SET terminal_message = ?, terminal_level = ?, terminal_message_at = ? WHERE machine_id = ?', message, level, core.clock.now(), machineId);
  };

  // ---------- Layanan domain ----------
  core.shifts = require('./services/shifts')(core);
  core.devices = require('./services/devices')(core);
  core.controller = controller || require('./services/controller').createQueueController(core);
  core.sessions = require('./services/sessions')(core);
  core.presence = require('./services/presence')(core);
  core.stamping = require('./services/stamping')(core);
  core.production = require('./services/production')(core);
  core.ingest = require('./services/ingest')(core);
  core.reports = require('./services/reports')(core);
  core.dashboard = require('./services/dashboard')(core);

  /** Tik periodik: konfirmasi ketidakhadiran, timeout perintah, shift berakhir, status perangkat. */
  core.tick = () => {
    const now = core.clock.now();
    core.devices.checkHeartbeats(now);
    core.sessions.checkCommandTimeouts(now);
    core.sessions.checkShiftEnd(now);
    core.presence.evaluateAll(now);
  };

  core.ensureMachineState = (machineId) => {
    db.run('INSERT OR IGNORE INTO machine_state (machine_id) VALUES (?)', machineId);
  };

  /** Dipanggil saat server mulai: perintah yang tertunda saat server mati dianggap gagal (tanpa izin/restart otomatis). */
  core.recoverOnStartup = () => {
    for (const m of db.all('SELECT id FROM machines')) core.ensureMachineState(m.id);
    core.sessions.failPendingCommandsOnStartup();
  };

  return core;
}

module.exports = { createCore, DEFAULT_SETTINGS };
