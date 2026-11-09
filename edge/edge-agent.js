'use strict';
/**
 * REFERENSI agen perangkat lokal (edge) per mesin — store-and-forward.
 * BELUM diuji pada perangkat fisik. Adapter RFID/kamera/PLC di bawah adalah STUB yang harus
 * diganti dan diuji bersama teknisi mesin (lihat docs/INTEGRASI-PERANGKAT.md).
 *
 * Fungsi:
 *  - Menyimpan setiap kejadian ke antrean lokal (SQLite) SEBELUM dikirim → aman saat jaringan putus / listrik padam.
 *  - Mengirim batch berurutan ke server (POST /api/edge/events) dengan event_id unik; server idempoten.
 *  - Mengambil perintah pengendali (GET /api/edge/commands) dan meneruskannya ke PLC, lalu melaporkan hasilnya.
 *  - Heartbeat berkala berisi status komponen & jam perangkat (untuk pemantauan selisih waktu).
 *  - Debounce sinyal siklus: hanya tepi naik yang stabil, dan memakai counter PLC sebagai sumber kebenaran.
 *
 * Konfigurasi lingkungan: SERVER_URL, MACHINE_ID, DEVICE_KEY, QUEUE_DB (default ./edge-queue.db)
 * Jalankan: node --disable-warning=ExperimentalWarning edge/edge-agent.js
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

const SERVER = process.env.SERVER_URL || 'http://localhost:3000';
const MACHINE = process.env.MACHINE_ID || 'M01';
const KEY = process.env.DEVICE_KEY || '';
const db = new DatabaseSync(process.env.QUEUE_DB || `./edge-queue-${MACHINE}.db`);
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`);

let online = false;
const state = { components: { rfid: 'unknown', camera: 'unknown', sensor: 'unknown', controller: 'unknown', terminal: 'ok' } };

function enqueue(type, payload, deviceTime = Date.now()) {
  const ev = { event_id: `${MACHINE}-${crypto.randomUUID()}`, machine_id: MACHINE, device_id: `${MACHINE}-EDGE`, type, device_time: deviceTime, payload };
  db.prepare('INSERT INTO queue (event) VALUES (?)').run(JSON.stringify(ev));
  return ev;
}

async function http(method, path, body) {
  const res = await fetch(`${SERVER}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Device-Key': KEY }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Kirim antrean berurutan; hapus hanya setelah server mengonfirmasi (accepted/duplicate). */
async function flush() {
  const rows = db.prepare('SELECT seq, event FROM queue ORDER BY seq LIMIT 500').all();
  if (!rows.length) return;
  const events = rows.map((r) => { const e = JSON.parse(r.event); if (!online || Date.now() - e.device_time > 3000) e.buffered = true; return e; });
  try {
    const out = await http('POST', '/edge/events', { events });
    online = true;
    const okIds = new Set(out.results.filter((r) => r.status === 'accepted' || r.status === 'duplicate' || r.status === 'rejected').map((r) => r.event_id));
    for (const r of rows) if (okIds.has(JSON.parse(r.event).event_id)) db.prepare('DELETE FROM queue WHERE seq = ?').run(r.seq);
    for (const r of out.results) if (r.terminal) localDisplay(r.terminal.message, r.terminal.level);
  } catch (e) {
    if (online) localDisplay('Jaringan terputus — kejadian disimpan lokal. Login baru tidak dapat diproses.', 'warning');
    online = false;
  }
}

async function pollCommands() {
  if (!online) return;
  try {
    const { commands } = await http('GET', '/edge/commands');
    for (const c of commands) {
      const result = await plc.execute(c); // { ok, physical_state, safe_state, error }
      enqueue('command_result', { command_id: c.id, ...result });
    }
  } catch { /* dicoba lagi */ }
}

function localDisplay(msg, level) { console.log(`[TERMINAL ${MACHINE}] (${level}) ${msg}`); }

// ---------------------- STUB adapter perangkat — WAJIB diganti & diuji ----------------------
const plc = {
  /** Contoh: tulis bit izin ke PLC via Modbus TCP / OPC UA, lalu tunggu umpan balik status aman. */
  async execute(cmd) {
    if (cmd.type === 'GRANT_PERMISSION') return { ok: false, error: 'Adapter PLC belum dikonfigurasi' };
    if (cmd.type === 'REQUEST_STOP') return { ok: false, safe_state: false, error: 'Adapter PLC belum dikonfigurasi' };
    return { ok: false, error: 'Adapter PLC belum dikonfigurasi' };
  },
  lastCounter: Number(db.prepare("SELECT v FROM kv WHERE k = 'plc_counter'").get()?.v || 0),
  /** Dipanggil saat tepi naik sinyal "siklus selesai" yang stabil (debounce ≥ 30 ms, siklus minimum mis. 800 ms). */
  onCycleComplete(counterFromPlc) {
    if (counterFromPlc <= plc.lastCounter && counterFromPlc > 1) return; // sinyal tertahan/berulang
    plc.lastCounter = counterFromPlc;
    db.prepare("INSERT INTO kv (k, v) VALUES ('plc_counter', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(String(counterFromPlc));
    enqueue('cycle_complete', { plc_counter: counterFromPlc });
  },
};
const rfid = { onTap(uid) { if (!online) { localDisplay('Jaringan terputus — login tidak dapat diproses.', 'error'); } enqueue('rfid_tap', { uid }); } };
const camera = { onObservation(o) { enqueue('presence', o); }, onStatus(status, detail) { state.components.camera = status === 'ok' ? 'ok' : status; enqueue('camera_status', { status, detail }); } };
module.exports = { plc, rfid, camera, enqueue };
// ---------------------------------------------------------------------------------------------

if (require.main === module) {
  setInterval(() => enqueue('heartbeat', { components: state.components }), 5000);
  setInterval(flush, 1000);
  setInterval(pollCommands, 500);
  console.log(`Agen lokal ${MACHINE} → ${SERVER} (antrean ${db.prepare('SELECT COUNT(*) AS n FROM queue').get().n})`);
}
