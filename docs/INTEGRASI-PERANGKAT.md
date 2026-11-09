# Kebutuhan Integrasi Perangkat Fisik

> **Status: BELUM terverifikasi pada perangkat fisik.** Seluruh alur saat ini diuji dengan perangkat virtual (mode simulasi) dan uji otomatis. Integrasi RFID, kamera, sensor, dan PLC wajib ditinjau, dikonfigurasi, dan diuji oleh teknisi mesin sebelum digunakan pada produksi. Sistem ini **tidak** boleh menggantikan interlock, pelindung, tombol stop, atau emergency stop.

## 1. Perangkat per mesin

| Perangkat | Kebutuhan minimum | Catatan |
|---|---|---|
| Perangkat lokal (IPC / mini-PC industri) | Linux, 2 GB RAM, penyimpanan SSD, UPS kecil, NTP | Menjalankan agen (referensi `edge/edge-agent.js`) dan analitik kamera |
| RFID reader | 13,56 MHz (MIFARE) atau 125 kHz, keluaran UID (USB HID/serial/TCP) | UID dikirim sebagai heksadesimal huruf besar |
| Kamera | Kamera IP 1080p, sudut ke area kerja operator | Deteksi orang (bukan wajah) di perangkat lokal; tidak menyimpan video secara default. Logika referensi (deteksi COCO-SSD kelas "person", proporsi kotak di dalam ROI dengan sampel grid, metrik kualitas gambar di kotak area kerja (kecerahan, kontras, ketajaman tepi), ambang keyakinan tanpa pembulatan, status stabil 2 analisis, kirim ulang tiap 10 dtk) ada di `public/js/kamera-demo.js` |
| Terminal | Layar ≥ 10" dengan browser | Buka `/terminal.html?m=Mxx&key=<kunci terminal>` |
| PLC / pengendali | Modbus TCP, OPC UA, atau I/O digital | Lihat daftar sinyal di bawah |

## 2. Sinyal PLC yang perlu disepakati bersama teknisi

| Sinyal | Arah | Keterangan |
|---|---|---|
| `PERMIT_OPERATION` (bit) | Edge → PLC | 1 = operasi diizinkan. **Hanya** syarat tambahan pada rangkaian start; tidak memulai gerakan. PLC wajib me-reset ke 0 setelah daya pulih. |
| `REQUEST_STOP` (bit/pulsa) | Edge → PLC | Permintaan penghentian terkendali di akhir siklus. Bukan pemutusan daya. |
| `SAFE_STOPPED` (bit) | PLC → Edge | 1 = mesin berhenti di posisi aman (ram atas, tidak ada gerakan). Syarat penutupan sesi. |
| `CYCLE_COMPLETE` (tepi naik) | PLC → Edge | Satu pulsa per siklus stamping selesai (mis. ram kembali ke TDC setelah tekan). Tentukan titik deteksi bersama teknisi. |
| `CYCLE_COUNTER` (register 32-bit, retentif) | PLC → Edge | Penghitung siklus non-volatil. Sumber kebenaran untuk deduplikasi. |
| `MACHINE_STATE` (register) | PLC → Edge | RUNNING / STOPPED / IDLE / ESTOP / FAULT. Tanpa sinyal ini, sistem menampilkan "Tidak diketahui". |
| `ESTOP_ACTIVE` (bit) | PLC → Edge | Hanya untuk pemantauan; E-stop tetap hardwired. |

Aturan debounce di perangkat lokal: hanya tepi naik yang stabil ≥ 30 ms; abaikan tepi berikutnya < waktu siklus minimum (mis. 800 ms); sinyal HIGH > 5 detik dilaporkan `sensor_event` `STUCK` dan tidak dihitung berulang. Bila counter PLC tersedia, kirim nilainya pada setiap `cycle_complete` — server menolak nilai yang sama dua kali.

## 3. Protokol perangkat lokal ↔ server

Autentikasi: header `X-Device-Key` (kunci per perangkat lokal; lihat halaman **Status perangkat** sebagai admin untuk rotasi).

### Kirim kejadian
`POST /api/edge/events` — body `{ "events": [ ... ] }` (maks 5000, urut sesuai `seq`).

```json
{
  "event_id": "M01-6f1c…",          // unik, dibuat perangkat (UUID)
  "machine_id": "M01",
  "device_id": "M01-EDGE",
  "type": "cycle_complete",
  "device_time": 1794201234567,      // epoch ms jam perangkat
  "seq": 1042,
  "buffered": false,                 // true jika berasal dari antrean offline
  "payload": { "plc_counter": 18234 }
}
```

| `type` | `payload` |
|---|---|
| `heartbeat` | `{ components: { rfid, camera, sensor, controller, terminal: "ok"\|"offline"\|"fault"\|"degraded" } }` setiap 5 detik |
| `rfid_tap` | `{ uid }` |
| `presence` | `{ present, confidence, quality, roi_overlap }` — dikirim saat berubah + berkala |
| `camera_status` | `{ status: "ok"\|"offline"\|"obstructed"\|"unreliable", detail }` |
| `cycle_complete` | `{ plc_counter }` |
| `counter_reset` | `{ new_value, reason }` |
| `sensor_event` | `{ kind: "STUCK"\|"BOUNCE"\|"SENSOR_FAULT"\|"SENSOR_RESTORED", count, detail }` |
| `controller_state` | `{ physical_state }` |
| `power` | `{ state: "lost"\|"restored", physical_state }` |
| `command_result` | `{ command_id, ok, physical_state, safe_state, error }` |
| `monitoring_gap` | `{ from, to, cause }` — bila data kamera hilang (mis. antrean penuh) |

Respons per kejadian: `accepted` (dengan `outcome`, dan `terminal` untuk tap), `duplicate`, atau `rejected`. Perangkat menghapus kejadian dari antrean hanya setelah `accepted`/`duplicate`/`rejected`.

### Ambil perintah
`GET /api/edge/commands` → `{ commands: [{ id, type: "GRANT_PERMISSION"|"REQUEST_STOP"|"REVOKE_PERMISSION", session_id }] }`. Hasil dilaporkan sebagai kejadian `command_result`. Perintah tanpa hasil dalam `command_timeout_s` (default 10 detik) dianggap gagal.

## 4. Perilaku saat koneksi terputus (default — tetapkan bersama teknisi)

* Sesi yang sudah berjalan: PLC mempertahankan bit izin terakhir; operator tetap dapat bekerja dan menghentikan mesin dengan tombol fisik.
* Login baru: **ditolak** di perangkat lokal (tidak ada validasi server). Tap disimpan sebagai catatan dan diberi status `IGNORED_STALE` saat tersinkron.
* Logout saat offline: operator menekan Stop; logout sistem dilakukan setelah koneksi pulih (atau oleh supervisor dengan alasan).
* Kejadian kamera & siklus disimpan lokal lalu disinkronkan; perhitungan memakai `device_time`.
* Bila kebijakan lain dibutuhkan (mis. daftar kartu cache lokal), ubah di agen lokal & dokumentasikan hasil penilaian risikonya.

## 5. Daftar uji komisioning (diisi teknisi)

- [ ] Bit izin tidak dapat memulai gerakan tanpa tombol Start.
- [ ] Stop & E-stop berfungsi dengan perangkat lokal dimatikan / kabel jaringan dicabut.
- [ ] Setelah listrik padam & pulih: bit izin = 0, mesin tidak bergerak sendiri.
- [ ] `REQUEST_STOP` menghentikan mesin di posisi aman; `SAFE_STOPPED` hanya 1 pada kondisi aman.
- [ ] Satu siklus nyata = satu `cycle_complete` (uji 100 siklus, bandingkan counter mekanis).
- [ ] Sinyal tertahan / berulang tidak menambah hitungan.
- [ ] Counter PLC retentif setelah PLC restart.
- [ ] ROI kamera hanya mencakup area kerja operator; orang lewat tidak dihitung (uji dengan halaman Demo deteksi orang memakai rekaman kamera terpasang).
- [ ] Ambang keyakinan & kualitas disetel pada kondisi pencahayaan shift pagi, sore, dan malam.
- [ ] Kamera ditutup / dicabut → "Pemantauan tidak tersedia", bukan ketidakhadiran.
- [ ] Jam perangkat lokal tersinkron NTP (selisih < 2 detik).
- [ ] Antrean lokal bertahan setelah perangkat lokal restart & listrik padam.
- [ ] Pemberitahuan pemantauan dipasang di area kerja dan disosialisasikan kepada pekerja.
