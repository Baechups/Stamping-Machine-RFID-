import { api, esc, fmtDT, badge, modal, toast, wibToMs, msToWibDate } from '../util.js';

export async function render(el, ctx) {
  async function load() {
    const products = await api('/products');
    el.innerHTML = `<div class="page-head"><div><h1>Produk, tahap proses & standar stamping</h1><p>Standar: <b>X siklus</b> menghasilkan <b>Y pcs</b>. Pekerjaan menyimpan salinan standar saat dimulai sehingga perubahan standar tidak mengubah laporan historis.</p></div>
      ${ctx.isAdmin ? '<button class="btn btn-primary" id="addP">+ Produk</button>' : ''}</div>
      <div class="grid g2">${products.map((p) => `<section class="panel"><header><h3>${esc(p.id)} — ${esc(p.name)}</h3>${ctx.isAdmin ? `<button class="btn btn-sm" data-stage="${p.id}">+ Tahap</button>` : ''}</header><div class="body">
        ${p.stages.map((s) => `<div style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><b>${esc(s.code)} · ${esc(s.name)}</b>${ctx.isAdmin ? `<button class="btn btn-sm" data-std="${p.id}|${s.id}">Tetapkan standar baru</button>` : ''}</div>
          ${s.current ? `<div class="notice" style="margin:6px 0">Berlaku: <b>${s.current.cycles_per_set} siklus = ${s.current.pcs_per_set} pcs</b> (${(s.current.cycles_per_set / s.current.pcs_per_set).toFixed(3)} siklus/pcs) · toleransi ±${s.current.tolerance_pct}% · sejak ${fmtDT(s.current.effective_from)}</div>` : '<div class="notice warn" style="margin:6px 0">Standar belum tersedia — laporan tidak akan menyimpulkan penyimpangan.</div>'}
          ${s.standards.length ? `<table class="tbl"><thead><tr><th>Siklus</th><th>Pcs</th><th>Toleransi</th><th>Berlaku</th><th>Catatan</th></tr></thead><tbody>${s.standards.map((x) => `<tr><td>${x.cycles_per_set}</td><td>${x.pcs_per_set}</td><td>±${x.tolerance_pct}%</td><td class="small">${fmtDT(x.effective_from)} – ${x.effective_to ? fmtDT(x.effective_to) : 'sekarang'}</td><td class="small">${esc(x.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}</div>`).join('') || '<p class="muted">Belum ada tahap.</p>'}
      </div></section>`).join('')}</div>`;
    const ap = el.querySelector('#addP');
    if (ap) ap.onclick = async () => {
      const r = await modal({ title: 'Produk baru', fields: [{ name: 'id', label: 'Kode produk', required: true }, { name: 'name', label: 'Nama produk', required: true }, { name: 'description', label: 'Deskripsi', type: 'textarea' }], onSubmit: (d) => api('/products', { method: 'POST', body: d }) });
      if (r) { toast('Produk ditambahkan', 'success'); load(); }
    };
    el.querySelectorAll('[data-stage]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: `Tahap proses baru — ${b.dataset.stage}`, fields: [{ name: 'code', label: 'Kode', required: true, half: true }, { name: 'seq', label: 'Urutan', type: 'number', value: 1, half: true }, { name: 'name', label: 'Nama tahap', required: true }],
        onSubmit: (d) => api(`/products/${b.dataset.stage}/stages`, { method: 'POST', body: d }) });
      if (r) load();
    });
    el.querySelectorAll('[data-std]').forEach((b) => b.onclick = async () => {
      const [product_id, stage_id] = b.dataset.std.split('|');
      const r = await modal({ title: 'Tetapkan standar stamping', body: '<p class="small muted">Contoh: Produk A 1 siklus = 1 pcs; Produk B 3 siklus = 1 pcs; Produk C 1 siklus = 2 pcs. Standar sebelumnya berakhir otomatis pada tanggal berlaku baru.</p>',
        fields: [{ name: 'cycles_per_set', label: 'Jumlah siklus', type: 'number', min: 0.01, step: '0.01', value: 1, half: true, required: true }, { name: 'pcs_per_set', label: 'Menghasilkan pcs', type: 'number', min: 0.01, step: '0.01', value: 1, half: true, required: true },
          { name: 'tolerance_pct', label: 'Toleransi penyimpangan (%)', type: 'number', min: 0, max: 100, step: '0.1', value: 5, half: true }, { name: 'date', label: 'Berlaku mulai', type: 'date', value: msToWibDate(Date.now()), half: true },
          { name: 'note', label: 'Alasan / catatan perubahan', type: 'textarea', required: true }],
        onSubmit: (d) => { const today = msToWibDate(Date.now()); const eff = d.date === today ? Date.now() : wibToMs(d.date); return api('/standards', { method: 'POST', body: { ...d, product_id, stage_id: Number(stage_id), effective_from: eff } }); } });
      if (r) { toast('Standar disimpan & tercatat di audit log', 'success'); load(); }
    });
  }
  load();
}
