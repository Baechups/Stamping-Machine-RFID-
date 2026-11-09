import { api, esc, badge, toast, STATUS } from '../util.js';

export async function render(el, ctx) {
  const [cams, settings] = await Promise.all([api('/cameras'), api('/settings')]);
  let sel = cams[0]?.machine_id;
  function draw() {
    const c = cams.find((x) => x.machine_id === sel);
    let roi = JSON.parse(c.roi);
    el.innerHTML = `<div class="page-head"><div><h1>Konfigurasi kamera & area deteksi</h1><p>Kamera mendeteksi <b>keberadaan orang</b> di area kerja (ROI) mesin — tanpa pengenalan wajah. Identitas berasal dari RFID. Kamera tidak pernah menghentikan mesin.</p></div><a class="btn btn-primary" href="/kamera-demo.html?m=${encodeURIComponent(c.machine_id)}" target="_blank" rel="noopener">📷 Coba deteksi orang (demo) ↗</a></div>
      <div class="grid cam-grid">
        <section class="panel"><header><h3>Kamera</h3></header><div class="tbl-wrap" style="max-height:640px"><table class="tbl"><tbody>${cams.map((x) => `<tr style="cursor:pointer;${x.machine_id === sel ? 'background:#e7effc' : ''}" data-sel="${x.machine_id}"><td><b>${x.machine_id}</b></td><td>${badge(STATUS.device[x.device_status] || 'muted', { ok: 'Normal', offline: 'Terputus', degraded: 'Tidak andal', obstructed: 'Tertutup', unknown: '?' }[x.device_status] || x.device_status)}</td><td class="small">${x.absence_threshold_s != null ? x.absence_threshold_s + ' d' : 'global'}</td></tr>`).join('')}</tbody></table></div></section>
        <section class="panel"><header><h3>${esc(c.machine_id)} — ${esc(c.machine_name)}</h3><span class="small muted">Status: kamera ${esc(c.camera_state)}, deteksi ${esc(c.presence_raw)}, kualitas ${c.last_quality ?? '—'}</span></header><div class="body">
          <p class="small muted">Klik pada gambar untuk menambah titik poligon ROI; seret titik untuk memindahkan. Hanya orang di dalam ROI yang dihitung sebagai operator — orang lewat di luar area kerja diabaikan.</p>
          <canvas class="roi-canvas" id="cv" width="960" height="540" aria-label="Editor area deteksi"></canvas>
          <div class="row" style="margin:8px 0 14px"><button class="btn btn-sm" id="clr">Hapus titik</button><button class="btn btn-sm" id="rst">Area default</button><span class="small muted" id="pts"></span></div>
          <div class="form-grid">
            <div class="field half"><label>Ambang ketidakhadiran (detik)</label><input type="number" id="thr" min="5" value="${c.absence_threshold_s ?? ''}" placeholder="global: ${settings.absence_threshold_s}"><small>Kosong = pakai pengaturan global</small></div>
            <div class="field half"><label>Konfirmasi orang kembali (detik)</label><input type="number" id="rc" min="1" value="${c.return_confirm_s ?? ''}" placeholder="global: ${settings.return_confirm_s}"></div>
            <div class="field half"><label>Keyakinan deteksi minimum (0–1)</label><input type="number" id="mc" step="0.05" min="0" max="1" value="${c.min_confidence ?? ''}" placeholder="global: ${settings.min_confidence}"></div>
            <div class="field half"><label>Kualitas citra minimum (0–1)</label><input type="number" id="mq" step="0.05" min="0" max="1" value="${c.min_quality ?? ''}" placeholder="global: ${settings.min_quality}"><small>Di bawah nilai ini = "deteksi tidak andal", bukan ketidakhadiran</small></div>
            <div class="field half"><label>Proporsi minimum di dalam ROI (0–1)</label><input type="number" id="mr" step="0.05" min="0" max="1" value="${c.min_roi_overlap ?? ''}" placeholder="global: ${settings.min_roi_overlap}"></div>
            <div class="field half"><label>Pemantauan</label><label class="check"><input type="checkbox" id="en" ${c.enabled ? 'checked' : ''}> Kamera aktif</label></div>
          </div>
          <div class="notice small" style="margin-top:10px">Rekaman video: <b>${settings.record_video ? `disimpan ${settings.video_retention_days} hari (akses terbatas)` : 'tidak disimpan (default)'}</b>. Analitik keberadaan berjalan di perangkat lokal; hanya status hadir/tidak hadir dan kualitas deteksi yang dikirim ke server.</div>
          ${ctx.isAdmin ? '<div class="row" style="margin-top:12px"><button class="btn btn-primary" id="save">Simpan konfigurasi</button></div>' : '<p class="small muted">Hanya admin yang dapat mengubah konfigurasi.</p>'}
        </div></section></div>`;
    el.querySelectorAll('[data-sel]').forEach((r) => r.onclick = () => { sel = r.dataset.sel; draw(); });
    const cv = el.querySelector('#cv'); const g = cv.getContext('2d');
    let drag = -1;
    const paint = () => {
      g.fillStyle = '#2b3442'; g.fillRect(0, 0, cv.width, cv.height);
      // gambar skematis mesin & lantai (placeholder snapshot kamera)
      g.fillStyle = '#3d4859'; g.fillRect(360, 40, 240, 190); g.fillStyle = '#566377'; g.fillRect(410, 230, 140, 40);
      g.fillStyle = '#9aa7b8'; g.font = '20px sans-serif'; g.fillText(`Mesin ${c.machine_id}`, 420, 140); g.font = '14px sans-serif'; g.fillText('Pratinjau skematis — snapshot kamera tidak disimpan', 20, 520);
      g.strokeStyle = '#4d5a6c'; for (let x = 0; x < cv.width; x += 60) { g.beginPath(); g.moveTo(x, 300); g.lineTo(x - 120, 540); g.stroke(); }
      if (roi.length) {
        g.beginPath(); roi.forEach(([x, y], i) => (i ? g.lineTo(x * cv.width, y * cv.height) : g.moveTo(x * cv.width, y * cv.height))); g.closePath();
        g.fillStyle = 'rgba(77,141,247,.25)'; g.fill(); g.strokeStyle = '#4d8df7'; g.lineWidth = 3; g.stroke();
        roi.forEach(([x, y]) => { g.beginPath(); g.arc(x * cv.width, y * cv.height, 8, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#1d5fd1'; g.stroke(); });
        g.fillStyle = '#cfe0ff'; g.font = 'bold 16px sans-serif'; g.fillText('Area kerja operator (ROI)', roi[0][0] * cv.width + 10, roi[0][1] * cv.height + 24);
      }
      el.querySelector('#pts').textContent = `${roi.length} titik${roi.length < 3 ? ' — minimal 3 titik' : ''}`;
    };
    const pos = (e) => { const r = cv.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
    cv.onpointerdown = (e) => {
      const [x, y] = pos(e);
      drag = roi.findIndex(([px, py]) => Math.hypot((px - x) * 16, (py - y) * 9) < 0.35);
      if (drag < 0) { roi.push([+x.toFixed(3), +y.toFixed(3)]); drag = roi.length - 1; }
      cv.setPointerCapture(e.pointerId); paint();
    };
    cv.onpointermove = (e) => { if (drag < 0) return; const [x, y] = pos(e); roi[drag] = [+x.toFixed(3), +y.toFixed(3)]; paint(); };
    cv.onpointerup = () => { drag = -1; };
    el.querySelector('#clr').onclick = () => { roi = []; paint(); };
    el.querySelector('#rst').onclick = () => { roi = [[0.25, 0.3], [0.75, 0.3], [0.8, 0.95], [0.2, 0.95]]; paint(); };
    paint();
    const sv = el.querySelector('#save');
    if (sv) sv.onclick = async () => {
      try {
        const v = (id) => el.querySelector(id).value;
        await api(`/cameras/${c.machine_id}`, { method: 'PUT', body: { roi, absence_threshold_s: v('#thr'), return_confirm_s: v('#rc'), min_confidence: v('#mc'), min_quality: v('#mq'), min_roi_overlap: v('#mr'), enabled: el.querySelector('#en').checked } });
        c.roi = JSON.stringify(roi); c.absence_threshold_s = v('#thr') === '' ? null : Number(v('#thr'));
        toast('Konfigurasi kamera disimpan & tercatat di audit log', 'success'); draw();
      } catch (e) { toast(e.message, 'error'); }
    };
  }
  draw();
}
