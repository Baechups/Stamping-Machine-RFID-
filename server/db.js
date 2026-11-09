'use strict';
/**
 * Lapisan database: SQLite bawaan Node.js (node:sqlite) — tanpa kompilasi native.
 * Semua waktu disimpan sebagai epoch milidetik (UTC). Tampilan memakai Asia/Jakarta.
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_SESSION_STATES = ['PENDING_PERMISSION', 'ACTIVE', 'LOGOUT_REQUESTED', 'LOGOUT_FAILED'];
const ACTIVE_SQL = `('PENDING_PERMISSION','ACTIVE','LOGOUT_REQUESTED','LOGOUT_FAILED')`;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  area TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

-- Kewenangan supervisor per mesin (kosong = semua mesin)
CREATE TABLE IF NOT EXISTS supervisor_machines (
  user_id INTEGER NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  PRIMARY KEY (user_id, machine_id)
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  type TEXT NOT NULL CHECK (type IN ('edge','rfid','camera','sensor','controller','terminal')),
  name TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  status_detail TEXT,
  last_seen INTEGER,
  clock_offset_ms INTEGER,
  api_key TEXT,
  simulated INTEGER NOT NULL DEFAULT 0,
  config TEXT
);
CREATE INDEX IF NOT EXISTS ix_devices_machine ON devices(machine_id);

-- Konfigurasi kamera & area deteksi (ROI) per mesin
CREATE TABLE IF NOT EXISTS camera_config (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id),
  roi TEXT NOT NULL,                     -- JSON poligon ternormalisasi [[x,y],...] 0..1
  absence_threshold_s INTEGER,           -- null = pakai pengaturan global
  return_confirm_s INTEGER,
  min_confidence REAL,
  min_quality REAL,
  min_roi_overlap REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  employee_no TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  department TEXT,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  can_enter_results INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rfid_cards (
  uid TEXT PRIMARY KEY,
  operator_id TEXT REFERENCES operators(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','lost')),
  issued_at INTEGER,
  revoked_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_cards_operator ON rfid_cards(operator_id);

CREATE TABLE IF NOT EXISTS operator_machine_permissions (
  operator_id TEXT NOT NULL REFERENCES operators(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  PRIMARY KEY (operator_id, machine_id)
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 5),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL,              -- HH:MM waktu Asia/Jakarta
  end_time TEXT NOT NULL,                -- jika <= start_time berarti melewati tengah malam
  days TEXT NOT NULL DEFAULT '1,2,3,4,5,6', -- hari mulai shift, 1=Senin..7=Minggu
  late_tolerance_min INTEGER NOT NULL DEFAULT 10,
  early_login_min INTEGER NOT NULL DEFAULT 30,
  logout_grace_min INTEGER NOT NULL DEFAULT 15,
  overtime_enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS shift_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);

-- Histori jadwal shift (setiap perubahan menyimpan salinan lengkap)
CREATE TABLE IF NOT EXISTS shift_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by INTEGER,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shift_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  valid_from TEXT NOT NULL,              -- YYYY-MM-DD
  valid_to TEXT,                         -- null = tanpa batas
  active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assign_op ON shift_assignments(operator_id);
CREATE INDEX IF NOT EXISTS ix_assign_m ON shift_assignments(machine_id);

CREATE TABLE IF NOT EXISTS overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  shift_id INTEGER REFERENCES shifts(id),
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by INTEGER,
  approved_by INTEGER,
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Izin meninggalkan area kerja yang disetujui supervisor
CREATE TABLE IF NOT EXISTS leave_permits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  session_id TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  approved_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS process_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  UNIQUE (product_id, code)
);

-- Standar stamping: cycles_per_set siklus menghasilkan pcs_per_set pcs
CREATE TABLE IF NOT EXISTS stamping_standards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  stage_id INTEGER NOT NULL REFERENCES process_stages(id),
  cycles_per_set REAL NOT NULL CHECK (cycles_per_set > 0),
  pcs_per_set REAL NOT NULL CHECK (pcs_per_set > 0),
  tolerance_pct REAL NOT NULL DEFAULT 5,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  note TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_orders (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  stage_id INTEGER REFERENCES process_stages(id),
  target_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  due_date TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id),
  operator_id TEXT NOT NULL REFERENCES operators(id),
  card_uid TEXT,
  shift_id INTEGER,
  shift_date TEXT,
  shift_snapshot TEXT,                   -- salinan jadwal shift & istirahat yang berlaku
  login_at INTEGER NOT NULL,
  logout_at INTEGER,
  status TEXT NOT NULL,                  -- PENDING_PERMISSION|ACTIVE|LOGOUT_REQUESTED|LOGOUT_FAILED|CLOSED|PERMISSION_FAILED|FORCE_CLOSED
  permission_status TEXT NOT NULL,       -- REQUESTED|GRANTED|DENIED|SUSPENDED|REVOKE_REQUESTED|REVOKED|NONE
  status_message TEXT,
  end_reason TEXT,
  late_min INTEGER NOT NULL DEFAULT 0,
  overtime_id INTEGER,
  not_logged_out INTEGER NOT NULL DEFAULT 0,
  handover_from TEXT,
  last_tap_at INTEGER,
  closed_by INTEGER,
  summary TEXT,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_machine_active ON sessions(machine_id) WHERE status IN ${ACTIVE_SQL};
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_operator_active ON sessions(operator_id) WHERE status IN ${ACTIVE_SQL};
CREATE INDEX IF NOT EXISTS ix_sessions_login ON sessions(login_at);
CREATE INDEX IF NOT EXISTS ix_sessions_machine ON sessions(machine_id, login_at);

-- Pekerjaan dalam sesi: pergantian WO/produk/tahap/kategori membuat baris baru
CREATE TABLE IF NOT EXISTS session_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  machine_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  work_order_id TEXT REFERENCES work_orders(id),
  product_id TEXT,
  stage_id INTEGER,
  category TEXT NOT NULL CHECK (category IN ('normal','setup','trial','rework')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  standard_id INTEGER,
  standard_snapshot TEXT                 -- salinan standar saat pekerjaan dimulai
);
CREATE INDEX IF NOT EXISTS ix_jobs_session ON session_jobs(session_id);

CREATE TABLE IF NOT EXISTS controller_commands (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('GRANT_PERMISSION','REQUEST_STOP','REVOKE_PERMISSION')),
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|SENT|ACKED|FAILED|TIMEOUT
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  completed_at INTEGER,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_cmd_machine ON controller_commands(machine_id, status);

-- Status runtime per mesin (persisten agar selamat dari restart server)
CREATE TABLE IF NOT EXISTS machine_state (
  machine_id TEXT PRIMARY KEY REFERENCES machines(id),
  physical_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  physical_updated_at INTEGER,
  power_state TEXT NOT NULL DEFAULT 'UNKNOWN',
  plc_counter INTEGER,
  counter_epoch INTEGER NOT NULL DEFAULT 0,
  last_cycle_at INTEGER,
  presence_raw TEXT NOT NULL DEFAULT 'unknown',   -- present|absent|unknown
  presence_raw_since INTEGER,
  absence_pending_since INTEGER,
  return_pending_since INTEGER,
  open_presence_event_id INTEGER,
  camera_state TEXT NOT NULL DEFAULT 'unknown',   -- ok|offline|obstructed|unreliable|unknown
  last_observation_at INTEGER,
  last_quality REAL,
  terminal_message TEXT,
  terminal_level TEXT,
  terminal_message_at INTEGER
);

-- Semua kejadian mentah dari perangkat lokal (idempoten melalui event_id)
CREATE TABLE IF NOT EXISTS raw_events (
  event_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  device_id TEXT,
  type TEXT NOT NULL,
  device_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  seq INTEGER,
  buffered INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  outcome TEXT,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_raw_machine ON raw_events(machine_id, device_time);

CREATE TABLE IF NOT EXISTS tap_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  machine_id TEXT NOT NULL,
  card_uid TEXT NOT NULL,
  operator_id TEXT,
  device_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  message TEXT,
  session_id TEXT,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_tap_machine ON tap_events(machine_id, device_time);

-- Kejadian keberadaan: ABSENCE (tidak terdeteksi) dan MONITORING_UNAVAILABLE
CREATE TABLE IF NOT EXISTS presence_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  session_id TEXT,
  operator_id TEXT,
  shift_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('ABSENCE','MONITORING_UNAVAILABLE')),
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  duration_ms INTEGER,
  classification TEXT NOT NULL,          -- klasifikasi otomatis asli (tidak pernah ditimpa)
  cause TEXT,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED', -- UNVERIFIED|VERIFIED|CORRECTED
  corrected_classification TEXT,
  correction_reason TEXT,
  corrected_by INTEGER,
  corrected_at INTEGER,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_presence_session ON presence_events(session_id);
CREATE INDEX IF NOT EXISTS ix_presence_machine ON presence_events(machine_id, start_at);

CREATE TABLE IF NOT EXISTS presence_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  presence_event_id INTEGER NOT NULL REFERENCES presence_events(id),
  old_classification TEXT,
  new_classification TEXT NOT NULL,
  reason TEXT NOT NULL,
  user_id INTEGER,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS stamping_events (
  event_id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  session_id TEXT,
  operator_id TEXT,
  shift_id INTEGER,
  shift_date TEXT,
  job_id INTEGER,
  work_order_id TEXT,
  product_id TEXT,
  stage_id INTEGER,
  category TEXT NOT NULL,                -- normal|setup|trial|rework|unassigned
  device_time INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  plc_counter INTEGER,
  counter_epoch INTEGER NOT NULL DEFAULT 0,
  no_session INTEGER NOT NULL DEFAULT 0,
  simulated INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_stamp_counter ON stamping_events(machine_id, counter_epoch, plc_counter) WHERE plc_counter IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_stamp_machine ON stamping_events(machine_id, device_time);
CREATE INDEX IF NOT EXISTS ix_stamp_session ON stamping_events(session_id);
CREATE INDEX IF NOT EXISTS ix_stamp_job ON stamping_events(job_id);

-- Reset counter, celah data (kehilangan), sinyal tertahan/berulang, gangguan sensor
CREATE TABLE IF NOT EXISTS counter_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  type TEXT NOT NULL,                    -- RESET|GAP|STUCK|BOUNCE|DUPLICATE|SENSOR_FAULT|SENSOR_RESTORED
  at INTEGER NOT NULL,
  count INTEGER,
  details TEXT,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS ix_anom_machine ON counter_anomalies(machine_id, at);

CREATE TABLE IF NOT EXISTS production_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES session_jobs(id),
  session_id TEXT NOT NULL,
  work_order_id TEXT,
  machine_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  good_qty INTEGER NOT NULL DEFAULT 0,               -- produk baik akhir (termasuk hasil rework yang lolos)
  reject_completed_qty INTEGER NOT NULL DEFAULT 0,   -- reject setelah tahap selesai
  reject_incomplete_qty INTEGER NOT NULL DEFAULT 0,  -- reject sebelum tahap selesai
  rework_qty INTEGER NOT NULL DEFAULT 0,             -- jumlah pcs yang menjalani rework (informasi, tidak ditambahkan ke hasil)
  rework_good_qty INTEGER NOT NULL DEFAULT 0,        -- bagian dari good_qty yang berasal dari rework
  wip_qty INTEGER NOT NULL DEFAULT 0,                -- produk dalam proses
  reject_reasons TEXT,
  rework_reasons TEXT,
  source TEXT NOT NULL CHECK (source IN ('operator','supervisor','sensor')),
  is_final INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED', -- UNVERIFIED|VERIFIED|DISPUTED
  reconciliation_cycles REAL NOT NULL DEFAULT 0,     -- siklus yang direkonsiliasi untuk WIP/reject belum selesai
  deviation_explanation TEXT,
  supervisor_note TEXT,
  entered_by TEXT,
  entered_at INTEGER NOT NULL,
  verified_by INTEGER,
  verified_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS production_result_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  changed_by TEXT,
  changed_at INTEGER NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  ref TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  acknowledged_by INTEGER,
  acknowledged_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts(resolved_at, machine_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  before_data TEXT,
  after_data TEXT,
  reason TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_at ON audit_log(at);

-- Simulator: status perangkat virtual (counter PLC, antrean offline) agar selamat dari restart
CREATE TABLE IF NOT EXISTS sim_state (
  machine_id TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  const api = {
    raw: db,
    get: (sql, ...p) => prep(sql).get(...p),
    all: (sql, ...p) => prep(sql).all(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    exec: (sql) => db.exec(sql),
    /** Transaksi dengan dukungan nesting (savepoint). */
    tx(fn) {
      const sp = `sp${depth}`;
      if (depth === 0) db.exec('BEGIN IMMEDIATE'); else db.exec(`SAVEPOINT ${sp}`);
      depth++;
      try {
        const r = fn();
        depth--;
        if (depth === 0) db.exec('COMMIT'); else db.exec(`RELEASE ${sp}`);
        return r;
      } catch (e) {
        depth--;
        if (depth === 0) db.exec('ROLLBACK'); else db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      }
    },
    close: () => db.close(),
  };
  return api;
}

module.exports = { openDb, ACTIVE_SESSION_STATES, ACTIVE_SQL };
