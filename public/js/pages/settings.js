import { api, esc, badge, modal, toast } from '../util.js';

const GROUPS = [
  ['Umum', [['plant_name', 'Nama pabrik / lini', 'text']]],
  ['RFID & sesi', [['tap_debounce_s', 'Abaikan tap kartu sama berulang dalam (detik)', 'number'], ['min_session_before_logout_s', 'Tap setelah login tidak dianggap logout selama (detik)', 'number'],
    ['tap_max_age_s', 'Tap lebih lama dari ini (tersimpan offline) tidak diproses (detik)', 'number'], ['command_timeout_s', 'Batas waktu konfirmasi pengendali (detik)', 'number'],
    ['allow_login_unassigned_machine', 'Izinkan login di mesin selain penugasan shift', 'bool'], ['operator_can_enter_results', 'Operator boleh mencatat hasil produksi di terminal', 'bool']]],
  ['Deteksi keberadaan (global)', [['absence_threshold_s', 'Ambang ketidakhadiran (detik)', 'number'], ['return_confirm_s', 'Konfirmasi orang kembali (detik)', 'number'], ['min_confidence', 'Keyakinan deteksi minimum (0–1)', 'number'],
    ['min_quality', 'Kualitas citra minimum (0–1)', 'number'], ['min_roi_overlap', 'Proporsi minimum di dalam ROI (0–1)', 'number'], ['stamp_while_absent_tolerance_s', 'Toleransi sinkronisasi waktu untuk penandaan stamping saat tidak terdeteksi (detik)', 'number']]],
  ['Perangkat & jaringan', [['heartbeat_timeout_s', 'Perangkat lokal dianggap terputus setelah (detik)', 'number'], ['clock_skew_warn_ms', 'Peringatan selisih jam perangkat (ms)', 'number'],
    ['offline_policy', 'Perilaku saat koneksi terputus (tetapkan bersama teknisi)', 'select', [['keep_session_no_new_login', 'Sesi berjalan dipertahankan oleh PLC; login baru ditolak']]]]],
  ['Privasi & retensi', [['record_video', 'Simpan rekaman video (default: tidak)', 'bool'], ['video_retention_days', 'Retensi rekaman video (hari)', 'number'], ['data_retention_days', 'Retensi kejadian mentah (hari)', 'number'], ['monitoring_notice', 'Pemberitahuan pemantauan untuk pekerja', 'textarea']]],
];

export async function render(el, ctx) {
  const s = await api('/settings');
  const users = ctx.isAdmin ? await api('/users') : [];
  const machines = await api('/machines');
  const input = ([k, , t, opts]) => {
    const dis = ctx.isAdmin ? '' : 'disabled';
    if (t === 'bool') return `<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''} ${dis}> Ya</label>`;
    if (t === 'textarea') return `<textarea name="${k}" rows="4" ${dis}>${esc(s[k])}</textarea>`;
    if (t === 'select') return `<select name="${k}" ${dis}>${opts.map(([v, l]) => `<option value="${v}" ${s[k] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    return `<input type="${t}" name="${k}" value="${esc(s[k])}" ${t === 'number' ? 'step="any" min="0"' : ''} ${dis}>`;
  };
  el.innerHTML = `<div class="page-head"><div><h1>Pengaturan sistem</h1><p>Mode: ${ctx.info.simulation ? badge('warn', 'SIMULASI') : badge('ok', 'Produksi')} · Zona waktu Asia/Jakarta</p></div></div>
    <form id="sf" class="grid g2">${GROUPS.map(([g, items]) => `<section class="panel"><header><h3>${g}</h3></header><div class="body"><div class="form-grid">${items.map((it) => `<div class="field"><label>${esc(it[1])}</label>${input(it)}</div>`).join('')}</div></div></section>`).join('')}</form>
    ${ctx.isAdmin ? `<div class="row" style="margin:14px 0"><button class="btn btn-primary" id="save">Simpan pengaturan</button><button class="btn" id="ret">Jalankan retensi data</button></div>
    <section class="panel"><header><h3>Pengguna & hak akses</h3><button class="btn btn-sm btn-primary" id="addU">+ Pengguna</button></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pengguna</th><th>Nama</th><th>Peran</th><th>Kewenangan mesin</th><th>Status</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><code>${esc(u.username)}</code></td><td>${esc(u.name)}</td><td>${u.role === 'admin' ? 'Admin' : 'Supervisor'}</td><td class="small">${u.role === 'admin' ? 'Semua' : u.machines.length ? u.machines.join(', ') : 'Semua mesin'}</td><td>${badge(u.active ? 'ok' : 'muted', u.active ? 'Aktif' : 'Nonaktif')}</td><td><button class="btn btn-sm" data-u="${u.id}">Ubah</button></td></tr>`).join('')}</tbody></table></div>
      <div class="body small muted">Admin: kelola master data, perangkat, parameter, retensi, audit. Supervisor: pantau mesin dalam kewenangan, verifikasi produksi & penyimpangan, izin & lembur, pergantian operator, koreksi klasifikasi, ekspor laporan. Operator: login/logout RFID & input hasil di terminal.</div></section>` : '<p class="muted">Hanya admin yang dapat mengubah pengaturan.</p>'}`;
  if (!ctx.isAdmin) return;
  el.querySelector('#save').onclick = async () => {
    const f = el.querySelector('#sf'); const body = {};
    for (const [, items] of GROUPS) for (const [k, , t] of items) { const i = f.elements[k]; body[k] = t === 'bool' ? i.checked : t === 'number' ? Number(i.value) : i.value; }
    try { await api('/settings', { method: 'PUT', body }); toast('Pengaturan disimpan & tercatat di audit log', 'success'); } catch (e) { toast(e.message, 'error'); }
  };
  el.querySelector('#ret').onclick = async () => {
    const r = await modal({ title: 'Jalankan retensi data', body: `<p>Menghapus kejadian mentah & tap yang lebih lama dari ${s.data_retention_days} hari. Data sesi, stamping, produksi, dan audit tetap dipertahankan.</p>`, danger: true, submit: 'Jalankan', onSubmit: () => api('/maintenance/retention', { method: 'POST' }) });
    if (r) toast(`Selesai: ${JSON.stringify(r)}`, 'success');
  };
  const userForm = async (u) => {
    const body = `<div class="field"><label>Kewenangan mesin (supervisor; kosong = semua)</label><div id="um" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:4px">${machines.map((m) => `<label class="check small"><input type="checkbox" value="${m.id}" ${u?.machines.includes(m.id) ? 'checked' : ''}>${m.id}</label>`).join('')}</div></div>`;
    const r = await modal({ title: u ? `Ubah ${u.username}` : 'Pengguna baru', wide: true, body, fields: [
      ...(u ? [] : [{ name: 'username', label: 'Nama pengguna', required: true, half: true }]), { name: 'name', label: 'Nama', value: u?.name || '', required: true, half: true },
      { name: 'role', label: 'Peran', type: 'select', value: u?.role || 'supervisor', options: [{ value: 'supervisor', label: 'Supervisor' }, { value: 'admin', label: 'Admin' }], half: true },
      { name: 'password', label: u ? 'Kata sandi baru (opsional)' : 'Kata sandi', type: 'password', required: !u, half: true, help: 'Minimal 8 karakter' },
      ...(u ? [{ name: 'active', label: 'Status', type: 'checkbox', checkLabel: 'Aktif', value: !!u.active }] : [])],
    onSubmit: (d) => { const machinesSel = [...document.querySelectorAll('#um input:checked')].map((x) => x.value); if (!d.password) delete d.password; return u ? api(`/users/${u.id}`, { method: 'PUT', body: { ...d, machines: machinesSel } }) : api('/users', { method: 'POST', body: { ...d, machines: machinesSel } }); } });
    if (r) { toast('Pengguna disimpan', 'success'); render(el, ctx); }
  };
  el.querySelector('#addU').onclick = () => userForm(null);
  el.querySelectorAll('[data-u]').forEach((b) => b.onclick = () => userForm(users.find((x) => String(x.id) === b.dataset.u)));
}
