import { api, esc, badge, modal, toast } from '../util.js';

export async function render(el, ctx) {
  let q = '';
  const machines = await api('/machines');
  async function load() {
    const ops = await api('/operators');
    const list = ops.filter((o) => !q || [o.id, o.name, o.employee_no, o.cards].some((x) => String(x || '').toLowerCase().includes(q)));
    el.innerHTML = `<div class="page-head"><div><h1>Operator & kartu RFID</h1><p>Identitas operator berasal dari kartu RFID. Kartu nonaktif/hilang ditolak saat tap.</p></div>
        <div class="row"><input type="search" id="q" placeholder="Cari nama, ID, UID kartu…" value="${esc(q)}">${ctx.isAdmin ? '<button class="btn btn-primary" id="add">+ Operator</button>' : ''}</div></div>
      <section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ID</th><th>No. karyawan</th><th>Nama</th><th>Status</th><th>Kartu RFID</th><th class="num">Mesin diizinkan</th><th>Sesi aktif</th><th>Input hasil</th>${ctx.isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
        ${list.map((o) => `<tr><td><b>${o.id}</b></td><td>${esc(o.employee_no)}</td><td>${esc(o.name)}<div class="small muted">${esc(o.department || '')}</div></td>
          <td>${badge(o.status === 'active' ? 'ok' : 'muted', o.status === 'active' ? 'Aktif' : 'Nonaktif')}</td>
          <td>${(o.cards || '').split(',').filter(Boolean).map((c) => { const [uid, st] = c.split(':'); return `<div class="row" style="gap:4px"><code>${esc(uid)}</code>${badge(st === 'active' ? 'ok' : st === 'lost' ? 'bad' : 'muted', { active: 'aktif', inactive: 'nonaktif', lost: 'hilang' }[st])}${ctx.isAdmin ? `<button class="btn btn-sm" data-card="${esc(uid)}" data-st="${st}">ubah</button>` : ''}</div>`; }).join('') || '<i class="muted">tidak ada</i>'}</td>
          <td class="num">${o.machine_count}</td><td>${o.active_machine ? `<a href="#/mesin/${o.active_machine}">${o.active_machine}</a>` : '—'}</td><td>${o.can_enter_results ? 'Ya' : 'Tidak'}</td>
          ${ctx.isAdmin ? `<td><div class="row"><button class="btn btn-sm" data-edit="${o.id}">Ubah</button><button class="btn btn-sm" data-newcard="${o.id}">+ Kartu</button></div></td>` : ''}</tr>`).join('')}</tbody></table></div></section>`;
    el.querySelector('#q').oninput = (e) => { q = e.target.value.toLowerCase(); clearTimeout(load.t); load.t = setTimeout(load, 250); };
    const add = el.querySelector('#add');
    if (add) add.onclick = async () => {
      const r = await modal({ title: 'Operator baru', fields: [{ name: 'id', label: 'ID operator', required: true, half: true, placeholder: 'OP101' }, { name: 'employee_no', label: 'No. karyawan', required: true, half: true },
        { name: 'name', label: 'Nama lengkap', required: true }, { name: 'department', label: 'Departemen', value: 'Produksi Stamping' }, { name: 'photo_url', label: 'URL foto (opsional)' },
        { name: 'can_enter_results', label: 'Hak input hasil', type: 'checkbox', checkLabel: 'Boleh mencatat hasil produksi di terminal', value: true }],
      onSubmit: (d) => api('/operators', { method: 'POST', body: d }) });
      if (r) { toast('Operator ditambahkan. Tambahkan kartu RFID, izin mesin, dan penugasan shift.', 'success'); load(); }
    };
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
      const o = await api(`/operators/${b.dataset.edit}`);
      const body = `<div class="field"><label>Izin mesin</label><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(70px,1fr));gap:4px" id="mperm">${machines.map((m) => `<label class="check small"><input type="checkbox" value="${m.id}" ${o.machines.includes(m.id) ? 'checked' : ''}>${m.id}</label>`).join('')}</div>
        <div class="row" style="margin-top:4px"><button type="button" class="btn btn-sm" id="pall">Semua</button><button type="button" class="btn btn-sm" id="pnone">Kosongkan</button></div></div>
        <p class="small muted">Penugasan: ${o.assignments.map((a) => `${esc(a.shift_name)} @ ${a.machine_id}`).join(', ') || 'belum ada'}</p>`;
      const p = modal({ title: `Ubah operator ${o.id}`, wide: true, body, fields: [{ name: 'name', label: 'Nama', value: o.name, required: true }, { name: 'department', label: 'Departemen', value: o.department || '', half: true },
        { name: 'status', label: 'Status karyawan', type: 'select', options: [{ value: 'active', label: 'Aktif' }, { value: 'inactive', label: 'Nonaktif' }], value: o.status, half: true },
        { name: 'photo_url', label: 'URL foto', value: o.photo_url || '' }, { name: 'can_enter_results', label: 'Hak input hasil', type: 'checkbox', checkLabel: 'Boleh mencatat hasil produksi', value: !!o.can_enter_results }],
      onSubmit: (d) => api(`/operators/${o.id}`, { method: 'PUT', body: { ...d, machines: [...document.querySelectorAll('#mperm input:checked')].map((x) => x.value) } }) });
      setTimeout(() => { document.getElementById('pall').onclick = () => document.querySelectorAll('#mperm input').forEach((x) => x.checked = true); document.getElementById('pnone').onclick = () => document.querySelectorAll('#mperm input').forEach((x) => x.checked = false); }, 50);
      if (await p) { toast('Operator diperbarui', 'success'); load(); }
    });
    el.querySelectorAll('[data-newcard]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: `Kartu RFID baru untuk ${b.dataset.newcard}`, fields: [{ name: 'uid', label: 'UID kartu (heksadesimal)', required: true, help: 'Tap kartu pada reader pendaftaran atau ketik UID' }, { name: 'note', label: 'Catatan' }],
        onSubmit: (d) => api('/cards', { method: 'POST', body: { ...d, operator_id: b.dataset.newcard } }) });
      if (r) { toast('Kartu didaftarkan', 'success'); load(); }
    });
    el.querySelectorAll('[data-card]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: `Status kartu ${b.dataset.card}`, fields: [{ name: 'status', label: 'Status', type: 'select', value: b.dataset.st, options: [{ value: 'active', label: 'Aktif' }, { value: 'inactive', label: 'Nonaktif' }, { value: 'lost', label: 'Hilang' }] }, { name: 'note', label: 'Catatan', type: 'textarea' }],
        onSubmit: (d) => api(`/cards/${b.dataset.card}`, { method: 'PUT', body: d }) });
      if (r) { toast('Status kartu diubah', 'success'); load(); }
    });
  }
  load();
}
