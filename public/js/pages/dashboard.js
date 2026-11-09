import { api, esc, fmtHM, fmtDur, fmtT, fmtNum, signed, badge, STATUS, DEVICE_NAME } from '../util.js';

export const DEV_SHORT = { edge: 'NET', rfid: 'RFID', camera: 'CAM', sensor: 'SNS', controller: 'PLC' };
const devTone = (s) => ({ ok: 'ok', offline: 'bad', fault: 'bad', degraded: 'warn', obstructed: 'warn' }[s] || 'muted');

export function machineCardHtml(c) {
  const s = c.session;
  const [ptone, plabel] = STATUS.presence[c.presence.code] || ['muted', c.presence.label];
  const prod = s?.production;
  const devs = ['edge', 'rfid', 'camera', 'sensor', 'controller'].map((t) => {
    const d = c.devices[t]; const tone = devTone(d?.status);
    return `<span class="dev d-${tone}" title="${esc(DEVICE_NAME[t])}: ${esc(d?.label || 'Tidak diketahui')}${d?.detail ? ' — ' + esc(d.detail) : ''}">${DEV_SHORT[t]} ${tone === 'ok' ? '✓' : tone === 'muted' ? '?' : '✕'}</span>`;
  }).join('');
  const prodBadge = !s ? '' : badge(STATUS.prod[prod.status] || 'muted', prod.status === 'OK' ? 'Sesuai standar' : prod.status === 'REVIEW' ? `Perlu ditinjau ${signed(prod.diff_pct, 1)}%` : prod.status === 'PROVISIONAL' ? 'Sementara' : prod.status === 'NO_STANDARD' ? 'Standar belum ada' : 'Belum ada produksi', prod.status_label);
  return `<button class="mcard s-${c.status_group} ${c.needs_review ? 'review' : ''}" data-m="${c.id}" aria-label="Mesin ${esc(c.name)}">
    <div class="top"><div><div class="mno">${esc(c.id)}</div><div class="mname">${esc(c.name)} · ${esc(c.area || '')}</div></div>
      <div style="text-align:right">${badge(STATUS.physical[c.physical_state] || 'muted', c.physical_label, 'Status fisik mesin (umpan balik PLC)')}</div></div>
    ${s ? `<div><div class="op">👤 ${esc(s.operator_name)} ${s.simulated ? '<span class="badge b-sim">Simulasi</span>' : ''}</div>
        <div class="small muted">${esc(s.operator_id)} · ${esc(s.shift_name || '')} · login ${fmtHM(s.login_at)} · ${fmtDur(s.duration_ms)}</div></div>
      <div class="row">${badge(STATUS.session[s.status] || 'muted', s.status_label)} ${s.permission_status !== 'GRANTED' ? badge('warn', `Izin: ${s.permission_label}`) : ''}</div>`
    : `<div class="op none">Tidak ada operator aktif</div>`}
    <div class="row">${badge(ptone, c.presence.code === 'ABSENT' || c.presence.code === 'CHECKING' ? `${plabel} ${fmtDur(c.presence.ongoing_ms)}` : (c.presence.label || plabel))}</div>
    ${s ? `<div class="meta"><span>Stamping: <b>${fmtNum(s.stamping.total)}</b></span><span>Tidak hadir: <b>${fmtDur(s.absent_total_ms)}</b> (${s.absence_count}×)</span>
      <span>Baik: <b>${fmtNum(prod.qty.good_total)}</b></span><span>Reject: <b>${fmtNum(prod.qty.reject_completed + prod.qty.reject_incomplete)}</b></span>
      <span style="grid-column:span 2">${s.job ? `${esc(s.job.work_order_id)} · ${esc(s.job.product_id)}${s.job.category !== 'normal' ? ' · ' + esc(s.job.category) : ''}` : '<i>Pekerjaan belum dipilih</i>'}</span></div>
      <div>${prodBadge}</div>` : ''}
    ${c.flags.length ? `<div class="flags">${c.flags.map((f) => `<span class="flag">⚑ ${esc(f)}</span>`).join('')}</div>` : ''}
    <div class="devs" aria-label="Status koneksi perangkat">${devs}</div>
  </button>`;
}

export async function render(el, ctx) {
  const st = { q: '', shift: '', status: '', group: '', data: null, timer: null, last: 0 };
  el.innerHTML = `<div class="page-head"><div><h1>Dashboard 30 mesin stamping</h1><p id="shiftInfo">Memuat…</p></div>
      <div class="updated" aria-live="polite"><span class="dot-live"></span><span id="upd">—</span></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="filters panel" style="padding:10px 12px">
      <div class="f"><label for="q">Cari mesin / operator</label><input id="q" type="search" placeholder="M05, nama, ID operator…"></div>
      <div class="f"><label for="fs">Shift</label><select id="fs"><option value="">Semua shift</option></select></div>
      <div class="f"><label for="fst">Status</label><select id="fst"><option value="">Semua status</option><option value="active">Sesi aktif</option><option value="idle">Tanpa operator</option>
        <option value="fault">Gangguan</option><option value="review">Perlu ditinjau</option><option value="absent">Tidak terdeteksi</option><option value="nologout">Belum logout</option></select></div>
      <div class="f"><label for="fa">Area</label><select id="fa"><option value="">Semua area</option><option>Area A</option><option>Area B</option></select></div>
      <div class="f" style="margin-left:auto"><span class="small muted">Klik kartu untuk detail sesi, timeline, stamping & hasil produksi.</span></div>
    </div>
    <div class="mgrid" id="grid"></div>`;
  const $ = (s) => el.querySelector(s);
  const shiftsResp = await api('/shifts');
  $('#fs').innerHTML += shiftsResp.shifts.filter((s) => s.enabled).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');

  function draw() {
    const d = st.data; if (!d || !ctx.alive()) return;
    const cur = d.shifts.map((s) => `${esc(s.name)} (${fmtHM(s.start)}–${fmtHM(s.end)})`).join(', ');
    $('#shiftInfo').innerHTML = `Shift berjalan: <b>${cur || 'tidak ada shift aktif'}</b> · Zona waktu Asia/Jakarta`;
    const k = d.summary;
    const kpi = (key, label, v, tone) => `<button class="kpi ${tone}" data-k="${key}" aria-pressed="${st.status === key}"><div class="l">${label}</div><div class="v">${v}</div></button>`;
    $('#kpis').innerHTML = kpi('', 'Total mesin', k.total, '') + kpi('active', 'Sesi aktif', k.active, 'ok') + kpi('idle', 'Tanpa operator', k.idle, '') +
      kpi('fault', 'Mengalami gangguan', k.fault, k.fault ? 'bad' : '') + kpi('review', 'Perlu ditinjau', k.review, k.review ? 'warn' : '') +
      kpi('absent', 'Operator tidak terdeteksi', k.absent_now, k.absent_now ? 'warn' : '') + `<div class="kpi"><div class="l">Stamping sesi aktif</div><div class="v">${fmtNum(k.stamping_total)}</div></div>`;
    el.querySelectorAll('.kpi[data-k]').forEach((b) => b.onclick = () => { st.status = b.dataset.k; $('#fst').value = st.status; draw(); });
    const q = st.q.toLowerCase();
    const cards = d.cards.filter((c) => {
      if (q && ![c.id, c.name, c.session?.operator_name, c.session?.operator_id].some((x) => String(x || '').toLowerCase().includes(q))) return false;
      if (st.shift && String(c.session?.shift_id) !== st.shift) return false;
      if (st.group && c.area !== st.group) return false;
      switch (st.status) {
        case 'active': return !!c.session; case 'idle': return !c.session; case 'fault': return c.has_fault; case 'review': return c.needs_review;
        case 'absent': return c.presence.code === 'ABSENT'; case 'nologout': return c.session?.not_logged_out; default: return true;
      }
    });
    $('#grid').innerHTML = cards.length ? cards.map(machineCardHtml).join('') : '<div class="empty panel">Tidak ada mesin sesuai filter.</div>';
    el.querySelectorAll('.mcard').forEach((b) => b.onclick = () => ctx.go(`mesin/${b.dataset.m}`));
    $('#upd').textContent = `Pembaruan terakhir ${fmtT(st.last)} WIB`;
  }
  async function load() {
    try { st.data = await api('/dashboard'); st.last = Date.now(); draw(); }
    catch (e) { if (ctx.alive()) $('#upd').textContent = `Gagal memperbarui: ${e.message}`; }
  }
  $('#q').oninput = (e) => { st.q = e.target.value; draw(); };
  $('#fs').onchange = (e) => { st.shift = e.target.value; draw(); };
  $('#fst').onchange = (e) => { st.status = e.target.value; draw(); };
  $('#fa').onchange = (e) => { st.group = e.target.value; draw(); };
  await load();
  let pending = false;
  ctx.onLive(() => { if (pending) return; pending = true; setTimeout(async () => { pending = false; await load(); }, 700); });
  st.timer = setInterval(load, 5000); // fallback & pembaruan durasi
  return () => clearInterval(st.timer);
}
