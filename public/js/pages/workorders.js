import { api, esc, fmtNum, badge, modal, toast, qs, msToWibDate, wibToMs } from '../util.js';
import { jobsTable, bindJobActions } from '../components.js';

export async function render(el, ctx) {
  async function load() {
    const [wos, products] = await Promise.all([api('/work-orders'), api('/products')]);
    const today = msToWibDate(Date.now());
    el.innerHTML = `<div class="page-head"><div><h1>Work order & hasil produksi</h1><p>Hasil produksi tidak otomatis sama dengan jumlah stamping. Hasil dari operator menunggu verifikasi supervisor.</p></div>
        ${ctx.isAdmin ? '<button class="btn btn-primary" id="newWo">+ Work order baru</button>' : ''}</div>
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>WO</th><th>Produk</th><th>Tahap</th><th class="num">Target</th><th class="num">Stamping</th><th class="num">Produk baik</th><th class="num">Progres</th><th>Jatuh tempo</th><th>Status</th><th></th></tr></thead><tbody>
        ${wos.map((w) => `<tr><td><b>${esc(w.id)}</b><div class="small muted">${esc(w.note || '')}</div></td><td>${esc(w.product_name)}</td><td>${esc(w.stage_name || '')}</td><td class="num">${fmtNum(w.target_qty)}</td><td class="num">${fmtNum(w.cycles)}</td><td class="num">${fmtNum(w.good)}</td>
          <td class="num">${w.target_qty ? Math.round((w.good / w.target_qty) * 100) + '%' : '—'}</td><td>${esc(w.due_date || '')}</td><td>${badge(w.status === 'open' ? 'ok' : 'muted', w.status === 'open' ? 'Terbuka' : 'Ditutup')}</td>
          <td><button class="btn btn-sm" data-toggle="${esc(w.id)}" data-st="${w.status}">${w.status === 'open' ? 'Tutup' : 'Buka kembali'}</button></td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel" style="margin-top:14px"><header><h3>Pekerjaan & hasil produksi hari ini</h3><div class="row"><label class="small">Tanggal</label><input type="date" id="dt" value="${today}"><label class="small">Hanya belum diverifikasi</label><input type="checkbox" id="unv"></div></header><div class="body" id="jobs">Memuat…</div></section>`;
    const nb = el.querySelector('#newWo');
    if (nb) nb.onclick = async () => {
      const stages = products.flatMap((p) => p.stages.map((s) => ({ value: `${p.id}|${s.id}`, label: `${p.id} — ${p.name} / ${s.name}` })));
      const r = await modal({ title: 'Work order baru', fields: [{ name: 'id', label: 'Nomor WO', required: true, placeholder: 'WO-2611-010' }, { name: 'ps', label: 'Produk / tahap', type: 'select', options: stages },
        { name: 'target_qty', label: 'Target (pcs)', type: 'number', min: 0, value: 100, half: true }, { name: 'due_date', label: 'Jatuh tempo', type: 'date', half: true }, { name: 'note', label: 'Catatan' }],
      onSubmit: (d) => { const [product_id, stage_id] = d.ps.split('|'); return api('/work-orders', { method: 'POST', body: { ...d, product_id, stage_id } }); } });
      if (r) { toast('Work order dibuat', 'success'); load(); }
    };
    el.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async () => {
      await api(`/work-orders/${encodeURIComponent(b.dataset.toggle)}`, { method: 'PUT', body: { status: b.dataset.st === 'open' ? 'closed' : 'open' } }); load();
    });
    const loadJobs = async () => {
      const d = el.querySelector('#dt').value; const from = wibToMs(d); const rows = await api(`/jobs${qs({ from, to: from + 86400e3 })}`);
      const list = el.querySelector('#unv').checked ? rows.filter((r) => !r.result || r.result.verification_status !== 'VERIFIED') : rows;
      el.querySelector('#jobs').innerHTML = jobsTable(list);
      bindJobActions(el.querySelector('#jobs'), list, loadJobs);
    };
    el.querySelector('#dt').onchange = loadJobs; el.querySelector('#unv').onchange = loadJobs;
    loadJobs();
  }
  load();
}
