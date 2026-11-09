'use strict';
/**
 * Mengunduh model deteksi objek COCO-SSD (lite_mobilenet_v2, lisensi Apache-2.0) ke
 * public/models/coco-ssd/ agar halaman Demo Deteksi Orang dapat berjalan tanpa internet
 * (mis. jaringan pabrik offline). Tanpa langkah ini, browser memuat model langsung dari
 * storage.googleapis.com.
 *
 * Jalankan: npm run unduh-model
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const OUT = path.join(__dirname, '..', 'public', 'models', 'coco-ssd');

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Gagal mengunduh ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestBuf = await get(`${BASE}model.json`);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));
  const shards = manifest.weightsManifest.flatMap((g) => g.paths);
  let total = manifestBuf.length;
  for (const p of shards) {
    if (!/^[\w.-]+$/.test(p)) throw new Error(`Nama berkas model tidak valid: ${p}`);
    const buf = await get(BASE + p);
    fs.writeFileSync(path.join(OUT, p), buf);
    total += buf.length;
    console.log(`  ${p} (${(buf.length / 1024).toFixed(0)} KB)`);
  }
  // model.json ditulis terakhir: halaman demo hanya memakai model lokal bila berkas ini ada
  fs.writeFileSync(path.join(OUT, 'model.json'), manifestBuf);
  console.log(`Model tersimpan di ${OUT} (${(total / 1048576).toFixed(1)} MB, ${shards.length + 1} berkas).`);
})().catch((e) => { console.error(e.message); process.exit(1); });
