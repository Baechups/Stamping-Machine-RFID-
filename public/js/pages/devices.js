import { api, esc, fmtDT, fmtT, badge, STATUS, DEVICE_NAME, toast, modal } from '../util.js';

const DS = { ok: 'Normal', offline: 'Terputus', unknown: 'Tidak diketahui', fault: 'Gangguan', degraded: 'Tidak andal', obstructed: 'Tertutup' };
export async function render(el, ctx) {
  let showAll = false;
  async function load() {
    const [{ devices, anomalies }, alerts] = await Promise.all([api('/devices'), api(`/alerts${showAll ? '?all=1' : ''}`)]);
    if (!ctx.alive()) return;
    const byM = new Map();
    for (const d of devices) { if (!byM.has(d.machine_id)) byM.set(d.machine_id, {}); byM.get(d.machine_id)[d.type] = d; }
    const types = ['edge', 'rfid', 'camera', 'sensor', 'controller', 'terminal'];
    const bad = devices.filter((d) => d.status !== 'ok').length;
    el.innerHTML = `<div class="page-head"><div><h1>Status perangkat & gangguan</h1><p>Perangkat lokal mengirim heartbeat berkala. Tanpa heartbeat, status komponen & fisik mesin menjadi "Tidak diketahui".</p></div><div class="updated">Diperbarui ${fmtT(Date.now())}</div></div>
      <div class="kpis"><div class="kpi"><div class="l">Perangkat</div><div class="v">${devices.length}</div></div><div class="kpi ${bad ? 'bad' : 'ok'}"><div class="l">Tidak normal</div><div class="v">${bad}</div></div>
        <div class="kpi ${alerts.length ? 'warn' : ''}"><div class="l">Alert terbuka</div><div class="v">${alerts.filter((a) => !a.resolved_at).length}</div></div></div>
      <div class="grid g2">
      <section class="panel"><header><h3>Matriks perangkat per mesin</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mesin</th>${types.map((t) => `<th>${DEVICE_NAME[t]}</th>`).join('')}<th>Selisih jam</th></tr></thead><tbody>
        ${[...byM.entries()].map(([m, d]) => `<tr><td><a href="#/mesin/${m}">${m}</a></td>${types.map((t) => d[t] ? `<td title="${esc(d[t].status_detail || '')} · ${fmtDT(d[t].last_seen)}">${badge(STATUS.device[d[t].status] || 'muted', DS[d[t].status] || d[t].status)}</td>` : '<td>—</td>').join('')}
          <td class="num small">${d.edge?.clock_offset_ms != null ? `${d.edge.clock_offset_ms} ms` : '—'}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><header><h3>Alert & gangguan</h3><label class="small"><input type="checkbox" id="all" ${showAll ? 'checked' : ''}> tampilkan yang selesai</label></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Mesin</th><th>Tingkat</th><th>Pesan</th><th></th></tr></thead><tbody>
        ${alerts.map((a) => `<tr><td class="small">${fmtDT(a.created_at)}</td><td>${esc(a.machine_id || '-')}</td><td>${badge(a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info', { critical: 'Kritis', warning: 'Peringatan', info: 'Info' }[a.severity])}</td>
          <td>${esc(a.message)}${a.resolved_at ? `<div class="small muted">selesai ${fmtT(a.resolved_at)}</div>` : ''}${a.acknowledged_at ? `<div class="small muted">diketahui ${fmtT(a.acknowledged_at)}</div>` : ''}</td>
          <td>${!a.resolved_at ? `<div class="row"><button class="btn btn-sm" data-ack="${a.id}">Diketahui</button><button class="btn btn-sm" data-res="${a.id}">Selesai</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Tidak ada alert.</td></tr>'}</tbody></table></div></section></div>
      <section class="panel" style="margin-top:14px"><header><h3>Anomali counter / sensor terbaru</h3></header><div class="tbl-wrap" style="max-height:300px"><table class="tbl"><thead><tr><th>Waktu</th><th>Mesin</th><th>Jenis</th><th class="num">Jumlah</th><th>Detail</th></tr></thead><tbody>
        ${anomalies.map((a) => `<tr><td>${fmtDT(a.at)}</td><td>${a.machine_id}</td><td>${esc(a.type)}</td><td class="num">${a.count ?? ''}</td><td class="small mono">${esc(a.details || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Tidak ada.</td></tr>'}</tbody></table></div></section>
      ${ctx.isAdmin ? `<section class="panel" style="margin-top:14px"><header><h3>Kunci API perangkat lokal (admin)</h3><span class="small muted">Dipakai perangkat lokal pada header X-Device-Key</span></header><div class="tbl-wrap" style="max-height:300px"><table class="tbl"><thead><tr><th>Perangkat</th><th>Alamat</th><th>Kunci</th><th></th></tr></thead><tbody>
        ${devices.filter((d) => d.type === 'edge' || d.type === 'terminal').map((d) => `<tr><td>${esc(d.id)}</td><td>${esc(d.address || '')}</td><td class="mono small">${esc(d.api_key ? d.api_key.slice(0, 6) + '…' + d.api_key.slice(-4) : '-')}</td><td><button class="btn btn-sm" data-rot="${esc(d.id)}">Rotasi kunci</button></td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
    el.querySelector('#all').onchange = (e) => { showAll = e.target.checked; load(); };
    el.querySelectorAll('[data-ack]').forEach((b) => b.onclick = async () => { await api(`/alerts/${b.dataset.ack}/ack`, { method: 'POST', body: {} }); load(); });
    el.querySelectorAll('[data-res]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: 'Tandai alert selesai', fields: [{ name: 'note', label: 'Catatan tindakan', type: 'textarea', required: true }], onSubmit: (d) => api(`/alerts/${b.dataset.res}/ack`, { method: 'POST', body: { resolve: true, note: d.note } }) });
      if (r) load();
    });
    el.querySelectorAll('[data-rot]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: 'Rotasi kunci perangkat', body: '<p>Perangkat harus dikonfigurasi ulang dengan kunci baru.</p>', danger: true, submit: 'Rotasi', onSubmit: () => api(`/devices/${b.dataset.rot}`, { method: 'PUT', body: { rotate_key: true } }) });
      if (r) { toast('Kunci dirotasi', 'success'); load(); }
    });
  }
  await load();
  const t = setInterval(load, 10000);
  return () => clearInterval(t);
}
