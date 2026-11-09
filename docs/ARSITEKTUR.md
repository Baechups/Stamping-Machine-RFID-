# Rancangan Arsitektur

## 1. Gambaran umum

```
 ┌──────────────────────────── Lantai produksi (per mesin × 30) ────────────────────────────┐
 │                                                                                           │
 │  RFID reader ─┐                                    ┌─ Tombol START / STOP / E-STOP (fisik) │
 │  Kamera IP ───┤                                    │  Interlock & pelindung (TIDAK diganti)│
 │  Terminal ────┤──► Perangkat lokal (edge) ◄──────► │  PLC / pengendali mesin              │
 │               │    • analitik keberadaan di ROI    │   - bit "izin operasional"           │
 │               │    • debounce sinyal siklus        │   - sinyal "siklus selesai" + counter│
 │               │    • antrean lokal (SQLite)        │   - status fisik (run/stop/e-stop)   │
 │               │    • heartbeat + jam perangkat     └──────────────────────────────────────┘
 └───────────────┼───────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS (LAN pabrik)  POST /api/edge/events · GET /api/edge/commands
 ┌───────────────▼──────────────── Server aplikasi (Node.js) ────────────────────────────────┐
 │  Ingest idempoten ─► Sesi & izin ─► Keberadaan ─► Stamping ─► Produksi ─► Laporan/Ekspor   │
 │  Audit log · Alert · Pengaturan · Hak akses · SSE (pembaruan langsung)                     │
 │  SQLite (WAL) — semua waktu epoch ms UTC, ditampilkan Asia/Jakarta                         │
 └───────────────┬───────────────────────────────────────────────────────────────────────────┘
                 │ HTTPS
   Browser supervisor/admin (dashboard 30 mesin, laporan)   ·   Terminal operator (layar mesin)
```

Prinsip:

* **Keselamatan tetap di PLC.** Server hanya memberi/mencabut *izin operasional* dan meminta *penghentian terkendali*. Tidak ada perintah START. Stop & E-stop terhubung langsung ke rangkaian mesin, tidak melewati sistem ini.
* **Perangkat lokal sebagai penyangga.** Semua kejadian disimpan lokal dahulu, diberi `event_id` unik, lalu dikirim berurutan. Server menolak duplikat sehingga sinkronisasi ulang aman.
* **Waktu ganda.** Setiap kejadian menyimpan `device_time` (waktu perangkat) dan `received_at` (waktu server). Selisih jam dipantau melalui heartbeat.
* **Tiga status terpisah.** `sessions.status` (sesi operator), `sessions.permission_status` (izin operasional), `machine_state.physical_state` (status fisik dari umpan balik PLC; tanpa umpan balik → `UNKNOWN` / "Tidak diketahui").

## 2. Struktur kode

```
server/
  index.js            HTTP server, tik 1 detik, mode simulasi
  core.js             pabrik inti: DB, jam, bus kejadian, pengaturan, audit, alert, layanan
  db.js               skema SQLite + helper transaksi
  seed.js             data contoh (30 mesin, 5 shift, 100 operator, produk, WO)
  lib/time.js         utilitas Asia/Jakarta (UTC+7 tetap)
  lib/intervals.js    partisi interval tanpa durasi ganda (per jam / istirahat / izin)
  services/
    ingest.js         gerbang kejadian idempoten dari perangkat lokal
    sessions.js       alur tap RFID, izin, logout, pergantian shift/operator, daya
    controller.js     antrean perintah ke PLC
    presence.js       mesin status ketidakhadiran berbasis kamera
    stamping.js       penghitungan siklus & anomali counter/sensor
    production.js     standar, hasil produksi, analisis selisih
    shifts.js         5 shift, instans lintas tengah malam, tabrakan penugasan
    devices.js        heartbeat, status komponen, selisih jam
    reports.js        metrik sesi, rekap per jam, timeline, laporan produksi
    dashboard.js      kartu mesin
  routes/api.js       REST API + hak akses
  routes/export.js    ekspor Excel (exceljs) & PDF (pdfkit)
  sim/simulator.js    perangkat virtual (MODE SIMULASI)
edge/edge-agent.js    referensi agen perangkat lokal (store-and-forward) — adapter masih STUB
public/               antarmuka (HTML + JS modul, tanpa build step)
test/                 skenario verifikasi (node:test)
```

## 3. Skema database & hubungan

```
users ─┬─< auth_tokens
       └─< supervisor_machines >── machines ─┬─< devices
                                             ├── camera_config (ROI, parameter)
                                             ├── machine_state (status runtime persisten)
                                             ├─< shift_assignments >── shifts ─< shift_breaks
operators ─┬─< rfid_cards                    │                          └─< shift_versions (histori)
           ├─< operator_machine_permissions >┘
           ├─< overtime_requests, leave_permits
           └─< sessions (shift_snapshot JSON) ─┬─< session_jobs (standard_snapshot JSON) ─── production_results ─< production_result_history
                                               ├─< presence_events ─< presence_corrections
                                               ├─< stamping_events (job_id, kategori)
                                               └─< controller_commands
products ─< process_stages ─< stamping_standards (effective_from/to)
work_orders (produk + tahap)
raw_events (semua kejadian mentah, PK event_id) · tap_events · counter_anomalies · alerts · audit_log · settings · sim_state
```

Batasan integritas penting:

| Aturan | Implementasi |
|---|---|
| Satu sesi aktif per mesin | indeks unik parsial `ux_session_machine_active` |
| Satu sesi aktif per operator | indeks unik parsial `ux_session_operator_active` |
| Satu siklus = satu hitungan | `raw_events.event_id` PK + indeks unik `(machine_id, counter_epoch, plc_counter)` |
| Standar historis tidak berubah | `session_jobs.standard_snapshot` disalin saat pekerjaan dimulai |
| Jadwal historis tidak berubah | `sessions.shift_snapshot` + tabel `shift_versions` |
| Klasifikasi asli tidak hilang | `presence_events.classification` tidak pernah ditimpa; koreksi di kolom terpisah + `presence_corrections` |
| Koreksi produksi terlacak | `production_result_history` (versi lama) + `audit_log` |

## 4. Alur status

### 4.1 Login / izin / logout

```
tap kartu ──► validasi (kartu, karyawan, debounce, sesi mesin, sesi operator, izin mesin,
              koneksi pengendali, daya, jadwal shift/lembur)
   │ gagal ──► REJECTED_* (pesan jelas di terminal), tidak ada sesi
   ▼
PENDING_PERMISSION (permission=REQUESTED) ── perintah GRANT_PERMISSION ──► PLC
   │ ack OK                     │ ditolak / timeout / server restart
   ▼                            ▼
ACTIVE (GRANTED)            PERMISSION_FAILED (sesi berakhir, mesin tidak diizinkan)
   │ "Login berhasil — operator aktif: [nama]"
   │ tap kartu sama (setelah jeda minimum) / supervisor logout (alasan)
   ▼
LOGOUT_REQUESTED (REVOKE_REQUESTED) ── perintah REQUEST_STOP ──► PLC
   │ kondisi aman dikonfirmasi       │ gagal / tidak aman / timeout
   ▼                                 ▼
CLOSED (ringkasan kerja)         LOGOUT_FAILED (sesi tetap terbuka, alert kritis)
                                     │ tap ulang → LOGOUT_REQUESTED
                                     │ supervisor "tutup paksa" (alasan + konfirmasi cek fisik) → FORCE_CLOSED
```

Tap kartu lain saat sesi aktif → `REJECTED_MACHINE_BUSY` (sesi tidak berubah). Tap berulang < `tap_debounce_s` → diabaikan. Tap kartu sama < `min_session_before_logout_s` setelah login → tidak dianggap logout.

### 4.2 Gangguan

| Kejadian | Perilaku |
|---|---|
| Daya padam | `physical_state=POWER_OFF`, izin `SUSPENDED`. Sesi tetap tercatat. |
| Daya pulih | Status fisik `STOPPED`, izin **tetap** `SUSPENDED`; tidak ada perintah otomatis. Operator tap kartunya → `REPERMIT_PENDING` → konfirmasi PLC → `GRANTED`, lalu Start manual. |
| Perangkat lokal tanpa heartbeat | Edge `offline`, komponen & status fisik "Tidak diketahui". Sesi tidak diputus. Evaluasi keberadaan ditunda sampai data tersinkron. |
| Tap tersimpan offline | Dicatat sebagai `IGNORED_STALE`; tidak memberi izin/logout. |
| Kamera putus/tertutup/kualitas rendah | Kejadian `MONITORING_UNAVAILABLE` (bukan ketidakhadiran). |
| Shift berakhir tanpa logout | Penanda & alert "Belum logout" setelah batas toleransi; mesin tidak dihentikan. |
| Server restart | Perintah yang belum terkonfirmasi ditandai `TIMEOUT` (tidak ada izin otomatis); hitungan dari DB utuh. |

### 4.3 Keberadaan (kamera)

```
hadir ──(tidak ada orang di ROI)──► penghitung sementara
   ▲                                   │ < ambang & orang kembali → batal (bukan kejadian)
   │                                   │ ≥ ambang → ABSENCE dibuat, start = awal tidak terdeteksi
   │                                   ▼
   └──(terkonfirmasi kembali ≥ return_confirm_s; end = saat pertama terlihat)── ABSENCE terbuka
kapan pun: kamera tidak andal → ABSENCE ditutup pada saat itu, MONITORING_UNAVAILABLE dibuka
```

Pelaporan memecah kejadian dengan partisi interval: prioritas klasifikasi = koreksi supervisor → pemantauan tidak tersedia → (tidak terdeteksi ∩ istirahat) = istirahat → (∩ izin) = izin → tidak hadir; selain itu hadir. Hasil: `hadir + tidak hadir + istirahat + izin + tidak tersedia = durasi sesi` (diuji otomatis).

## 5. Pilihan teknologi

| Komponen | Pilihan | Alasan singkat |
|---|---|---|
| Server | Node.js 22 + Express | I/O kejadian ringan & banyak, satu bahasa dengan antarmuka, mudah dipelihara |
| Database | SQLite bawaan Node (`node:sqlite`), mode WAL | Tanpa kompilasi native/server terpisah; cukup untuk 30 mesin (≈ ratusan ribu siklus/hari). Skema SQL standar sehingga dapat dipindah ke PostgreSQL bila skala/HA dibutuhkan |
| Antarmuka | HTML + JavaScript modul tanpa build step | Mudah dipasang di jaringan pabrik offline, mudah dipelihara tim TI internal |
| Pembaruan langsung | Server-Sent Events + polling cadangan | Sederhana, melewati proxy, otomatis tersambung ulang |
| Ekspor | exceljs, pdfkit | Pustaka matang, tanpa layanan eksternal |
| Perangkat lokal | Node.js + SQLite antrean (referensi) | Store-and-forward tahan putus jaringan & restart; dapat diganti PC industri/IPC dengan runtime lain selama protokol sama |
| Integrasi PLC | Modbus TCP / OPC UA / I/O digital (ditentukan teknisi) | Umum di mesin stamping; adapter terisolasi di perangkat lokal |
| Uji | `node:test` | Bawaan, tanpa dependensi |
