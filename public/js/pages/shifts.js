import { api, esc, fmtDT, fmtHM, badge, modal, toast, wibToMs, msToWibDate, msToWibTime } from '../util.js';

const DAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

export async function render(el, ctx) {
  let selShift = 1;
  const [machines, operators] = await Promise.all([api('/machines'), api('/operators')]);
  async function load() {
    const [{ shifts, current }, asg, ot] = await Promise.all([api('/shifts'), api(`/assignments?shift_id=${selShift}`), api('/overtime')]);
    el.innerHTML = `<div class="page-head"><div><h1>Pengaturan 5 shift & penugasan</h1><p>Zona waktu Asia/Jakarta. Shift dapat melewati tengah malam dan tidak harus berurutan. Setiap perubahan disimpan sebagai versi baru; sesi menyimpan salinan jadwal yang berlaku.</p></div></div>
      <div class="notice" style="margin-bottom:14px">Shift berjalan sekarang: ${current.map((c) => `<b>${esc(c.name)}</b> (${fmtHM(c.start)}–${fmtHM(c.end)})`).join(', ') || 'tidak ada'}</div>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr))">${shifts.map((s) => {
        const overnight = s.end_time <= s.start_time;
        return `<section class="panel"><header><h3>${esc(s.name)}</h3>${badge(s.enabled ? 'ok' : 'muted', s.enabled ? 'Aktif' : 'Nonaktif')}</header><div class="body small">
          <div style="font-size:20px;font-weight:700">${s.start_time} – ${s.end_time} ${overnight ? badge('info', 'melewati tengah malam') : ''}</div>
          <div class="muted">Hari mulai: ${s.daysArr.map((d) => DAYS[d - 1]).join(', ') || '—'}</div>
          <div>Istirahat: ${s.breaks.map((b) => `${esc(b.name)} ${b.start_time}–${b.end_time}`).join('; ') || '—'}</div>
          <div>Toleransi terlambat ${s.late_tolerance_min} mnt · login dibuka ${s.early_login_min} mnt sebelum · batas logout ${s.logout_grace_min} mnt</div>
          <div>Lembur: ${s.overtime_enabled ? 'dengan persetujuan supervisor' : 'tidak diizinkan'} · versi ${s.version}</div>
          <div class="row" style="margin-top:8px">${ctx.isAdmin ? `<button class="btn btn-sm" data-edit="${s.id}">Ubah</button>` : ''}<button class="btn btn-sm" data-asg="${s.id}" ${selShift === s.id ? 'disabled' : ''}>Penugasan</button><button class="btn btn-sm" data-ver="${s.id}">Histori</button></div></div></section>`; }).join('')}</div>
      <section class="panel" style="margin-top:14px"><header><h3>Penugasan operator & mesin — ${esc(shifts.find((s) => s.id === selShift)?.name)}</h3>${ctx.isAdmin ? '<button class="btn btn-sm btn-primary" id="addAsg">+ Penugasan</button>' : ''}</header>
        <div class="tbl-wrap" style="max-height:420px"><table class="tbl"><thead><tr><th>Mesin</th><th>Operator</th><th>Berlaku</th>${ctx.isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
        ${asg.map((a) => `<tr><td>${a.machine_id}</td><td>${esc(a.operator_name)} <span class="muted small">${a.operator_id}</span></td><td>${a.valid_from} s.d. ${a.valid_to || 'seterusnya'}</td>${ctx.isAdmin ? `<td><button class="btn btn-sm" data-del="${a.id}">Akhiri</button></td>` : ''}</tr>`).join('') || '<tr><td colspan="4" class="empty">Belum ada penugasan</td></tr>'}</tbody></table></div>
        <div class="body small muted">Sistem menolak penugasan yang bertabrakan: operator atau mesin yang sama pada shift yang waktunya tumpang tindih.</div></section>
      <section class="panel" style="margin-top:14px"><header><h3>Lembur (persetujuan supervisor)</h3><button class="btn btn-sm btn-primary" id="addOt">+ Pengajuan lembur</button></header>
        <div class="tbl-wrap" style="max-height:320px"><table class="tbl"><thead><tr><th>Operator</th><th>Mesin</th><th>Waktu</th><th>Alasan</th><th>Status</th><th></th></tr></thead><tbody>
        ${ot.map((o) => `<tr><td>${esc(o.operator_name)}</td><td>${o.machine_id}</td><td>${fmtDT(o.start_at)} – ${fmtHM(o.end_at)}</td><td>${esc(o.reason || '')}</td><td>${badge({ approved: 'ok', pending: 'warn', rejected: 'bad', cancelled: 'muted' }[o.status], { approved: 'Disetujui', pending: 'Menunggu', rejected: 'Ditolak', cancelled: 'Batal' }[o.status])}</td>
          <td>${o.status === 'pending' ? `<div class="row"><button class="btn btn-sm" data-ot="${o.id}" data-d="approve">Setujui</button><button class="btn btn-sm" data-ot="${o.id}" data-d="reject">Tolak</button></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Belum ada</td></tr>'}</tbody></table></div></section>`;

    el.querySelectorAll('[data-asg]').forEach((b) => b.onclick = () => { selShift = Number(b.dataset.asg); load(); });
    el.querySelectorAll('[data-ver]').forEach((b) => b.onclick = async () => {
      const v = await api(`/shifts/${b.dataset.ver}/versions`);
      modal({ title: 'Histori jadwal shift', wide: true, submit: 'Tutup', body: `<table class="tbl"><thead><tr><th>Versi</th><th>Waktu</th><th>Jadwal</th><th>Istirahat</th></tr></thead><tbody>${v.map((x) => { const s = JSON.parse(x.snapshot); return `<tr><td>v${x.version}</td><td>${fmtDT(x.changed_at)}</td><td>${s.enabled ? '' : '(nonaktif) '}${s.start_time}–${s.end_time} · hari ${s.days}</td><td>${(s.breaks || []).map((b) => `${b.start_time}–${b.end_time}`).join(', ')}</td></tr>`; }).join('')}</tbody></table>` });
    });
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editShift(shifts.find((s) => s.id === Number(b.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      const r = await modal({ title: 'Akhiri penugasan', fields: [{ name: 'reason', label: 'Alasan', type: 'textarea' }], danger: true, submit: 'Akhiri', onSubmit: (d) => api(`/assignments/${b.dataset.del}`, { method: 'DELETE', body: d }) });
      if (r) load();
    });
    const aa = el.querySelector('#addAsg');
    if (aa) aa.onclick = async () => {
      const r = await modal({ title: 'Penugasan baru', fields: [
        { name: 'shift_id', label: 'Shift', type: 'select', value: selShift, options: shifts.map((s) => ({ value: s.id, label: s.name })) },
        { name: 'operator_id', label: 'Operator', type: 'select', options: operators.filter((o) => o.status === 'active').map((o) => ({ value: o.id, label: `${o.id} — ${o.name}` })) },
        { name: 'machine_id', label: 'Mesin', type: 'select', options: machines.map((m) => ({ value: m.id, label: m.id })) },
        { name: 'valid_from', label: 'Berlaku mulai', type: 'date', value: msToWibDate(Date.now()), half: true }, { name: 'valid_to', label: 'Sampai (opsional)', type: 'date', half: true }],
      onSubmit: (d) => api('/assignments', { method: 'POST', body: d }) });
      if (r) { toast('Penugasan disimpan', 'success'); load(); }
    };
    el.querySelector('#addOt').onclick = async () => {
      const now = Date.now();
      const r = await modal({ title: 'Pengajuan & persetujuan lembur', fields: [
        { name: 'operator_id', label: 'Operator', type: 'select', options: operators.filter((o) => o.status === 'active').map((o) => ({ value: o.id, label: `${o.id} — ${o.name}` })) },
        { name: 'machine_id', label: 'Mesin', type: 'select', options: machines.map((m) => ({ value: m.id, label: m.id })) },
        { name: 'shift_id', label: 'Terkait shift', type: 'select', options: [{ value: '', label: '—' }, ...shifts.map((s) => ({ value: s.id, label: s.name }))] },
        { name: 'date', label: 'Tanggal', type: 'date', value: msToWibDate(now), half: true }, { name: 'start', label: 'Mulai', type: 'time', value: msToWibTime(now), half: true },
        { name: 'hours', label: 'Durasi (jam)', type: 'number', min: 0.5, step: '0.5', value: 2, half: true }, { name: 'reason', label: 'Alasan', type: 'textarea', required: true }],
      onSubmit: (d) => { const s = wibToMs(d.date, d.start); return api('/overtime', { method: 'POST', body: { ...d, start_at: s, end_at: s + Number(d.hours) * 3600e3 } }); } });
      if (r) { toast('Pengajuan lembur dibuat — menunggu persetujuan', 'success'); load(); }
    };
    el.querySelectorAll('[data-ot]').forEach((b) => b.onclick = async () => { await api(`/overtime/${b.dataset.ot}/${b.dataset.d}`, { method: 'POST', body: {} }); toast('Keputusan lembur dicatat', 'success'); load(); });
  }

  async function editShift(s) {
    const breaksHtml = (list) => list.map((b, i) => `<div class="row brk" style="margin-bottom:4px"><input value="${esc(b.name)}" data-k="name" style="flex:1" aria-label="Nama istirahat"><input type="time" value="${b.start_time}" data-k="start_time" aria-label="Mulai"><input type="time" value="${b.end_time}" data-k="end_time" aria-label="Selesai"><button type="button" class="btn btn-sm" data-rm="${i}">✕</button></div>`).join('');
    const body = `<div class="field"><label>Hari operasional (hari mulai shift)</label><div class="row" id="days">${DAYS.map((d, i) => `<label class="check"><input type="checkbox" value="${i + 1}" ${s.daysArr.includes(i + 1) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
      <div class="field" style="margin-top:10px"><label>Periode istirahat</label><div id="brks">${breaksHtml(s.breaks)}</div><button type="button" class="btn btn-sm" id="addBrk">+ Istirahat</button></div><div style="height:10px"></div>`;
    const p = modal({ title: `Ubah ${s.name}`, wide: true, body, fields: [
      { name: 'name', label: 'Nama shift', value: s.name, required: true }, { name: 'enabled', label: 'Status', type: 'checkbox', checkLabel: 'Shift aktif', value: !!s.enabled },
      { name: 'start_time', label: 'Jam mulai', type: 'time', value: s.start_time, half: true, required: true }, { name: 'end_time', label: 'Jam selesai', type: 'time', value: s.end_time, half: true, required: true, help: 'Lebih awal dari jam mulai = melewati tengah malam' },
      { name: 'late_tolerance_min', label: 'Toleransi terlambat (menit)', type: 'number', min: 0, value: s.late_tolerance_min, half: true }, { name: 'early_login_min', label: 'Login dibuka sebelum shift (menit)', type: 'number', min: 0, value: s.early_login_min, half: true },
      { name: 'logout_grace_min', label: 'Batas peringatan "Belum logout" (menit)', type: 'number', min: 0, value: s.logout_grace_min, half: true }, { name: 'overtime_enabled', label: 'Lembur', type: 'checkbox', checkLabel: 'Izinkan lembur dengan persetujuan supervisor', value: !!s.overtime_enabled, half: true }],
    onSubmit: (d) => {
      const days = [...document.querySelectorAll('#days input:checked')].map((x) => x.value).join(',');
      const breaks = [...document.querySelectorAll('#brks .brk')].map((r) => ({ name: r.querySelector('[data-k=name]').value, start_time: r.querySelector('[data-k=start_time]').value, end_time: r.querySelector('[data-k=end_time]').value }));
      return api(`/shifts/${s.id}`, { method: 'PUT', body: { ...d, days, breaks, enabled: d.enabled ? 1 : 0, overtime_enabled: d.overtime_enabled ? 1 : 0 } });
    } });
    const bind = () => {
      document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => b.closest('.brk').remove());
    };
    setTimeout(() => { bind(); document.getElementById('addBrk').onclick = () => { document.getElementById('brks').insertAdjacentHTML('beforeend', breaksHtml([{ name: 'Istirahat', start_time: '12:00', end_time: '12:30' }])); bind(); }; }, 30);
    if (await p) { toast('Shift disimpan sebagai versi baru', 'success'); load(); }
  }
  load();
}
