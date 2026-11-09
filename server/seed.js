'use strict';
/**
 * Data contoh (dapat diedit dari antarmuka): 30 mesin, 5 slot shift, 100 operator + kartu RFID,
 * produk A/B/C/D dengan standar berbeda, work order, pengguna admin & supervisor.
 * Jalankan: npm run reset-db
 */
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const T = require('./lib/time');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}
function verifyPassword(pw, stored) {
  const [, salt, h] = String(stored).split('$');
  if (!salt || !h) return false;
  const c = crypto.scryptSync(pw, salt, 32);
  return crypto.timingSafeEqual(c, Buffer.from(h, 'hex'));
}

const FIRST = ['Agus', 'Budi', 'Cahyo', 'Dedi', 'Eko', 'Fajar', 'Gilang', 'Hendra', 'Indra', 'Joko', 'Kurnia', 'Lukman', 'Made', 'Nanang', 'Oki', 'Putra', 'Rahmat', 'Slamet', 'Teguh', 'Udin',
  'Wahyu', 'Yusuf', 'Zainal', 'Ari', 'Bayu', 'Dimas', 'Rizky', 'Sri', 'Tri', 'Wawan', 'Siti', 'Dewi', 'Rina', 'Yanti', 'Heru', 'Imam', 'Rudi', 'Taufik', 'Yoga', 'Andi'];
const LAST = ['Santoso', 'Prasetyo', 'Wibowo', 'Saputra', 'Hidayat', 'Nugroho', 'Setiawan', 'Kurniawan', 'Firmansyah', 'Gunawan', 'Siregar', 'Pratama', 'Sitompul', 'Lestari', 'Susanto'];

function seed(core, { quiet = false } = {}) {
  const { db } = core;
  const now = core.clock.now();
  const today = T.dateStr(now);
  db.tx(() => {
    // Pengguna
    db.run("INSERT INTO users (username, name, role, password_hash, created_at) VALUES ('admin', 'Administrator Sistem', 'admin', ?, ?)", hashPassword('admin123'), now);
    db.run("INSERT INTO users (username, name, role, password_hash, created_at) VALUES ('supervisor', 'Supervisor Produksi (Semua Area)', 'supervisor', ?, ?)", hashPassword('super123'), now);
    const spvB = db.run("INSERT INTO users (username, name, role, password_hash, created_at) VALUES ('spv_b', 'Supervisor Area B', 'supervisor', ?, ?)", hashPassword('super123'), now);

    // 30 mesin + perangkat
    for (let n = 1; n <= 30; n++) {
      const id = `M${String(n).padStart(2, '0')}`;
      const area = n <= 15 ? 'Area A' : 'Area B';
      db.run('INSERT INTO machines (id, number, name, area) VALUES (?, ?, ?, ?)', id, n, `Stamping ${String(n).padStart(2, '0')}`, area);
      if (n > 15) db.run('INSERT INTO supervisor_machines (user_id, machine_id) VALUES (?, ?)', Number(spvB.lastInsertRowid), id);
      const ip = `10.20.${n <= 15 ? 1 : 2}.${100 + n}`;
      for (const [type, name] of [['edge', 'Perangkat lokal (gateway)'], ['rfid', 'RFID reader 13,56 MHz'], ['camera', 'Kamera IP area kerja'], ['sensor', 'Sensor siklus selesai (PLC input)'], ['controller', 'PLC / pengendali mesin'], ['terminal', 'Layar terminal operator']]) {
        db.run('INSERT INTO devices (id, machine_id, type, name, address, status, api_key, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          `${id}-${type.toUpperCase()}`, id, type, name, type === 'edge' ? ip : `${ip}/${type}`, 'unknown', ['edge', 'terminal'].includes(type) ? crypto.randomBytes(16).toString('hex') : null, core.simulation ? 1 : 0);
      }
      db.run('INSERT INTO camera_config (machine_id, roi, updated_at) VALUES (?, ?, ?)', id, JSON.stringify([[0.25, 0.3], [0.75, 0.3], [0.8, 0.95], [0.2, 0.95]]), now);
      db.run('INSERT INTO machine_state (machine_id) VALUES (?)', id);
    }

    // 100 operator + kartu
    for (let i = 1; i <= 100; i++) {
      const id = `OP${String(i).padStart(3, '0')}`;
      const name = `${FIRST[(i - 1) % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
      const status = i === 99 ? 'inactive' : 'active';
      db.run('INSERT INTO operators (id, employee_no, name, department, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, `KRY-${20000 + i}`, name, 'Produksi Stamping', status, now);
      const uid = `04A1${String(i).padStart(4, '0')}`;
      db.run('INSERT INTO rfid_cards (uid, operator_id, status, issued_at, note) VALUES (?, ?, ?, ?, ?)', uid, id, i === 98 ? 'inactive' : 'active', now, i === 98 ? 'Kartu dinonaktifkan (contoh)' : null);
      for (let n = 1; n <= 30; n++) {
        if (i > 90 && n > 5) continue; // OP091–OP100 hanya berizin di M01–M05 (contoh pembatasan)
        db.run('INSERT INTO operator_machine_permissions (operator_id, machine_id) VALUES (?, ?)', id, `M${String(n).padStart(2, '0')}`);
      }
    }
    db.run("INSERT INTO rfid_cards (uid, operator_id, status, issued_at, note) VALUES ('04FFLOST', 'OP097', 'lost', ?, 'Kartu lama dilaporkan hilang')", now);

    // 5 slot shift (Shift 3 melewati tengah malam; Shift 4 & 5 nonaktif sebagai contoh)
    const shifts = [
      [1, 'Shift 1 (Pagi)', 1, '07:00', '15:00', '1,2,3,4,5,6,7', [['Istirahat pagi', '09:30', '09:40'], ['Istirahat makan', '12:00', '12:30']]],
      [2, 'Shift 2 (Sore)', 1, '15:00', '23:00', '1,2,3,4,5,6,7', [['Istirahat makan', '18:00', '18:30'], ['Istirahat malam', '21:00', '21:10']]],
      [3, 'Shift 3 (Malam)', 1, '23:00', '07:00', '1,2,3,4,5,6,7', [['Istirahat makan', '03:00', '03:30']]],
      [4, 'Shift 4 (Non-shift)', 0, '08:00', '17:00', '1,2,3,4,5', [['Istirahat siang', '12:00', '13:00']]],
      [5, 'Shift 5 (Lembur akhir pekan)', 0, '08:00', '14:00', '7', [['Istirahat', '11:00', '11:30']]],
    ];
    for (const [id, name, en, st, et, days, breaks] of shifts) {
      db.run('INSERT INTO shifts (id, name, enabled, start_time, end_time, days, late_tolerance_min, early_login_min, logout_grace_min, updated_at) VALUES (?, ?, ?, ?, ?, ?, 10, 30, 15, ?)', id, name, en, st, et, days, now);
      for (const [bn, bs, be] of breaks) db.run('INSERT INTO shift_breaks (shift_id, name, start_time, end_time) VALUES (?, ?, ?, ?)', id, bn, bs, be);
      db.run('INSERT INTO shift_versions (shift_id, version, snapshot, changed_at) VALUES (?, 1, ?, ?)', id, JSON.stringify(core.shifts.getShift(id)), now);
    }
    // Penugasan: shift 1 → OP001–030, shift 2 → OP031–060, shift 3 → OP061–090
    for (let s = 1; s <= 3; s++) {
      for (let n = 1; n <= 30; n++) {
        const op = `OP${String((s - 1) * 30 + n).padStart(3, '0')}`;
        db.run('INSERT INTO shift_assignments (shift_id, operator_id, machine_id, valid_from, created_at) VALUES (?, ?, ?, ?, ?)', s, op, `M${String(n).padStart(2, '0')}`, T.addDays(today, -30), now);
      }
    }

    // Produk, tahap, standar
    const products = [
      ['PRD-A', 'Rangka sandaran kursi (Produk A)', [['BND1', 'Bending utama', 1, 1, 5]]],
      ['PRD-B', 'Rangka dudukan kursi (Produk B)', [['BND1', 'Bending 3 titik', 3, 1, 5]]],
      ['PRD-C', 'Braket kaki kursi (Produk C)', [['BND1', 'Bending ganda', 1, 2, 5]]],
      ['PRD-D', 'Pipa pegangan (Produk D — standar belum tersedia)', [['BND1', 'Bending pegangan', null, null, null]]],
    ];
    const stageIds = {};
    for (const [pid, pname, stages] of products) {
      db.run('INSERT INTO products (id, name) VALUES (?, ?)', pid, pname);
      let seq = 1;
      for (const [code, sname, cps, pps, tol] of stages) {
        const r = db.run('INSERT INTO process_stages (product_id, code, name, seq) VALUES (?, ?, ?, ?)', pid, code, sname, seq++);
        stageIds[pid] = Number(r.lastInsertRowid);
        if (cps) db.run('INSERT INTO stamping_standards (product_id, stage_id, cycles_per_set, pcs_per_set, tolerance_pct, effective_from, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          pid, stageIds[pid], cps, pps, tol, T.fromLocal(T.addDays(today, -60)), 'Standar awal (data contoh)', now);
      }
    }
    const ym = today.slice(2, 4) + today.slice(5, 7);
    const wos = [['A', 'PRD-A', 2000], ['B', 'PRD-B', 800], ['C', 'PRD-C', 3000], ['D', 'PRD-D', 500], ['A2', 'PRD-A', 1500], ['B2', 'PRD-B', 600]];
    wos.forEach(([suffix, pid, target], i) => {
      db.run('INSERT INTO work_orders (id, product_id, stage_id, target_qty, due_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        `WO-${ym}-${String(i + 1).padStart(3, '0')}`, pid, stageIds[pid], target, T.addDays(today, 7), `Pesanan contoh ${suffix}`, now);
    });
    core.audit({ label: 'sistem' }, 'SEED', 'system', null, null, { machines: 30, shifts: 5, operators: 100 }, 'Inisialisasi data contoh');
  });
  if (!quiet) console.log('Data contoh dibuat: 30 mesin, 5 shift, 100 operator, 4 produk, 6 work order.');
}

module.exports = { seed, hashPassword, verifyPassword };

if (require.main === module) {
  const { createCore } = require('./core');
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stamping.db');
  if (process.argv.includes('--reset')) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
  const core = createCore({ dbPath, simulation: true });
  seed(core);
  core.db.close();
}
