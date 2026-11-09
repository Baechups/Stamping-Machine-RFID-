# Pustaka pihak ketiga (vendored)

Disertakan langsung agar halaman **Demo deteksi orang** (`/kamera-demo.html`) dapat berjalan di jaringan pabrik tanpa CDN, dan agar instalasi server tidak perlu mengunduh paket TensorFlow.js lengkap (±290 MB) hanya untuk dua berkas browser.

| Berkas | Sumber | Versi | Lisensi |
|---|---|---|---|
| `tf-4.22.0.min.js` | npm `@tensorflow/tfjs`, `dist/tf.min.js` | 4.22.0 | Apache-2.0 (© Google LLC) |
| `coco-ssd-2.2.3.min.js` | npm `@tensorflow-models/coco-ssd`, `dist/coco-ssd.min.js` | 2.2.3 | Apache-2.0 (© Google LLC) |

Teks lisensi: <https://www.apache.org/licenses/LICENSE-2.0>. Header lisensi asli tetap ada di masing-masing berkas.

Bobot model COCO-SSD (`lite_mobilenet_v2`, ±18 MB, Apache-2.0) **tidak** disimpan di repo. Browser memuatnya dari `storage.googleapis.com`, atau dari `public/models/coco-ssd/` setelah menjalankan `npm run unduh-model` (untuk jaringan tanpa internet).
