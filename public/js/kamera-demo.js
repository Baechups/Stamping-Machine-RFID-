// Demo deteksi orang: analitik kamera NYATA (TensorFlow.js + COCO-SSD) di browser.
// Meniru peran analitik di perangkat lokal: deteksi "orang" → cek area kerja (ROI) → status → server.
// Tidak ada pengenalan wajah; gambar tidak dikirim maupun disimpan.
import { api, esc, fmtT, fmtDur, badge, STATUS } from './util.js';

const params = new URLSearchParams(location.search);
const machineId = (params.get('m') || 'M01').toUpperCase();
const $ = (id) => document.getElementById(id);

const DETECT_MIN_SCORE = 0.3; // kandidat terendah yang dianalisis (di bawah keyakinan minimum = "kurang yakin")
const STABLE_N = 2;           // status baru berlaku setelah sama pada 2 analisis berturut-turut
const KEEPALIVE_MS = 10000;   // status yang sama dikirim ulang berkala (seperti perangkat lokal)
const MIN_INTERVAL_MS = 450;  // ±2 analisis per detik
const MAX_CANVAS_W = 1280;

const STATES = {
  PRESENT: { cls: 'st-present', ico: '👤', title: 'Orang terdeteksi di area kerja', key: 'present' },
  OUTSIDE: { cls: 'st-outside', ico: '🚶', title: 'Orang terlihat di luar area kerja — tidak dihitung', key: 'absent' },
  EMPTY: { cls: 'st-empty', ico: '∅', title: 'Tidak ada orang di area kerja', key: 'absent' },
  UNCERTAIN: { cls: 'st-uncertain', ico: '❔', title: 'Deteksi kurang yakin', key: 'unreliable' },
  UNRELIABLE: { cls: 'st-unreliable', ico: '⚠', title: 'Gambar tidak andal (gelap / tertutup / buram)', key: 'unreliable' },
};
const KEY_LABEL = { present: 'ada orang di area kerja', absent: 'tidak ada orang di area kerja', unreliable: 'deteksi tidak andal' };
const OUTCOME_LABEL = { PRESENT: 'Hadir', ABSENT: 'Tidak ada orang', UNRELIABLE: 'Tidak andal → pemantauan tidak tersedia', queued: 'disimpan di antrean lokal (jaringan terputus)' };
const COLORS = { in: '#22a559', out: '#f59e0b', weak: '#94a3b8' };
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
// Keyakinan dibulatkan ke bawah agar mis. 59,8% tidak tampil "60%" padahal di bawah minimum 60%
const pctScore = (v) => (v == null ? '—' : `${Math.floor(v * 100)}%`);

const st = {
  info: null, term: null, cam: null, model: null, backend: '', modelSource: '',
  source: null, loopToken: 0, lastDet: null, inferMs: 0,
  candidate: null, candCount: 0, committed: null, committedObs: null, lastSent: null, sending: false,
  originalAutoPresence: null, // keberadaan acak simulasi sebelum demo dimulai (dipulihkan saat berhenti)
};
const view = $('view');
const vctx = view.getContext('2d');
const qc = document.createElement('canvas');
qc.width = 64; qc.height = 48;
const qctx = qc.getContext('2d', { willReadFrequently: true });

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
    $('camBtn').disabled = false;
    $('fileIn').disabled = false;
    $('fileLbl').removeAttribute('aria-disabled');
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
  try {
    const d = await api(`/terminal/${encodeURIComponent(machineId)}`);
    st.term = d;
    st.cam = d.camera;
    renderServer(d);
  } catch (e) {
    $('server').innerHTML = e.status === 401
      ? '<div class="notice warn">Mode produksi: <a href="/">login sebagai admin/supervisor</a> terlebih dahulu untuk melihat data mesin.</div>'
      : `<div class="notice bad">Data mesin tidak dapat dimuat: ${esc(e.message)}</div>`;
  }
}

function eventLabel(e) {
  if (e.kind === 'MONITORING_UNAVAILABLE') return badge('muted', 'Pemantauan tidak tersedia');
  const cls = e.corrected_classification || e.classification;
  return cls === 'BREAK' ? badge('info', 'Istirahat terjadwal') : cls === 'LEAVE' ? badge('info', 'Izin') : badge('bad', 'Tidak terdeteksi');
}

function renderServer(d) {
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
    h += `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pctv)}"><div style="width:${pctv}%"></div></div>
      <div class="small muted">Dicatat sebagai ketidakhadiran bila mencapai ${cam.absence_threshold_s} dtk tanpa orang. Jika orang kembali sebelum itu, tidak dicatat.</div>`;
  }
  if (p.code === 'ABSENT') h += `<div class="small" style="margin-top:4px">${p.returning ? `Orang terlihat kembali — menunggu konfirmasi ${cam?.return_confirm_s ?? 5} dtk sebelum kejadian ditutup.` : 'Kejadian ketidakhadiran sedang berlangsung (waktu mulai = saat orang pertama kali tidak terdeteksi).'}</div>`;
  if (s) h += `<div class="small" style="margin-top:8px">Total tidak terdeteksi sesi ini: <b>${fmtDur(s.absent_total_ms)}</b> (${s.absence_count} kejadian) · Pemantauan tidak tersedia: <b>${fmtDur(s.unknown_ms)}</b></div>`;
  if (d.presence_events?.length) {
    h += `<table class="tbl" style="margin-top:8px"><thead><tr><th>Kejadian</th><th>Mulai</th><th>Selesai</th><th class="num">Durasi</th></tr></thead><tbody>${d.presence_events.map((e) => `<tr><td>${eventLabel(e)}</td><td>${fmtT(e.start_at)}</td><td>${e.end_at ? fmtT(e.end_at) : '<i>berlangsung</i>'}</td><td class="num">${fmtDur(e.end_at ? e.duration_ms : d.now - e.start_at)}</td></tr>`).join('')}</tbody></table>`;
  } else if (s) {
    h += '<div class="small muted" style="margin-top:6px">Belum ada kejadian tercatat pada sesi ini.</div>';
  }
  if (cam) h += `<div class="small muted" style="margin-top:8px">Parameter ${esc(machineId)}: ambang ketidakhadiran ${cam.absence_threshold_s} dtk · konfirmasi kembali ${cam.return_confirm_s} dtk · keyakinan minimum ${pct(cam.min_confidence)} · kualitas minimum ${pct(cam.min_quality)} · minimal ${pct(cam.min_roi_overlap)} tubuh di area kerja${cam.enabled ? '' : ' · <b>kamera dinonaktifkan di konfigurasi</b>'}</div>`;
  $('server').innerHTML = h;
  $('srvTime').textContent = `diperbarui ${fmtT(d.now)}`;
}

// ---------------- Sumber gambar ----------------
function showError(msg) {
  $('localStatus').className = 'big-status st-unreliable';
  $('localStatus').innerHTML = `<span class="ico">⚠</span><span>${esc(msg)}</span>`;
}

async function startWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showError('Webcam hanya dapat dipakai lewat http://localhost atau https://. Buka halaman ini di komputer yang menjalankan server, atau gunakan file video/foto.');
    return;
  }
  stopSource(false);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    startSource({ kind: 'webcam', el: v, stream, label: 'Webcam' });
  } catch (e) {
    showError(e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan akses kamera untuk situs ini di pengaturan browser.'
      : e.name === 'NotFoundError' ? 'Tidak ada kamera yang terdeteksi di perangkat ini.' : `Webcam tidak dapat dibuka: ${e.message}`);
  }
}

async function startFile(file) {
  stopSource(false);
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith('image/')) {
      const img = new Image();
      img.src = url;
      await img.decode();
      startSource({ kind: 'image', el: img, url, label: file.name });
    } else if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.src = url;
      await new Promise((resolve, reject) => { v.onloadeddata = resolve; v.onerror = () => reject(new Error('format video tidak didukung browser ini (gunakan MP4 atau WebM)')); });
      await v.play();
      startSource({ kind: 'video', el: v, url, label: file.name });
    } else {
      throw new Error('pilih file video atau gambar');
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    showError(`File tidak dapat dibuka: ${e.message}`);
  }
}

function startSource(src) {
  st.source = src;
  st.lastDet = null; st.candidate = null; st.candCount = 0; st.committed = null; st.committedObs = null; st.lastSent = null;
  if (st.originalAutoPresence == null && st.term?.sim) st.originalAutoPresence = !!st.term.sim.auto_presence;
  $('placeholder').hidden = true;
  view.hidden = false;
  $('stopBtn').disabled = false;
  const token = ++st.loopToken;
  requestAnimationFrame(() => render(token));
  detectLoop(token);
}

/** Menghentikan sumber. restoreSim: kembalikan keberadaan acak simulasi seperti sebelum demo. */
function stopSource(restoreSim = true) {
  st.loopToken++;
  const s = st.source;
  if (s) {
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    if (s.kind === 'video' || s.kind === 'webcam') s.el.pause();
    if (s.url) URL.revokeObjectURL(s.url);
  }
  st.source = null;
  $('stopBtn').disabled = true;
  if (restoreSim) {
    restoreSimulation();
    $('localStatus').className = 'big-status st-idle';
    $('localStatus').innerHTML = `<span class="ico">⏸</span><span>Dihentikan<small>${st.info?.simulation ? 'Keberadaan mesin kembali dikendalikan simulasi seperti sebelum demo.' : 'Analisis berhenti.'}</small></span>`;
    $('persons').innerHTML = '';
  }
}

function restoreSimulation() {
  if (!st.info?.simulation || st.originalAutoPresence == null) return;
  // keepalive: permintaan tetap terkirim walau halaman sedang ditutup
  fetch(`/api/sim/${encodeURIComponent(machineId)}/auto_presence`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: st.originalAutoPresence }),
  }).catch(() => {});
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
/** Kualitas gambar 0..1 dari kontras & kecerahan (gambar gelap, tertutup, atau silau → rendah). */
function frameQuality(el) {
  qctx.drawImage(el, 0, 0, qc.width, qc.height);
  const d = qctx.getImageData(0, 0, qc.width, qc.height).data;
  let sum = 0, sum2 = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; sum += l; sum2 += l * l; }
  const mean = sum / n, std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let q = Math.min(1, std / 24);
  if (mean < 30) q *= mean / 30;
  if (mean > 230) q *= Math.max(0, 255 - mean) / 25;
  return Math.round(Math.max(0, Math.min(1, q)) * 100) / 100;
}
const dims = (el) => [el.videoWidth || el.naturalWidth || el.width, el.videoHeight || el.naturalHeight || el.height];

function analyze(preds, el) {
  const cam = st.cam;
  const [w, h] = dims(el);
  const roi = cam.roi && cam.roi.length >= 3 ? cam.roi : [[0, 0], [1, 0], [1, 1], [0, 1]];
  const persons = preds.filter((p) => p.class === 'person').map((p) => {
    const [x, y, bw, bh] = p.bbox;
    const overlap = roiOverlap(x / w, y / h, bw / w, bh / h, roi);
    return { score: p.score, bbox: p.bbox, overlap, confident: p.score >= cam.min_confidence, inRoi: overlap >= cam.min_roi_overlap };
  }).sort((a, b) => b.score - a.score);
  const quality = frameQuality(el);
  const inC = persons.filter((p) => p.confident && p.inRoi);
  const inU = persons.filter((p) => !p.confident && p.inRoi);
  const outC = persons.filter((p) => p.confident && !p.inRoi);
  const max = (arr, k) => Math.max(...arr.map((p) => p[k]));
  let state, obs;
  if (quality < cam.min_quality) { state = 'UNRELIABLE'; obs = { present: false, confidence: null, quality, roi_overlap: null }; }
  else if (inC.length) { state = 'PRESENT'; obs = { present: true, confidence: max(inC, 'score'), quality, roi_overlap: max(inC, 'overlap') }; }
  else if (inU.length) { state = 'UNCERTAIN'; obs = { present: false, confidence: inU[0].score, quality, roi_overlap: inU[0].overlap }; }
  else if (outC.length) { state = 'OUTSIDE'; obs = { present: true, confidence: outC[0].score, quality, roi_overlap: max(outC, 'overlap') }; }
  else { state = 'EMPTY'; obs = { present: false, confidence: null, quality, roi_overlap: null }; }
  for (const k of ['confidence', 'roi_overlap']) if (obs[k] != null) obs[k] = Math.round(obs[k] * 100) / 100;
  return { persons, quality, state, obs, counts: { inC: inC.length, inU: inU.length, outC: outC.length } };
}

async function detectLoop(token) {
  while (token === st.loopToken) {
    const t0 = performance.now();
    const src = st.source;
    const ready = src && (src.kind === 'image' || src.el.readyState >= 2) && dims(src.el)[0] > 0;
    if (ready && st.cam && st.model) {
      try {
        const preds = await st.model.detect(src.el, 20, DETECT_MIN_SCORE);
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
  if (!st.committed || st.sending) return;
  const key = STATES[st.committed].key;
  const changed = !st.lastSent || st.lastSent.key !== key;
  if (!changed && Date.now() - st.lastSent.at < KEEPALIVE_MS) return;
  send(st.committedObs, key);
}

async function send(obs, key) {
  if (!st.info?.simulation) { st.lastSent = { key, at: Date.now(), outcome: 'tidak dikirim (mode produksi)' }; renderSendInfo(); return; }
  st.sending = true;
  try {
    const r = await api(`/sim/${encodeURIComponent(machineId)}/camera_frame`, { method: 'POST', body: obs });
    st.lastSent = { key, at: Date.now(), outcome: OUTCOME_LABEL[r.outcome] || OUTCOME_LABEL[r.status] || r.outcome || r.status };
  } catch (e) {
    st.lastSent = { key: null, at: Date.now(), outcome: `gagal: ${e.message}` };
  } finally {
    st.sending = false;
    renderSendInfo();
  }
}

// ---------------- Tampilan ----------------
function renderSendInfo() {
  const s = st.lastSent;
  $('sendInfo').innerHTML = s ? `Terakhir dikirim ke server ${fmtT(s.at)}: <b>${esc(KEY_LABEL[s.key] || '—')}</b> → ${esc(s.outcome)}` : '';
}

function renderLocal(res) {
  const shown = st.committed || res.state;
  const S = STATES[shown];
  const o = shown === res.state ? res.obs : st.committedObs || res.obs;
  const cam = st.cam;
  const detail = {
    PRESENT: `Keyakinan ${pctScore(o.confidence)} · ${pct(o.roi_overlap)} tubuh di dalam area kerja`,
    OUTSIDE: `${res.counts.outC} orang terlihat, tetapi di luar area kerja mesin (hanya lewat)`,
    EMPTY: 'Tidak ada orang di dalam area kerja mesin',
    UNCERTAIN: `Kandidat orang dengan keyakinan ${pctScore(o.confidence)} < minimum ${pct(cam.min_confidence)} → dicatat sebagai pemantauan tidak tersedia`,
    UNRELIABLE: `Kualitas gambar ${pct(o.quality)} < minimum ${pct(cam.min_quality)} → bukan ketidakhadiran`,
  }[shown];
  const pending = st.candidate && st.candidate !== shown ? ` · berubah ke "${STATES[st.candidate].title}"…` : '';
  $('localStatus').className = `big-status ${S.cls}`;
  $('localStatus').innerHTML = `<span class="ico" aria-hidden="true">${S.ico}</span><span>${esc(S.title)}<small>${esc(detail + pending)}</small></span>`;
  $('persons').innerHTML = res.persons.slice(0, 8).map((p, i) => {
    const col = p.confident ? (p.inRoi ? COLORS.in : COLORS.out) : COLORS.weak;
    const where = p.inRoi ? 'di area kerja' : 'di luar area';
    return `<li><span class="sw" style="background:${col}"></span>Orang ${i + 1}: keyakinan ${pctScore(p.score)} · ${pct(p.overlap)} di area → ${p.confident ? where : 'kurang yakin'}</li>`;
  }).join('') || '<li class="muted">Tidak ada objek "orang" terdeteksi.</li>';
  $('modelInfo').textContent = `Backend ${st.backend} · analisis ${st.inferMs} ms · kualitas gambar ${pct(res.quality)} · sumber model ${st.modelSource}`;
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
$('fileIn').onchange = (e) => { const f = e.target.files?.[0]; if (f) startFile(f); e.target.value = ''; };
$('stopBtn').onclick = () => stopSource(true);
window.addEventListener('pagehide', () => { if (st.source) stopSource(true); });
init();
