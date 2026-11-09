import { api, esc, fmtDT, qs } from '../util.js';

export async function render(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Audit log</h1><p>Mencatat login/logout pengguna & operator, perubahan konfigurasi, standar, koreksi produksi & klasifikasi, serta tindakan supervisor. Tidak dapat diubah dari antarmuka.</p></div></div>
    <div class="filters panel" style="padding:10px 12px"><div class="f"><label>Aksi</label><input id="a" placeholder="mis. CORRECTION, SESSION"></div><div class="f"><label>Cari pelaku / entitas / alasan</label><input id="q"></div>
      <div class="f"><label>Entitas</label><select id="e"><option value="">Semua</option>${['session', 'production_result', 'presence_event', 'stamping_standard', 'shift', 'shift_assignment', 'operator', 'rfid_card', 'camera', 'settings', 'user', 'device', 'machine', 'overtime', 'leave_permit'].map((x) => `<option>${x}</option>`).join('')}</select></div>
      <div class="f"><label>&nbsp;</label><button class="btn btn-primary" id="go">Cari</button></div></div>
    <section class="panel"><div class="tbl-wrap" id="out"></div></section>`;
  const load = async () => {
    const rows = await api(`/audit${qs({ action: el.querySelector('#a').value, q: el.querySelector('#q').value, entity: el.querySelector('#e').value })}`);
    el.querySelector('#out').innerHTML = `<table class="tbl"><thead><tr><th>Waktu</th><th>Pelaku</th><th>Aksi</th><th>Entitas</th><th>Alasan</th><th>Sebelum → sesudah</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small">${fmtDT(r.at)}</td><td>${esc(r.actor)}</td><td><code>${esc(r.action)}</code></td><td class="small">${esc(r.entity || '')} ${esc(r.entity_id || '')}</td><td>${esc(r.reason || '')}</td>
        <td class="small mono" style="max-width:420px;word-break:break-all">${r.before_data ? `<details><summary>lihat</summary><div><b>Sebelum:</b> ${esc(r.before_data)}</div><div><b>Sesudah:</b> ${esc(r.after_data || '')}</div></details>` : esc((r.after_data || '').slice(0, 160))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Tidak ada catatan</td></tr>'}</tbody></table>`;
  };
  el.querySelector('#go').onclick = load;
  load();
}
