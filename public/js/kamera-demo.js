// Demo deteksi orang: analitik kamera NYATA (TensorFlow.js + COCO-SSD) di browser.
// Meniru peran analitik di perangkat lokal: deteksi "orang" → cek area kerja (ROI) → status → server.
// Tidak ada pengenalan wajah; gambar tidak dikirim maupun disimpan.
import { api, esc, fmtT, fmtDur, badge, STATUS } from './util.js';

const params = new URLSearchParams(location.search);
const machineId = (params.get('m') || 'M01').toUpperCase();
const $ = (id) => document.getElementById(id);

const DETECT_MIN_SCORE = 0.3; // batas atas skor kandidat terendah yang dianalisis ("kurang yakin" = di bawah keyakinan minimum)
const STABLE_N = 2;           // status baru berlaku setelah sama pada 2 analisis berturut-turut
const KEEPALIVE_MS = 10000;   // status yang sama dikirim ulang berkala (seperti perangkat lokal)
const MIN_INTERVAL_MS = 450;  // ±2 analisis per detik (dengan akselerasi WebGL)
const MAX_CANVAS_W = 1280;
const QW = 160;               // lebar sampel untuk menilai kualitas gambar area kerja
const FULL_ROI = [[0, 0], [1, 0], [1, 1], [0, 1]];
// Dipakai bila parameter mesin tidak dapat dimuat (mis. mode produksi tanpa login): analisis tetap tampil lokal
const DEFAULT_CAM = { roi: FULL_ROI, min_confidence: 0.6, min_quality: 0.5, min_roi_overlap: 0.3, absence_threshold_s: 30, return_confirm_s: 5, enabled: true };

const STATES = {
  PRESENT: { cls: 'st-present', ico: '👤', title: 'Orang terdeteksi di area kerja', key: 'present' },
  OUTSIDE: { cls: 'st-outside', ico: '🚶', title: 'Orang terlihat di luar area kerja — tidak dihitung', key: 'absent' },
  EMPTY: { cls: 'st-empty', ico: '∅', title: 'Tidak ada orang di area kerja', key: 'absent' },
  UNCERTAIN: { cls: 'st-uncertain', ico: '❔', title: 'Deteksi kurang yakin', key: 'unreliable' },
  UNRELIABLE: { cls: 'st-unreliable', ico: '⚠', title: 'Gambar area kerja tidak andal (gelap / buram / tertutup)', key: 'unreliable' },
};
const KEY_LABEL = { present: 'ada orang di area kerja', absent: 'tidak ada orang di area kerja', unreliable: 'deteksi tidak andal' };
const OUTCOME_LABEL = { PRESENT: 'Hadir', ABSENT: 'Tidak ada orang', UNRELIABLE: 'Tidak andal → pemantauan tidak tersedia', queued: 'disimpan di antrean lokal (jaringan terputus)' };
const COLORS = { in: '#22a559', out: '#f59e0b', weak: '#94a3b8' };
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// Keyakinan dibulatkan ke BAWAH untuk tampilan, agar mis. 59,8% tidak tampil "60%" padahal di bawah minimum 60%
const pctScore = (v) => (v == null ? '—' : `${Math.floor(v * 100)}%`);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

const st = {
  info: null, term: null, cam: null, model: null, backend: '', modelSource: '',
  source: null, loopToken: 0, startToken: 0, lastDet: null, inferMs: 0,
  candidate: null, candCount: 0, committed: null, committedObs: null,
  lastSent: null, sending: false, sendPromise: null, sentAny: false, lastServerHtml: '',
};
const view = $('view');
const vctx = view.getContext('2d');
const qc = document.createElement('canvas');
qc.width = QW; qc.height = 120;
const qctx = qc.getContext('2d', { willReadFrequently: true });
const camParams = () => st.cam || DEFAULT_CAM;

// ---------------- Inisialisasi ----------------
async function init() {
  st.info = await api('/public/info').catch(() => ({ simulation: false }));
  $('modeBadge').innerHTML = st.info.simulation
    ? '<span class="badge b-sim">MODE SIMULASI — hasil dikirim ke mesin sebagai data simulasi</span>'
    : '<span class="badge b-warn">Mode produksi — hasil hanya ditampilkan, tidak dikirim ke server</span>';
  $('termLink').href = `/terminal.html?m=${encodeURIComponent(machineId)}`;
  document.title = `Demo Deteksi Orang — ${machineId}`;
  await fillMachines();
  await refreshServer();
  setInterval(refreshServer, 1000);
  try {
    await loadModel();
    setBusy(false);
  } catch (e) {
    console.error(e);
    $('placeholder').innerHTML = `<b>Model deteksi gagal dimuat.</b><br>${esc(e.message)}<br><br>Pastikan browser terhubung ke internet, atau jalankan <code>npm run unduh-model</code> di komputer server agar model tersedia secara lokal.`;
    $('modelInfo').textContent = 'Model tidak tersedia';
  }
}

async function fillMachines() {
  let list;
  try {
    // Daftar mesin hanya untuk pengguna yang login; tanpa login dipakai pola M01–M30 (tanpa permintaan 401)
    const me = await api('/auth/me');
    if (!me.user) throw new Error('belum login');
    list = (await api('/machines')).map((m) => m.id);
  } catch { list = Array.from({ length: 30 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`); }
  if (!list.includes(machineId)) list.unshift(machineId);
  const sel = $('machineSel');
  sel.innerHTML = list.map((id) => `<option ${id === machineId ? 'selected' : ''}>${esc(id)}</option>`).join('');
  sel.onchange = () => { location.search = `?m=${encodeURIComponent(sel.value)}`; };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Berkas ${src} tidak dapat dimuat`));
    document.head.appendChild(s);
  });
}

async function loadModel() {
  $('modelInfo').textContent = 'Memuat pustaka TensorFlow.js…';
  await loadScript('/vendor/tf-4.22.0.min.js');
  await loadScript('/vendor/coco-ssd-2.2.3.min.js');
  let modelUrl = null;
  try {
    const r = await fetch('/models/coco-ssd/model.json', { method: 'HEAD', cache: 'no-store' });
    if (r.ok) modelUrl = '/models/coco-ssd/model.json';
  } catch { /* gunakan internet */ }
  st.modelSource = modelUrl ? 'server lokal' : 'internet';
  const msg = `Memuat model COCO-SSD dari ${modelUrl ? 'server lokal' : 'internet (storage.googleapis.com, ±18 MB)'}…`;
  $('modelInfo').textContent = msg;
  $('placeholder').textContent = msg;
  st.model = await window.cocoSsd.load(modelUrl ? { base: 'lite_mobilenet_v2', modelUrl } : { base: 'lite_mobilenet_v2' });
  st.backend = window.tf.getBackend();
  $('modelInfo').textContent = `Model siap · backend ${st.backend} · sumber ${st.modelSource}`;
  $('placeholder').innerHTML = 'Model siap. Klik <b>Gunakan webcam</b> atau <b>Pilih video atau foto</b>.';
}

// ---------------- Panel server ----------------
async function refreshServer() {
  let html;
  try {
    const d = await api(`/terminal/${encodeURIComponent(machineId)}`);
    st.term = d;
    st.cam = d.camera;
    html = serverHtml(d);
    $('srvTime').textContent = `diperbarui ${fmtT(d.now)}`;
  } catch (e) {
    html = e.status === 401
      ? '<div class="notice warn">Mode produksi: <a href="/">login sebagai admin/supervisor</a> terlebih dahulu untuk melihat data mesin. Analisis kamera tetap ditampilkan dengan parameter bawaan.</div>'
      : e.status === 403 ? `<div class="notice bad">${esc(e.message)}</div>`
        : `<div class="notice bad">Data mesin tidak dapat dimuat: ${esc(e.message)}</div>`;
  }
  // Hanya ditulis ulang bila berubah, agar fokus keyboard pada tautan di panel tidak hilang
  if (html !== st.lastServerHtml) { $('server').innerHTML = html; st.lastServerHtml = html; }
}

function eventLabel(e) {
  const corr = e.corrected_classification;
  const tag = corr ? ' (dikoreksi)' : '';
  if (corr === 'PRESENT') return badge('ok', 'Hadir (dikoreksi)');
  if (corr === 'UNKNOWN' || (!corr && e.kind === 'MONITORING_UNAVAILABLE')) return badge('muted', `Pemantauan tidak tersedia${tag}`);
  const cls = corr || e.classification;
  if (cls === 'BREAK') return badge('info', `Istirahat terjadwal${tag}`);
  if (cls === 'LEAVE') return badge('info', `Izin${tag}`);
  return badge('bad', `Tidak terdeteksi${tag}`);
}

function serverHtml(d) {
  const c = d.card, s = c.session, cam = d.camera, p = c.presence;
  const [tone] = STATUS.presence[p.code] || ['muted'];
  let h = '';
  if (!s) {
    h += `<div class="notice warn">Belum ada operator aktif di <b>${esc(machineId)}</b>. Ketidakhadiran hanya dicatat selama sesi kerja. Login dengan tap kartu di <a href="/terminal.html?m=${encodeURIComponent(machineId)}" target="_blank" rel="noopener">terminal mesin</a>${st.info?.simulation ? ' (panel simulasi), atau jalankan skenario 30 mesin dari dashboard' : ''}.</div>`;
  } else {
    h += `<div><b>${esc(s.operator_name)}</b> <span class="muted">${esc(s.operator_id)} · ${esc(s.shift_name || '')}</span> ${s.simulated ? '<span class="badge b-sim">Simulasi</span>' : ''}</div>`;
  }
  h += `<div style="margin-top:8px">Status keberadaan: ${badge(tone, p.label)} ${p.ongoing_ms != null ? `<b>${fmtDur(p.ongoing_ms)}</b>` : ''}</div>`;
  if (p.code === 'CHECKING' && cam) {
    const pctv = Math.min(100, (p.ongoing_ms / (cam.absence_threshold_s * 1000)) * 100);
    h += `<div class="meter" role="progressbar" aria-label="Menuju ambang ketidakhadiran" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pctv)}"><div style="width:${pctv}%"></div></div>
      <div class="small muted">Dicatat sebagai ketidakhadiran bila mencapai ${cam.absence_threshold_s} dtk tanpa orang. Jika orang kembali sebelum itu, tidak dicatat.</div>`;
  }
  if (p.code === 'ABSENT') h += `<div class="small" style="margin-top:4px">${p.returning ? `Orang terlihat kembali — menunggu konfirmasi ${cam?.return_confirm_s ?? 5} dtk sebelum kejadian ditutup.` : 'Kejadian ketidakhadiran sedang berlangsung (waktu mulai = saat orang pertama kali tidak terdeteksi).'}</div>`;
  if (s) h += `<div class="small" style="margin-top:8px">Total tidak terdeteksi sesi ini: <b>${fmtDur(s.absent_total_ms)}</b> (${s.absence_count} kejadian) · Pemantauan tidak tersedia: <b>${fmtDur(s.unknown_ms)}</b></div>`;
  if (d.presence_events?.length) {
    h += `<div class="tbl-scroll"><table class="tbl" style="margin-top:8px"><thead><tr><th>Kejadian</th><th>Mulai</th><th>Selesai</th><th class="num">Durasi</th></tr></thead><tbody>${d.presence_events.map((e) => `<tr><td>${eventLabel(e)}</td><td>${fmtT(e.start_at)}</td><td>${e.end_at ? fmtT(e.end_at) : '<i>berlangsung</i>'}</td><td class="num">${fmtDur(e.end_at ? e.duration_ms : d.now - e.start_at)}</td></tr>`).join('')}</tbody></table></div>`;
  } else if (s) {
    h += '<div class="small muted" style="margin-top:6px">Belum ada kejadian tercatat pada sesi ini.</div>';
  }
  if (cam) h += `<div class="small muted" style="margin-top:8px">Parameter ${esc(machineId)}: ambang ketidakhadiran ${cam.absence_threshold_s} dtk · konfirmasi kembali ${cam.return_confirm_s} dtk · keyakinan minimum ${pct(cam.min_confidence)} · kualitas minimum ${pct(cam.min_quality)} · minimal ${pct(cam.min_roi_overlap)} tubuh di area kerja${cam.enabled ? '' : ' · <b>kamera dinonaktifkan di konfigurasi</b>'}</div>`;
  return h;
}

// ---------------- Status lokal ----------------
/** Judul status berada di live region dan hanya diubah bila berbeda (tidak diumumkan terus-menerus). */
function setStatus(cls, ico, title, detail) {
  $('localStatus').className = `big-status ${cls}`;
  $('localIco').textContent = ico;
  if ($('localTitle').textContent !== title) $('localTitle').textContent = title;
  $('localDetail').textContent = detail;
}
function showError(msg) { setStatus('st-unreliable', '⚠', msg, ''); }

function setBusy(busy) {
  const noModel = !st.model;
  $('camBtn').disabled = busy || noModel;
  $('fileBtn').disabled = busy || noModel;
  $('stopBtn').disabled = !busy && !st.source;
}

// ---------------- Sumber gambar ----------------
async function startWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('Webcam hanya dapat dipakai lewat http://localhost atau https://. Buka halaman ini di komputer yang menjalankan server, atau gunakan file video/foto.');
    return;
  }
  const token = ++st.startToken;
  stopSource(false);
  setBusy(true);
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    if (token !== st.startToken) { stream.getTracks().forEach((t) => t.stop()); return; } // dibatalkan/digantikan
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    if (token !== st.startToken) { stream.getTracks().forEach((t) => t.stop()); return; }
    startSource({ kind: 'webcam', el: v, stream, label: 'Webcam' });
  } catch (e) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (token !== st.startToken) return;
    failStart(e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan akses kamera untuk situs ini di pengaturan browser.'
      : e.name === 'NotFoundError' ? 'Tidak ada kamera yang terdeteksi di perangkat ini.' : `Webcam tidak dapat dibuka: ${e.message}`);
  } finally {
    if (token === st.startToken) setBusy(false);
  }
}

async function startFile(file) {
  const token = ++st.startToken;
  stopSource(false);
  setBusy(true);
  const url = URL.createObjectURL(file);
  try {
    let src;
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.src = url;
      await img.decode();
      src = { kind: 'image', el: img, url, label: file.name };
    } else if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.src = url;
      await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = () => reject(new Error('format video tidak didukung browser ini (gunakan MP4 atau WebM)')); });
      await v.play();
      src = { kind: 'video', el: v, url, label: file.name };
    } else {
      throw new Error('pilih file video atau gambar');
    }
    if (token !== st.startToken) { if (src.kind === 'video') src.el.pause(); URL.revokeObjectURL(url); return; }
    startSource(src);
  } catch (e) {
    URL.revokeObjectURL(url);
    if (token !== st.startToken) return;
    failStart(`File tidak dapat dibuka: ${e.message}`);
  } finally {
    if (token === st.startToken) setBusy(false);
  }
}

/** Sumber gagal dibuka: hentikan demo sepenuhnya (keadaan simulasi mesin dipulihkan bila sudah sempat dikirimi data). */
function failStart(msg) {
  stopSource(true);
  showError(msg);
}

function startSource(src) {
  st.source = src;
  st.lastDet = null; st.candidate = null; st.candCount = 0; st.committed = null; st.committedObs = null; st.lastSent = null;
  $('placeholder').hidden = true;
  view.hidden = false;
  const token = ++st.loopToken;
  setBusy(false);
  requestAnimationFrame(() => render(token));
  detectLoop(token);
}

/** Menghentikan sumber. end=true: demo selesai → kondisi kamera simulasi mesin dikembalikan seperti sebelum demo. */
function stopSource(end = true, { immediate = false } = {}) {
  st.loopToken++;
  const s = st.source;
  if (s) {
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    if (s.kind === 'video' || s.kind === 'webcam') s.el.pause();
    if (s.url) URL.revokeObjectURL(s.url);
  }
  st.source = null;
  $('stopBtn').disabled = true;
  if (end) {
    endDemo(immediate);
    setStatus('st-idle', '⏸', 'Dihentikan', st.info?.simulation ? 'Kondisi kamera simulasi mesin dikembalikan seperti sebelum demo.' : 'Analisis berhenti.');
    $('persons').innerHTML = '';
  }
}

function endDemo(immediate) {
  if (!st.info?.simulation || !st.sentAny) return;
  st.sentAny = false;
  const fire = () => fetch(`/api/sim/${encodeURIComponent(machineId)}/camera_demo_end`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).catch(() => {});
  // Tunggu kiriman yang sedang berjalan agar tidak tiba setelah pemulihan (kecuali halaman sedang ditutup)
  if (immediate || !st.sendPromise) fire(); else st.sendPromise.finally(fire);
}

// ---------------- Analisis ----------------
function inPoly(px, py, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Proporsi kotak deteksi (koordinat 0..1) yang berada di dalam poligon ROI, dengan sampel grid 10×10. */
function roiOverlap(x, y, w, h, poly) {
  const g = 10; let k = 0;
  for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) if (inPoly(x + ((i + 0.5) * w) / g, y + ((j + 0.5) * h) / g, poly)) k++;
  return k / (g * g);
}
const dims = (el) => [el.videoWidth || el.naturalWidth || el.width, el.videoHeight || el.naturalHeight || el.height];

let maskCache = { key: '', mask: null };
/** Topeng piksel sampel (QW×qh) yang pusatnya berada di dalam poligon ROI; di-cache per ROI & ukuran. */
function roiMask(roi, bx, by, bw, bh, qh) {
  const key = `${JSON.stringify(roi)}|${bx.toFixed(4)}|${by.toFixed(4)}|${bw.toFixed(4)}|${bh.toFixed(4)}|${qh}`;
  if (maskCache.key === key) return maskCache.mask;
  const mask = new Uint8Array(QW * qh);
  let inside = 0;
  for (let y = 0; y < qh; y++) {
    for (let x = 0; x < QW; x++) {
      if (inPoly(bx + ((x + 0.5) / QW) * bw, by + ((y + 0.5) / qh) * bh, roi)) { mask[y * QW + x] = 1; inside++; }
    }
  }
  if (inside < 64) mask.fill(1); // poligon terlalu kecil → nilai seluruh kotak pembatas
  maskCache = { key, mask };
  return mask;
}

/**
 * Kualitas gambar 0..1, dinilai pada piksel di dalam poligon AREA KERJA (bukan seluruh frame), sehingga area kerja
 * yang tertutup tetap terdeteksi walau sisa gambar normal. Nilai = komponen terendah dari:
 * kecerahan (gelap/silau), kontras, dan detail tepi relatif terhadap kontras (buram atau tertutup bidang polos).
 */
function frameQuality(el, roi) {
  const [w, h] = dims(el);
  const xs = roi.map((p) => p[0]), ys = roi.map((p) => p[1]);
  const x0 = clamp01(Math.min(...xs)), x1 = clamp01(Math.max(...xs)), y0 = clamp01(Math.min(...ys)), y1 = clamp01(Math.max(...ys));
  let sx = x0 * w, sy = y0 * h, sw = (x1 - x0) * w, sh = (y1 - y0) * h;
  if (sw < 8 || sh < 8) { sx = 0; sy = 0; sw = w; sh = h; }
  const qh = Math.max(8, Math.min(240, Math.round((QW * sh) / sw)));
  if (qc.height !== qh) qc.height = qh;
  qctx.imageSmoothingEnabled = true;
  qctx.imageSmoothingQuality = 'medium';
  qctx.drawImage(el, sx, sy, sw, sh, 0, 0, QW, qh);
  const d = qctx.getImageData(0, 0, QW, qh).data;
  const n = QW * qh;
  // Hanya piksel di DALAM poligon area kerja yang dinilai (sudut kotak pembatas di luar poligon diabaikan)
  const mask = roiMask(roi, sx / w, sy / h, sw / w, sh / h, qh);
  const L = new Float32Array(n);
  let sum = 0, sum2 = 0, cnt = 0;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    L[i] = l;
    if (mask[i]) { sum += l; sum2 += l * l; cnt++; }
  }
  const mean = sum / cnt, std = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
  let gsum = 0, gcnt = 0;
  for (let y = 0; y < qh; y++) {
    for (let x = 0; x < QW; x++) {
      const i = y * QW + x;
      if (!mask[i]) continue;
      if (x + 1 < QW && mask[i + 1]) { gsum += Math.abs(L[i + 1] - L[i]); gcnt++; }
      if (y + 1 < qh && mask[i + QW]) { gsum += Math.abs(L[i + QW] - L[i]); gcnt++; }
    }
  }
  const grad = gcnt ? gsum / gcnt : 0;
  const parts = [
    ['terlalu gelap', mean < 30 ? mean / 30 : 1],
    ['terlalu terang/silau', mean > 230 ? Math.max(0, 255 - mean) / 25 : 1],
    ['kontras rendah', Math.min(1, std / 24)],
    ['buram atau tertutup', clamp01((grad / (std + 4) - 0.03) / 0.03)],
  ];
  const worst = parts.reduce((a, b) => (b[1] < a[1] ? b : a));
  const q = Math.round(worst[1] * 100) / 100;
  return { q, reason: q < 1 ? worst[0] : '' };
}

function analyze(preds, el) {
  const cam = camParams();
  const [w, h] = dims(el);
  const roi = cam.roi && cam.roi.length >= 3 ? cam.roi : FULL_ROI;
  const persons = preds.filter((p) => p.class === 'person').map((p) => {
    const [x, y, bw, bh] = p.bbox;
    const overlap = roiOverlap(x / w, y / h, bw / w, bh / h, roi);
    return { score: p.score, bbox: p.bbox, overlap, confident: p.score >= cam.min_confidence, inRoi: overlap >= cam.min_roi_overlap };
  }).sort((a, b) => b.score - a.score);
  const { q: quality, reason } = frameQuality(el, roi);
  const inC = persons.filter((p) => p.confident && p.inRoi);
  const inU = persons.filter((p) => !p.confident && p.inRoi);
  const outC = persons.filter((p) => p.confident && !p.inRoi);
  const max = (arr, k) => Math.max(...arr.map((p) => p[k]));
  // Skor & proporsi dikirim TANPA pembulatan, sehingga server membuat keputusan yang sama dengan halaman ini
  // (mis. skor 0,598 tetap "kurang yakin" di server, tidak terbulatkan menjadi 0,60 = yakin).
  let state, obs;
  if (quality < cam.min_quality) { state = 'UNRELIABLE'; obs = { present: false, confidence: null, quality, roi_overlap: null }; }
  else if (inC.length) { state = 'PRESENT'; obs = { present: true, confidence: max(inC, 'score'), quality, roi_overlap: max(inC, 'overlap') }; }
  else if (inU.length) { state = 'UNCERTAIN'; obs = { present: false, confidence: inU[0].score, quality, roi_overlap: inU[0].overlap }; }
  else if (outC.length) { state = 'OUTSIDE'; obs = { present: true, confidence: outC[0].score, quality, roi_overlap: max(outC, 'overlap') }; }
  else { state = 'EMPTY'; obs = { present: false, confidence: null, quality, roi_overlap: null }; }
  return { persons, quality, qualityReason: reason, state, obs, counts: { inC: inC.length, inU: inU.length, outC: outC.length } };
}

async function detectLoop(token) {
  while (token === st.loopToken) {
    const t0 = performance.now();
    const src = st.source;
    const ready = src && (src.kind === 'image' || src.el.readyState >= 2) && dims(src.el)[0] > 0;
    if (ready && st.model) {
      try {
        const minScore = Math.min(DETECT_MIN_SCORE, camParams().min_confidence * 0.5);
        const preds = await st.model.detect(src.el, 20, minScore);
        if (token !== st.loopToken) return;
        st.inferMs = Math.round(performance.now() - t0);
        const res = analyze(preds, src.el);
        st.lastDet = res;
        onResult(res);
      } catch (e) {
        console.error(e);
        $('modelInfo').textContent = `Analisis gagal: ${e.message}`;
      }
    }
    const wait = Math.max(30, MIN_INTERVAL_MS - (performance.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

function onResult(res) {
  if (res.state === st.candidate) st.candCount++; else { st.candidate = res.state; st.candCount = 1; }
  if (st.candCount >= STABLE_N) {
    st.committed = res.state;
    st.committedObs = res.obs;
  }
  renderLocal(res);
  maybeSend();
}

function maybeSend() {
  if (!st.committed || st.sending || !st.source) return;
  const key = STATES[st.committed].key;
  const changed = !st.lastSent || st.lastSent.key !== key;
  if (!changed && Date.now() - st.lastSent.at < KEEPALIVE_MS) return;
  st.sendPromise = send(st.committedObs, key);
}

async function send(obs, key) {
  if (!st.info?.simulation) { st.lastSent = { key, at: Date.now(), outcome: null }; renderSendInfo(); return; }
  st.sending = true;
  const token = st.loopToken;
  try {
    const r = await api(`/sim/${encodeURIComponent(machineId)}/camera_frame`, { method: 'POST', body: obs });
    st.sentAny = true;
    if (token === st.loopToken) st.lastSent = { key, at: Date.now(), outcome: OUTCOME_LABEL[r.outcome] || OUTCOME_LABEL[r.status] || r.outcome || r.status };
  } catch (e) {
    if (token === st.loopToken) st.lastSent = { key: null, at: Date.now(), outcome: `gagal: ${e.message}` };
  } finally {
    st.sending = false;
    renderSendInfo();
  }
}

// ---------------- Tampilan ----------------
function renderSendInfo() {
  const s = st.lastSent;
  if (!st.info?.simulation) { $('sendInfo').textContent = 'Mode produksi: hasil hanya ditampilkan di halaman ini dan tidak dikirim ke server.'; return; }
  $('sendInfo').innerHTML = s ? `Terakhir dikirim ke server ${fmtT(s.at)}: <b>${esc(KEY_LABEL[s.key] || '—')}</b> → ${esc(s.outcome)}` : '';
}

function renderLocal(res) {
  const shown = st.committed || res.state;
  const S = STATES[shown];
  const o = shown === res.state ? res.obs : st.committedObs || res.obs;
  const cam = camParams();
  const qInfo = shown === res.state ? res.qualityReason : '';
  const detail = {
    PRESENT: `Keyakinan ${pctScore(o.confidence)} · ${pct(o.roi_overlap)} tubuh di dalam area kerja`,
    OUTSIDE: `${res.counts.outC} orang terlihat, tetapi di luar area kerja mesin (hanya lewat)`,
    EMPTY: 'Tidak ada orang di dalam area kerja mesin',
    UNCERTAIN: `Kandidat orang dengan keyakinan ${pctScore(o.confidence)} di bawah minimum ${pct(cam.min_confidence)} → dicatat sebagai pemantauan tidak tersedia`,
    UNRELIABLE: `Kualitas gambar area kerja ${pct(o.quality)}${qInfo ? ` (${qInfo})` : ''} di bawah minimum ${pct(cam.min_quality)} → bukan ketidakhadiran`,
  }[shown];
  const pending = st.candidate && st.candidate !== shown ? ` · berubah ke "${STATES[st.candidate].title}"…` : '';
  setStatus(S.cls, S.ico, S.title, detail + pending);
  $('persons').innerHTML = res.persons.slice(0, 8).map((p, i) => {
    const col = p.confident ? (p.inRoi ? COLORS.in : COLORS.out) : COLORS.weak;
    const where = p.inRoi ? 'di area kerja' : 'di luar area';
    return `<li><span class="sw" style="background:${col}" aria-hidden="true"></span>Orang ${i + 1}: keyakinan ${pctScore(p.score)} · ${pct(p.overlap)} di area → ${p.confident ? where : 'kurang yakin'}</li>`;
  }).join('') || '<li class="muted">Tidak ada objek "orang" terdeteksi.</li>';
  $('modelInfo').textContent = `Backend ${st.backend} · analisis ${st.inferMs} ms · kualitas gambar area kerja ${pct(res.quality)}${res.qualityReason ? ` (${res.qualityReason})` : ''} · sumber model ${st.modelSource}`;
  renderSendInfo();
}

function render(token) {
  if (token !== st.loopToken || !st.source) return;
  const el = st.source.el;
  const [w, h] = dims(el);
  if (w && h) {
    const scale = Math.min(1, MAX_CANVAS_W / w);
    const cw = Math.round(w * scale), ch = Math.round(h * scale);
    if (view.width !== cw || view.height !== ch) { view.width = cw; view.height = ch; }
    vctx.drawImage(el, 0, 0, cw, ch);
    const u = cw / 64; // satuan ukuran relatif
    // ROI
    const roi = st.cam?.roi;
    if (roi?.length >= 3) {
      vctx.beginPath();
      roi.forEach(([x, y], i) => (i ? vctx.lineTo(x * cw, y * ch) : vctx.moveTo(x * cw, y * ch)));
      vctx.closePath();
      vctx.fillStyle = 'rgba(56,132,255,0.16)'; vctx.fill();
      vctx.lineWidth = Math.max(2, u * 0.18); vctx.strokeStyle = '#3884ff'; vctx.setLineDash([]); vctx.stroke();
      label(`Area kerja ${machineId}`, roi[0][0] * cw + u * 0.3, roi[0][1] * ch + u * 1.4, '#3884ff', u);
    }
    // Deteksi
    for (const p of st.lastDet?.persons || []) {
      const [x, y, bw, bh] = p.bbox.map((v) => v * scale);
      const col = p.confident ? (p.inRoi ? COLORS.in : COLORS.out) : COLORS.weak;
      vctx.lineWidth = Math.max(2, u * 0.2); vctx.strokeStyle = col;
      vctx.setLineDash(p.confident ? [] : [u * 0.5, u * 0.35]);
      vctx.strokeRect(x, y, bw, bh);
      vctx.setLineDash([]);
      label(`${p.confident ? (p.inRoi ? 'Di area' : 'Di luar area') : 'Kurang yakin'} ${pctScore(p.score)}`, x, Math.max(u * 1.1, y - u * 0.25), col, u);
    }
    label(`${fmtT(Date.now())} WIB · ${st.source.label}`, u * 0.4, ch - u * 0.5, 'rgba(15,23,42,0.75)', u);
  }
  requestAnimationFrame(() => render(token));
}

function label(text, x, y, bg, u) {
  vctx.font = `600 ${Math.max(11, u * 0.8)}px system-ui, sans-serif`;
  const tw = vctx.measureText(text).width, th = Math.max(11, u * 0.8) * 1.35;
  vctx.fillStyle = bg; vctx.fillRect(x, y - th, tw + u * 0.5, th);
  vctx.fillStyle = '#fff'; vctx.fillText(text, x + u * 0.25, y - th * 0.27);
}

// ---------------- Kontrol ----------------
$('camBtn').onclick = startWebcam;
$('fileBtn').onclick = () => $('fileIn').click();
$('fileIn').onchange = (e) => { const f = e.target.files?.[0]; if (f) startFile(f); e.target.value = ''; };
// Berhenti juga membatalkan permintaan webcam/file yang masih menunggu (mis. dialog izin kamera)
$('stopBtn').onclick = () => { st.startToken++; stopSource(true); setBusy(false); };
window.addEventListener('pagehide', () => { st.startToken++; if (st.source || st.sentAny) stopSource(true, { immediate: true }); });
init();
