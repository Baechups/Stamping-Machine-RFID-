# Sistem Monitoring Operasional & Produksi — 30 Mesin Stamping (Rangka Kursi Bus)

Aplikasi web berbahasa Indonesia untuk memantau siapa yang bekerja di setiap mesin stamping, memberi izin operasional melalui RFID, mendeteksi keberadaan operator di area kerja melalui kamera (tanpa pengenalan wajah), menghitung siklus stamping aktual dari sinyal PLC/sensor, dan membandingkannya dengan hasil produksi berdasarkan standar produk.

> **Penting.** Data ketidakhadiran dan penyimpangan produksi adalah **indikator untuk pemeriksaan**, bukan bukti otomatis pelanggaran. Setiap penilaian disiplin harus melalui verifikasi supervisor.
>
> **Keselamatan.** Tap RFID hanya memberi *izin operasional*; mesin tetap dijalankan dengan tombol Start sesuai prosedur. Stop & emergency stop selalu berfungsi tanpa kartu. Kamera bukan perangkat keselamatan dan tidak pernah menghentikan mesin. Sistem tidak menggantikan interlock/pelindung. **Integrasi perangkat fisik dan aspek keselamatan belum diverifikasi** — wajib diuji teknisi mesin (lihat [docs/INTEGRASI-PERANGKAT.md](docs/INTEGRASI-PERANGKAT.md)).

## Menjalankan

Kebutuhan: **Node.js ≥ 22.5** (memakai SQLite bawaan `node:sqlite`, tanpa kompilasi native).

```bash
npm install
```

```bash
npm start
```

Buka <http://localhost:3000>. Mode simulasi aktif secara default (perangkat virtual, ditandai jelas di UI). Database dan data contoh dibuat otomatis di `data/stamping.db`.

| Akun contoh | Kata sandi | Peran |
|---|---|---|
| `admin` | `admin123` | Admin |
| `supervisor` | `super123` | Supervisor semua mesin |
| `spv_b` | `super123` | Supervisor Area B (M16–M30) |

Terminal operator: <http://localhost:3000/terminal.html?m=M01> (ganti `M01` … `M30`). Kartu contoh: `04A10001` = OP001 (Shift 1, M01), `04A10031` = OP031 (Shift 2, M01), `04A10061` = OP061 (Shift 3, M01); `04A10098` kartu nonaktif, `04A10099` karyawan nonaktif, `04FFLOST` kartu hilang.

Perintah lain:

```bash
npm test          # 20 skenario verifikasi otomatis
npm run reset-db  # hapus & buat ulang data contoh
SIM_MODE=0 npm start   # mode produksi: tanpa perangkat virtual, API terminal/edge memerlukan kunci perangkat
```

Variabel lingkungan: `PORT` (3000), `DB_PATH` (`data/stamping.db`), `SIM_MODE` (1).

### Mencoba alur dalam mode simulasi
1. Login sebagai `admin` → klik **▶ Jalankan skenario 30 mesin** di banner ungu: operator shift berjalan tap kartu di 30 mesin, memilih pekerjaan, menekan Start; siklus & keberadaan acak berjalan.
2. Klik kartu mesin → **Detail mesin**: timeline, stamping per jam, pekerjaan & hasil, kejadian keberadaan, tindakan supervisor, dan **Panel simulasi** (tap kartu, kamera putus, orang lewat di luar ROI, sinyal memantul/tertahan, reset counter, jaringan putus & sinkronisasi, PLC gagal/timeout/stop tidak aman, listrik padam/pulih, E-stop).
3. Buka terminal mesin di tab lain untuk melihat tampilan operator.
4. **Laporan produksi & penyimpangan** → ekspor Excel/PDF.

## Fitur & halaman

1. Login admin/supervisor · 2. Dashboard 30 mesin · 3. Detail mesin & sesi aktif · 4. Terminal operator · 5. Operator & RFID · 6. Pengaturan 5 shift & penugasan (+ lembur) · 7. Produk, tahap & standar stamping · 8. Work order & hasil produksi · 9. Kamera & area deteksi (editor ROI poligon) · 10. Riwayat sesi & ketidakhadiran · 11. Laporan produksi & penyimpangan (Excel/PDF) · 12. Status perangkat & gangguan · 13. Audit log · 14. Pengaturan sistem (parameter, privasi, retensi, pengguna & kewenangan).

Ringkasan aturan yang diterapkan:

* **Sesi:** satu operator ↔ satu mesin aktif (dijamin indeks unik DB); tap berulang diabaikan; tap terlalu cepat setelah login bukan logout; kartu lain tidak dapat mengganti sesi; pergantian operator via logout atau supervisor (alasan + audit); status kegagalan login/izin/logout ditampilkan jelas; status sesi, izin, dan fisik mesin dipisah ("Tidak diketahui" tanpa umpan balik).
* **Shift 1–5:** dapat diaktif/nonaktifkan, jam bebas (termasuk lewat tengah malam), hari operasional, beberapa istirahat, toleransi terlambat, jendela login awal, batas peringatan "Belum logout", lembur dengan persetujuan, pencegahan tabrakan penugasan, histori versi; sesi menyimpan salinan jadwal yang berlaku.
* **Keberadaan:** ROI per kamera, ambang ketidakhadiran (default 30 dtk), konfirmasi kembali, ambang keyakinan/kualitas/ROI; klasifikasi hadir / tidak hadir / istirahat terjadwal / izin / tidak diketahui; gangguan kamera tidak dihitung sebagai ketidakhadiran; koreksi supervisor dengan alasan, klasifikasi asli tersimpan.
* **Stamping:** hanya dari sinyal PLC/sensor; deduplikasi `event_id` + counter PLC; anomali reset/celah/tertahan/berulang dicatat; kategori normal/setup/uji coba/rework; counter per operator, sesi, mesin, shift, jam, WO, produk & tahap; stamping tanpa sesi dicatat & diberi peringatan tanpa atribusi ke operator sebelumnya.
* **Produksi:** baik/reject (sebelum & sesudah tahap)/rework/WIP, alasan, sumber, status final & verifikasi; standar "X siklus = Y pcs" bertanggal berlaku dengan salinan per pekerjaan; rework yang menjadi baik dihitung sekali; pergantian WO/produk/tahap/kategori memisahkan pencatatan.
* **Analisis:** siklus standar = pcs selesai tahap × siklus standar ÷ pcs standar; selisih & persentase; rasio total stamping/produk baik; status "Sesuai standar", "Perlu ditinjau", "Standar belum tersedia", "Sementara — perlu rekonsiliasi"; dasar pcs dijelaskan; rekonsiliasi WIP/reject belum selesai oleh supervisor.
* **Laporan:** filter tanggal/jam/mesin/operator/shift/WO/produk/klasifikasi; durasi hadir, tidak hadir di luar istirahat & izin, istirahat, izin, pemantauan tidak tersedia; detail kejadian; rekap per jam (kejadian lintas jam dipecah tepat, mis. 09.50–10.10 → 10 mnt + 10 mnt); timeline gabungan keberadaan + stamping dengan penanda "stamping saat tidak terdeteksi"; ekspor Excel & PDF.
* **Keamanan & audit:** kata sandi scrypt, cookie HttpOnly/SameSite, pembatasan percobaan login, kewenangan supervisor per mesin, kunci API per perangkat lokal & terminal, audit log untuk login/logout, konfigurasi, standar, koreksi, dan tindakan supervisor; video tidak disimpan secara default (pengaturan retensi tersedia); pemberitahuan pemantauan tampil di login & terminal.

## Apa yang berfungsi, apa yang disimulasikan

| Bagian | Status |
|---|---|
| Server, database, seluruh logika sesi/izin/keberadaan/stamping/produksi/laporan, hak akses, audit, ekspor | **Berfungsi** dan diuji otomatis (`npm test`) serta lewat antarmuka |
| Antarmuka 14 halaman + terminal operator (desktop & ponsel/tablet) | **Berfungsi** |
| Protokol perangkat lokal (`/api/edge/events`, `/api/edge/commands`, kunci perangkat) | **Berfungsi**; diuji dengan agen referensi terhadap server mode produksi (heartbeat, autentikasi) |
| RFID reader, kamera + analitik deteksi orang, sensor siklus, PLC | **Disimulasikan** (`server/sim/simulator.js`) melalui jalur ingest yang sama dengan perangkat fisik. Data simulasi diberi tanda `simulated=1` dan lencana "Simulasi" |
| Agen perangkat lokal (`edge/edge-agent.js`) | **Referensi**: antrean offline, sinkronisasi, heartbeat, polling perintah berfungsi; **adapter RFID/kamera/PLC masih STUB** dan perlu diimplementasikan |
| Integrasi PLC & keselamatan mesin | **Belum diverifikasi** — memerlukan peninjauan & uji teknisi pada mesin nyata |

## Verifikasi (otomatis, `npm test`)

| # | Skenario | Hasil |
|---|---|---|
| 1 | Login & logout normal (izin menunggu konfirmasi; sesi ditutup setelah kondisi aman) | lulus |
| 2 | Tap ganda & kartu tidak valid / nonaktif / hilang / karyawan nonaktif | lulus |
| 3–4 | Login operator ke dua mesin; tap kartu berbeda saat sesi aktif | lulus |
| 5 | Pergantian operator oleh supervisor (alasan + audit) | lulus |
| 6 | Pergantian shift, shift lewat tengah malam, login setelah tengah malam, tabrakan penugasan | lulus |
| 6b | Pergantian shift operator yang sama (lembur disetujui) tanpa perintah stop | lulus |
| 7 | Shift berakhir tanpa logout → "Belum logout", tanpa penghentian | lulus |
| 8 | Ketidakhadiran singkat (< ambang) & panjang, konfirmasi kembali | lulus |
| 9 | Kejadian lintas batas jam & istirahat (09.25–09.45, 09.50–10.10) | lulus |
| 9b | Izin disetujui & koreksi klasifikasi (asli tetap) | lulus |
| 10 | Kamera putus, deteksi tidak andal, jaringan putus + sinkronisasi buffered | lulus |
| 11 | Perintah pengendali gagal/timeout, logout tidak aman, tutup paksa | lulus |
| 12 | Sinyal ganda, tertahan, celah data, reset counter | lulus |
| 13 | Restart server & sinkronisasi ulang tanpa duplikasi; tanpa izin otomatis | lulus |
| 14 | Stamping tanpa sesi operator | lulus |
| 15 | Pergantian produk/kategori di tengah shift; perubahan standar tidak mengubah histori | lulus |
| 16 | Contoh spesifikasi (A 1:1 → +200% "Perlu ditinjau"; B 3:1 sesuai; C 1:2; tanpa standar; sementara; WIP) + rework tidak dihitung ganda | lulus |
| 17 | Koreksi produksi dengan histori & audit; verifikasi supervisor | lulus |
| 18 | Pemulihan listrik tanpa restart/izin otomatis | lulus |
| 19 | 30 mesin bersamaan (30 sesi, 600 siklus) | lulus |

Antarmuka juga diperiksa dengan browser headless: semua halaman dimuat tanpa error konsol; alur terminal (input hasil, logout + ringkasan, kartu tidak dikenal, izin gagal, login ulang) dan pembatasan supervisor Area B berjalan; tampilan ponsel tanpa scroll horizontal.

## Dokumentasi lanjutan

* [docs/ARSITEKTUR.md](docs/ARSITEKTUR.md) — arsitektur, struktur kode, skema & hubungan data, alur status, pilihan teknologi.
* [docs/INTEGRASI-PERANGKAT.md](docs/INTEGRASI-PERANGKAT.md) — sinyal PLC, protokol perangkat lokal, perilaku offline, daftar uji komisioning.

## Kebutuhan sebelum produksi

1. Implementasi & uji adapter perangkat lokal (RFID, analitik kamera berbasis deteksi orang, PLC) bersama teknisi; isi daftar uji komisioning.
2. Pasang HTTPS (reverse proxy) dan segmentasi jaringan OT/IT; ganti semua kata sandi contoh; jalankan `SIM_MODE=0`.
3. Sinkronisasi NTP untuk server & perangkat lokal.
4. Cadangan database berkala (file SQLite + WAL) atau migrasi ke PostgreSQL bila diperlukan ketersediaan tinggi.
5. Sosialisasi pemberitahuan pemantauan kepada pekerja dan penetapan prosedur verifikasi supervisor bersama HR.
