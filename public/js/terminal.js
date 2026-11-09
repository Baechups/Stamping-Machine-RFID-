import { api, esc, fmtT, fmtHM, fmtDur, fmtNum, badge, STATUS, CATEGORY, modal, toast } from './util.js';
import { simPanel, resultFields } from './components.js';
import { DEV_SHORT } from './pages/dashboard.js';

const params = new URLSearchParams(location.search);
const machineId = (params.get('m') || 'M01').toUpperCase();
const key = params.get('key') || '';
const kq = key ? `?key=${encodeURIComponent(key)}` : '';
const root = document.getElementById('term');
let data = null; let lastErr = null; let simLoaded = false;

async function load() {
  try { data = await api(`/terminal/${machineId}${kq}`); lastErr = null; }
  catch (e) { lastErr = e.message; }
  draw();
}

function draw() {
  if (!data) { root.innerHTML = `<div class="idle"><div class="big">Terminal ${esc(machineId)}</div><p>${esc(lastErr || 'Memuat…')}</p></div>`; return; }
  const c = data.card, s = c.session;
  document.title = `Terminal ${c.id} — ${s ? s.operator_name : 'Tidak ada operator'}`;
  const devs = ['edge', 'rfid', 'camera', 'sensor', 'controller'].map((t) => {
    const d = c.devices[t]; const ok = d?.status === 'ok';
    return badge(ok ? 'ok' : d?.status === 'unknown' ? 'muted' : 'bad', `${DEV_SHORT[t]} ${ok ? 'OK' : d?.label || '?'}`);
  }).join('');
  const msg = c.terminal?.message && (Date.now() - (c.terminal.at || 0) < 10 * 60000 || s) ? c.terminal : null;
  const offline = data.sim && !data.sim.online;
  const [pt] = STATUS.presence[c.presence.code] || ['muted'];
  const job = s?.job;
  const jobRow = data.jobs.find((j) => j.id === job?.id);
  root.innerHTML = `
    <div class="t-top"><div><div class="mno">${esc(c.id)}</div><div style="color:#9fb3d1">${esc(c.name)} · ${esc(c.area || '')}</div></div>
      ${data.simulation ? '<span class="t-sim-tag">MODE SIMULASI</span>' : ''}
      <div class="t-devs">${devs}</div>
      <div>${badge(STATUS.physical[c.physical_state] || 'muted', `Mesin: ${c.physical_label}`)}</div>
      <div class="clock" id="tclock">${fmtT(Date.now())}</div></div>
    ${offline ? `<div class="t-msg warning">⚠ ${esc(data.sim.local_message)}</div>` : ''}
    ${lastErr ? `<div class="t-msg error">Koneksi ke server bermasalah: ${esc(lastErr)}</div>` : ''}
    ${msg ? `<div class="t-msg ${esc(msg.level || 'info')}" role="status" aria-live="assertive">${msg.level === 'success' ? '✔' : msg.level === 'error' ? '✖' : msg.level === 'warning' ? '⚠' : '⏳'} ${esc(msg.message)}</div>` : ''}
    ${s ? `<div class="t-body">
      <section class="t-card"><h2>Operator aktif</h2>
        <div class="who"><div class="ph">${s.photo_url ? `<img src="${esc(s.photo_url)}" alt="Foto ${esc(s.operator_name)}">` : '👤'}</div>
          <div><div class="nm">${esc(s.operator_name)}</div><div class="id">ID ${esc(s.operator_id)} · ${esc(s.employee_no)}</div>
            <div style="margin-top:8px" class="row">${badge(STATUS.session[s.status] || 'muted', s.status_label)} ${badge(s.permission_status === 'GRANTED' ? 'ok' : 'warn', `Izin: ${s.permission_label}`)}</div></div></div>
        <div class="facts">
          <div class="fact"><div class="l">Mesin</div><div class="v">${esc(c.id)}</div></div>
          <div class="fact"><div class="l">Shift</div><div class="v" style="font-size:18px">${esc(s.shift_name || '-')}</div></div>
          <div class="fact"><div class="l">Waktu login</div><div class="v">${fmtHM(s.login_at)}</div></div>
          <div class="fact"><div class="l">Durasi sesi</div><div class="v">${fmtDur(s.duration_ms)}</div></div>
          <div class="fact"><div class="l">Keberadaan</div><div class="v" style="font-size:16px">${badge(pt, c.presence.label)}</div></div>
          <div class="fact"><div class="l">Tidak terdeteksi (sesi)</div><div class="v">${fmtDur(s.absent_total_ms)}</div></div>
        </div>
        ${s.not_logged_out ? '<div class="t-msg warning" style="margin:14px 0 0">⚠ Belum logout — shift sudah berakhir. Tap kartu Anda untuk logout.</div>' : ''}
        <p style="color:#9fb3d1;margin-top:14px">Tap kartu yang sama untuk logout. Kartu lain tidak dapat mengganti sesi ini.</p>
      </section>
      <section class="t-card"><h2>Counter stamping sesi</h2>
        <div class="counter" aria-label="Jumlah stamping sesi">${fmtNum(s.stamping.total)}</div>
        <div class="small" style="color:#9fb3d1;margin-top:6px">Normal ${fmtNum(s.stamping.normal)} · Setup ${fmtNum(s.stamping.setup)} · Uji ${fmtNum(s.stamping.trial)} · Rework ${fmtNum(s.stamping.rework)}${s.stamping.unassigned ? ` · Tanpa pekerjaan ${fmtNum(s.stamping.unassigned)}` : ''}</div>
        <h2 style="margin-top:18px">Pekerjaan</h2>
        ${job ? `<div style="font-size:20px;font-weight:700">${esc(job.work_order_id)} — ${esc(job.product_name)}</div><div style="color:#9fb3d1">${esc(job.stage_name || '')} · ${esc(CATEGORY[job.category])} · stamping pekerjaan ini: <b style="color:#fff">${fmtNum(jobRow?.cycles.total || 0)}</b>
          ${job.standard ? `<br>Standar: ${job.standard.cycles_per_set} siklus = ${job.standard.pcs_per_set} pcs` : '<br>Standar belum tersedia'}</div>` : '<div class="t-msg warning" style="margin:0">Pilih pekerjaan sebelum produksi</div>'}
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:12px">
          <select id="woSel" aria-label="Work order">${data.work_orders.map((w) => `<option value="${esc(w.id)}" ${w.id === job?.work_order_id ? 'selected' : ''}>${esc(w.id)} — ${esc(w.product_name)}</option>`).join('')}</select>
          <select id="catSel" aria-label="Kategori">${['normal', 'setup', 'trial', 'rework'].map((k) => `<option value="${k}" ${k === (job?.category || 'normal') ? 'selected' : ''}>${CATEGORY[k]}</option>`).join('')}</select></div>
        <div class="row" style="margin-top:10px"><button class="t-btn primary" id="jobBtn">${job ? 'Ganti pekerjaan' : 'Mulai pekerjaan'}</button>
          ${data.can_enter_results && job ? '<button class="t-btn" id="resBtn">Catat hasil produksi</button>' : ''}</div>
        ${jobRow?.result ? `<p style="color:#9fb3d1;margin-top:10px">Hasil tercatat: baik ${jobRow.category === 'rework' ? jobRow.result.rework_good_qty : jobRow.result.good_qty}, reject ${jobRow.result.reject_completed_qty + jobRow.result.reject_incomplete_qty}, rework ${jobRow.result.rework_qty} (${jobRow.result.is_final ? 'final' : 'sementara'}, ${jobRow.result.verification_status === 'VERIFIED' ? 'terverifikasi' : 'menunggu verifikasi supervisor'})</p>` : ''}
      </section></div>`
    : `<div class="idle"><div class="rf" aria-hidden="true">📇</div><div class="big">Tidak ada operator aktif</div>
        <p style="font-size:22px;color:#a9bad3">Tap kartu RFID Anda pada reader untuk login.</p>
        ${data.last_summary ? `<div class="t-card" style="max-width:640px;margin:20px auto;text-align:left"><h2>Ringkasan sesi terakhir — ${esc(data.last_summary.operator_name)}</h2>
          <div class="facts"><div class="fact"><div class="l">Durasi sesi</div><div class="v">${fmtDur(data.last_summary.duration_ms)}</div></div><div class="fact"><div class="l">Total stamping</div><div class="v">${fmtNum(data.last_summary.stamping?.total)}</div></div>
          <div class="fact"><div class="l">Tidak terdeteksi</div><div class="v">${fmtDur(data.last_summary.absent_ms)} (${data.last_summary.absence_count}×)</div></div><div class="fact"><div class="l">Logout</div><div class="v">${fmtHM(data.last_summary.logout_at)}</div></div></div></div>` : ''}</div>`}
    <footer class="t-foot"><div class="safety">⛔ Tombol STOP dan EMERGENCY STOP selalu dapat digunakan tanpa kartu RFID. Tap kartu hanya memberi izin operasional — mesin dijalankan dengan tombol Start sesuai prosedur keselamatan.</div>
      <div>ℹ Pemberitahuan pemantauan: ${esc(data.monitoring_notice)}</div></footer>`;
  const jb = document.getElementById('jobBtn');
  if (jb) jb.onclick = async () => {
    try { await api(`/terminal/${machineId}/job${kq}`, { method: 'POST', body: { work_order_id: document.getElementById('woSel').value, category: document.getElementById('catSel').value } }); toast('Pekerjaan dipilih', 'success'); load(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const rb = document.getElementById('resBtn');
  if (rb) rb.onclick = async () => {
    const r = await modal({ title: `Hasil produksi — ${jobRow.work_order_id} (${CATEGORY[jobRow.category]})`, fields: resultFields(jobRow, jobRow.result || {}),
      onSubmit: (b) => api(`/terminal/${machineId}/result${kq}`, { method: 'POST', body: { ...b, job_id: jobRow.id } }) });
    if (r) { toast('Hasil disimpan — menunggu verifikasi supervisor', 'success'); load(); }
  };
  if (data.simulation && !simLoaded) {
    simLoaded = true;
    document.getElementById('simWrap').hidden = false;
    const det = document.getElementById('simDetails');
    det.addEventListener('toggle', () => { if (det.open) simPanel(document.getElementById('simBox'), machineId, () => setTimeout(load, 200)); });
  }
}

setInterval(() => { const c = document.getElementById('tclock'); if (c) c.textContent = fmtT(Date.now()); }, 1000);
setInterval(() => { if (!document.querySelector('.modal-backdrop') && !document.activeElement?.matches('select')) load(); }, 1500);
load();
