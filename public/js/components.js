// Komponen bersama: panel simulasi, timeline sesi, formulir hasil produksi
import { api, esc, fmtHM, fmtT, fmtDT, fmtDur, fmtNum, signed, toast, modal, badge, STATUS, CATEGORY, CLASS_LABEL } from './util.js';

// ---------------- Panel simulasi ----------------
let cardCache = null;
export async function simPanel(container, machineId, onDone) {
  if (!cardCache) cardCache = await api('/sim/cards').catch(() => []);
  const st = await api(`/sim/${machineId}`);
  const opts = cardCache.map((c) => `<option value="${esc(c.uid)}">${esc(c.uid)} — ${esc(c.name || '?')} (${esc(c.operator_id || '-')})${c.status !== 'active' ? ' [kartu ' + c.status + ']' : ''}${c.operator_status === 'inactive' ? ' [karyawan nonaktif]' : ''}</option>`).join('');
  const b = (act, label, params = {}, cls = '') => `<button class="btn btn-sm btn-sim ${cls}" data-act="${act}" data-p='${esc(JSON.stringify(params))}'>${label}</button>`;
  container.innerHTML = `<section class="panel simpanel" aria-label="Panel simulasi">
    <header><h3>🧪 Panel simulasi perangkat — ${esc(machineId)}</h3><span class="small">Data yang dibuat di sini ditandai <span class="badge b-sim">Simulasi</span></span></header>
    <div class="body">
      <div class="small muted" style="margin-bottom:8px">Status virtual: jaringan <b>${st.online ? 'terhubung' : 'TERPUTUS'}</b> (antrean lokal ${st.queue_length}) · PLC <b>${esc(st.physical)}</b>, izin ${st.permission ? 'ya' : 'tidak'}, mode respons <b>${esc(st.controller_mode)}</b> · daya ${esc(st.power)} · kamera ${esc(st.camera)} · orang ${st.present ? 'terdeteksi' : 'tidak terdeteksi'} · counter PLC ${st.plc_counter}${st.auto ? ' · siklus otomatis aktif' : ''}</div>
      <div class="grp"><b>RFID</b><div class="row"><select class="simcard" style="max-width:340px">${opts}<option value="DEADBEEF99">DEADBEEF99 — kartu tidak dikenal</option></select>
        <button class="btn btn-sm btn-sim" data-tap="1">Tap kartu</button><button class="btn btn-sm btn-sim" data-tap="2">Tap ganda cepat</button></div></div>
      <div class="grp"><b>Kamera (deteksi keberadaan tanpa pengenalan wajah)</b><div class="row">
        ${b('presence', '👤 Orang di area kerja', { present: true })}${b('presence', '∅ Tidak ada orang', { present: false })}${b('presence', '🚶 Orang lewat di luar ROI', { present: true, outside_roi: true })}
        ${b('camera', 'Kamera terputus', { status: 'offline' })}${b('camera', 'Kamera tertutup', { status: 'obstructed' })}${b('quality', 'Kualitas buruk', { quality: 0.2 })}${b('camera', 'Kamera normal', { status: 'ok' })}
        ${b('auto_presence', st.auto_presence ? 'Keberadaan acak: ON' : 'Keberadaan acak: OFF', { on: !st.auto_presence })}</div></div>
      <div class="grp"><b>Mesin / PLC (Start tetap tombol fisik; Stop & E-stop tanpa kartu)</b><div class="row">
        ${b('start', '▶ Tombol Start')}${b('stop', '■ Tombol Stop')}${b('estop', '⛔ Emergency stop', {}, 'btn-danger')}${b('estop_reset', 'Reset E-stop')}
        ${b('power', 'Listrik padam', { on: false })}${b('power', 'Listrik pulih', { on: true })}</div></div>
      <div class="grp"><b>Respons pengendali terhadap perintah izin/stop</b><div class="row">
        ${['ack', 'fail', 'timeout', 'unsafe'].map((m) => b('controller_mode', { ack: 'Normal (konfirmasi)', fail: 'Gagal/ditolak', timeout: 'Tidak merespons', unsafe: 'Stop belum aman' }[m] + (st.controller_mode === m ? ' ✓' : ''), { mode: m })).join('')}
        ${b('controller_link', st.controller_link ? 'Putuskan PLC' : 'Sambungkan PLC', { on: !st.controller_link })}</div></div>
      <div class="grp"><b>Sensor siklus stamping</b><div class="row">
        ${b('cycle', '+1 siklus')}${b('bounce', 'Sinyal memantul (bounce)')}${b('resend_counter', 'Kirim ulang counter sama')}
        ${b('stuck', st.sensor_stuck ? 'Lepas sinyal tertahan' : 'Sinyal tertahan', { on: !st.sensor_stuck })}${b('counter_reset', 'Reset counter PLC')}
        <label class="small">Interval otomatis <select data-cms><option value="2000">2 dtk</option><option value="5000" selected>5 dtk</option><option value="10000">10 dtk</option></select></label></div></div>
      <div class="grp"><b>Jaringan & perangkat lokal</b><div class="row">
        ${b('network', 'Putuskan jaringan', { online: false })}${b('network', 'Pulihkan & sinkronkan', { online: true })}${b('resync', 'Kirim ulang batch terakhir')}${b('edge_restart', 'Restart perangkat lokal')}</div></div>
    </div></section>`;
  const run = async (act, params) => {
    try {
      const r = await api(`/sim/${machineId}/${act}`, { method: 'POST', body: params });
      const one = Array.isArray(r) ? r : [r];
      const msgs = one.map((x) => x?.terminal?.message || x?.outcome || (x?.synced != null ? `Tersinkron ${x.synced} kejadian, duplikat ${x.duplicates}` : x?.resent != null ? `Dikirim ulang ${x.resent}, ditolak sebagai duplikat ${x.duplicates}` : x?.error || (x?.status === 'queued' ? 'Disimpan di antrean lokal (offline)' : 'OK')));
      toast(msgs.join(' | '), one.some((x) => x?.ok === false || String(x?.outcome || '').startsWith('REJECTED')) ? 'warning' : 'info');
    } catch (e) { toast(e.message, 'error'); }
    setTimeout(() => { simPanel(container, machineId, onDone); onDone && onDone(); }, 700);
  };
  container.querySelectorAll('[data-act]').forEach((x) => x.onclick = () => run(x.dataset.act, JSON.parse(x.dataset.p)));
  container.querySelectorAll('[data-tap]').forEach((x) => x.onclick = () => run(x.dataset.tap === '2' ? 'double_tap' : 'tap', { uid: container.querySelector('.simcard').value }));
  container.querySelector('[data-cms]').value = String(st.cycle_ms <= 2000 ? 2000 : st.cycle_ms >= 10000 ? 10000 : 5000);
  container.querySelector('[data-cms]').onchange = (e) => run('cycle_ms', { ms: Number(e.target.value) });
  const sel = container.querySelector('.simcard'); const remembered = sessionStorage.getItem(`simcard_${machineId}`);
  if (remembered) sel.value = remembered;
  sel.onchange = () => { try { sessionStorage.setItem(`simcard_${machineId}`, sel.value); } catch { /* */ } };
}

// ---------------- Timeline ----------------
export function timelineHtml(tl) {
  const span = Math.max(1, tl.end - tl.start);
  const pct = (t) => ((Math.min(Math.max(t, tl.start), tl.end) - tl.start) / span) * 100;
  const segs = tl.pieces.map((p) => `<div class="seg ${p.label}" style="left:${pct(p.start)}%;width:${Math.max(0.15, pct(p.end) - pct(p.start))}%" title="${esc(LBL[p.label])}: ${fmtT(p.start)}–${fmtT(p.end)} (${fmtDur(p.end - p.start)})"></div>`).join('');
  const flags = tl.flagged.map((f) => `<div class="tl-flag" style="left:${pct(f.start)}%;width:${Math.max(0.3, pct(f.end) - pct(f.start))}%" title="${esc(f.note)} (${f.count} siklus)"></div>`).join('');
  const minutes = new Map();
  for (const s of tl.stamps) { const m = minutes.get(s.minute) || { n: 0, cat: s.category }; m.n += s.n; if (s.category !== 'normal') m.cat = s.category; minutes.set(s.minute, m); }
  const maxN = Math.max(1, ...[...minutes.values()].map((x) => x.n));
  const bw = Math.max(0.12, 60000 / span * 100);
  const bars = [...minutes.entries()].map(([t, m]) => `<div class="bar c-${m.cat}" style="left:${pct(t)}%;width:${bw}%;height:${(m.n / maxN) * 100}%" title="${fmtHM(t)}: ${m.n} siklus (${esc(CATEGORY[m.cat] || m.cat)})"></div>`).join('');
  const ticks = [];
  const step = span > 6 * 3600e3 ? 3600e3 : span > 2 * 3600e3 ? 1800e3 : span > 40 * 60e3 ? 600e3 : 300e3;
  for (let t = Math.ceil(tl.start / step) * step; t < tl.end; t += step) ticks.push(`<span style="left:${pct(t)}%">${fmtHM(t)}</span>`);
  const jobs = tl.jobs.map((j) => `<div class="seg" style="left:${pct(j.started_at)}%;width:${Math.max(0.3, pct(j.ended_at || tl.end) - pct(j.started_at))}%;background:${j.category === 'normal' ? '#dbe7fb' : j.category === 'rework' ? '#eadcfd' : '#fde9c4'};border-right:2px solid #fff;font-size:10.5px;padding:2px 4px;overflow:hidden;white-space:nowrap" title="${esc(j.work_order_id)} · ${esc(CATEGORY[j.category])} · ${fmtT(j.started_at)}–${j.ended_at ? fmtT(j.ended_at) : 'berjalan'}">${esc(j.work_order_id)} ${j.category !== 'normal' ? '· ' + esc(CATEGORY[j.category]) : ''}</div>`).join('');
  return `<div class="small muted" style="margin-bottom:4px">${fmtDT(tl.start)} → ${tl.session.logout_at ? fmtDT(tl.end) : 'sekarang'} · keberadaan, pekerjaan, dan stamping per menit</div>
    <div class="tl" aria-label="Timeline keberadaan">${segs}${flags}</div>
    <div class="tl" style="height:20px;margin-top:3px;background:#fff" aria-label="Timeline pekerjaan">${jobs}</div>
    <div class="tl-stamps" aria-label="Stamping per menit">${bars}</div><div class="tl-axis">${ticks.join('')}</div>
    <div class="legend"><span><i class="seg present" style="position:static;display:inline-block"></i>Hadir</span><span><i style="background:#d9443a"></i>Tidak hadir</span><span><i style="background:#7aa5e6"></i>Istirahat terjadwal</span>
      <span><i style="background:#a78bfa"></i>Izin</span><span><i style="background:#aab3bf"></i>Pemantauan tidak tersedia</span><span><i style="background:#2f6fde"></i>Stamping normal</span><span><i style="background:#f59e0b"></i>Setup/uji coba</span><span><i style="background:#a855f7"></i>Rework</span>
      <span><i style="border:2px dashed #b42318;background:none"></i>Stamping saat tidak terdeteksi — perlu ditinjau</span></div>
    ${tl.flagged.length ? `<div class="notice warn" style="margin-top:8px">⚑ ${tl.flagged.length} rentang dengan stamping saat kamera tidak mendeteksi orang. Ini indikator pemeriksaan (pertimbangkan mode operasi, kualitas deteksi, sinkronisasi waktu), bukan bukti pelanggaran.</div>` : ''}`;
}
const LBL = { present: 'Hadir', absent: 'Tidak hadir', break: 'Istirahat terjadwal', leave: 'Izin', unknown: 'Pemantauan tidak tersedia' };

// ---------------- Kejadian keberadaan ----------------
export function absenceTable(events, { canCorrect = true } = {}) {
  if (!events.length) return '<div class="empty">Tidak ada kejadian.</div>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Jenis</th><th>Mulai</th><th>Selesai</th><th class="num">Durasi</th><th>Klasifikasi asli</th><th>Koreksi</th><th>Verifikasi</th><th>Penyebab</th>${canCorrect ? '<th></th>' : ''}</tr></thead><tbody>
    ${events.map((e) => `<tr><td>${e.kind === 'ABSENCE' ? badge('bad', 'Tidak terdeteksi') : badge('muted', 'Pemantauan tdk tersedia')} ${e.simulated ? '<span class="badge b-sim">Sim</span>' : ''}</td>
      <td>${fmtDT(e.start_at)}</td><td>${e.end_at ? fmtT(e.end_at) : '<i>berlangsung</i>'}</td><td class="num">${fmtDur(e.end_at ? e.duration_ms : e.current_duration_ms)}</td>
      <td>${esc(CLASS_LABEL[e.classification] || e.classification)}</td><td>${e.corrected_classification ? `<b>${esc(CLASS_LABEL[e.corrected_classification])}</b><div class="small muted">${esc(e.correction_reason || '')}</div>` : '—'}</td>
      <td>${badge(e.verification_status === 'UNVERIFIED' ? 'warn' : 'ok', { UNVERIFIED: 'Belum diverifikasi', VERIFIED: 'Terverifikasi', CORRECTED: 'Dikoreksi' }[e.verification_status])}</td>
      <td class="small">${esc(e.cause || '')}</td>
      ${canCorrect ? `<td><div class="row"><button class="btn btn-sm" data-corr="${e.id}">Koreksi</button>${e.verification_status === 'UNVERIFIED' ? `<button class="btn btn-sm" data-ver="${e.id}">Verifikasi</button>` : ''}</div></td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}
export function bindAbsenceActions(root, reload) {
  root.querySelectorAll('[data-corr]').forEach((b) => b.onclick = async () => {
    const r = await modal({ title: 'Koreksi klasifikasi kejadian', body: '<p class="small muted">Klasifikasi asli tetap tersimpan. Koreksi dan alasannya tercatat di audit log.</p>', fields: [
      { name: 'classification', label: 'Klasifikasi baru', type: 'select', options: Object.entries(CLASS_LABEL).map(([value, label]) => ({ value, label })) },
      { name: 'reason', label: 'Alasan koreksi', type: 'textarea', required: true, placeholder: 'mis. Operator mengambil material atas instruksi supervisor' }],
    onSubmit: (d) => api(`/presence/${b.dataset.corr}/correct`, { method: 'POST', body: d }) });
    if (r) { toast('Klasifikasi dikoreksi', 'success'); reload(); }
  });
  root.querySelectorAll('[data-ver]').forEach((b) => b.onclick = async () => {
    const r = await modal({ title: 'Verifikasi kejadian', body: '<p>Tandai kejadian ini sudah diperiksa supervisor dengan klasifikasi saat ini.</p>', fields: [{ name: 'note', label: 'Catatan (opsional)', type: 'textarea' }],
      submit: 'Verifikasi', onSubmit: (d) => api(`/presence/${b.dataset.ver}/verify`, { method: 'POST', body: d }) });
    if (r) { toast('Kejadian diverifikasi', 'success'); reload(); }
  });
}

// ---------------- Produksi per pekerjaan ----------------
export function jobsTable(jobs, { actions = true } = {}) {
  if (!jobs.length) return '<div class="empty">Belum ada pekerjaan dalam sesi ini.</div>';
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pekerjaan</th><th>Kategori</th><th>Waktu</th><th class="num">Stamping</th><th>Standar</th><th class="num">Baik</th><th class="num">Reject</th><th class="num">Rework</th><th class="num">WIP</th>
    <th class="num">Dasar pcs</th><th class="num">Siklus standar</th><th class="num">Selisih</th><th>Status</th><th>Hasil</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
    ${jobs.map((a) => { const j = a.job, r = a.result; return `<tr>
      <td><b>${esc(j.work_order_id || '-')}</b><div class="small muted">${esc(j.product_name || j.product_id || '')} ${esc(j.stage_name || '')}</div></td><td>${esc(CATEGORY[j.category])}</td>
      <td class="small">${fmtHM(j.started_at)}–${j.ended_at ? fmtHM(j.ended_at) : 'berjalan'}</td><td class="num">${fmtNum(a.cycles.total)}</td>
      <td class="small">${a.standard ? `${a.standard.cycles_per_set} siklus = ${a.standard.pcs_per_set} pcs (±${a.standard.tolerance_pct}%)` : '<i>Belum tersedia</i>'}</td>
      <td class="num">${r ? fmtNum(j.category === 'rework' ? r.rework_good_qty : r.good_qty) : '—'}</td><td class="num">${r ? fmtNum(r.reject_completed_qty + r.reject_incomplete_qty) : '—'}</td>
      <td class="num">${r ? fmtNum(r.rework_qty) : '—'}</td><td class="num">${r ? fmtNum(r.wip_qty) : '—'}</td><td class="num">${fmtNum(a.qty.basis_pcs)}</td>
      <td class="num">${fmtNum(a.standard_cycles, 2)}</td><td class="num">${a.diff == null ? '—' : `${signed(a.diff, 2)}<div class="small">${a.diff_pct == null ? '' : signed(a.diff_pct, 1) + '%'}</div>`}</td>
      <td>${badge(STATUS.prod[a.status] || 'muted', a.status_label)}${a.completeness?.length ? `<div class="small muted">${esc(a.completeness.join('; '))}</div>` : ''}</td>
      <td class="small">${r ? `${badge(r.verification_status === 'VERIFIED' ? 'ok' : r.verification_status === 'DISPUTED' ? 'bad' : 'warn', { VERIFIED: 'Terverifikasi', DISPUTED: 'Dipersoalkan', UNVERIFIED: 'Belum diverifikasi' }[r.verification_status])}<div>${esc(r.source)} · ${r.is_final ? 'final' : 'sementara'} · v${r.version}</div>${r.deviation_explanation ? `<div>“${esc(r.deviation_explanation)}”</div>` : ''}` : '<i>Belum diinput</i>'}</td>
      ${actions ? `<td><div class="row"><button class="btn btn-sm" data-res="${j.id}">${r ? 'Koreksi hasil' : 'Input hasil'}</button>${r ? `<button class="btn btn-sm" data-verify="${r.id}">Verifikasi</button><button class="btn btn-sm" data-hist="${r.id}">Histori</button>` : ''}</div></td>` : ''}</tr>`; }).join('')}
  </tbody></table></div>
  <p class="small muted">${esc(jobs[0]?.basis_explanation || '')} Rumus: siklus standar = dasar pcs × siklus standar ÷ pcs standar; selisih = siklus produksi normal − siklus standar − siklus rekonsiliasi.</p>`;
}
export function resultFields(job, r = {}) {
  const isRw = job.category === 'rework';
  const f = [
    ...(isRw ? [{ name: 'rework_qty', label: 'Jumlah pcs yang di-rework', type: 'number', min: 0, value: r.rework_qty ?? 0, half: true },
      { name: 'rework_good_qty', label: 'Rework menjadi baik', type: 'number', min: 0, value: r.rework_good_qty ?? 0, half: true, help: 'Dihitung sekali sebagai produk baik' }]
      : [{ name: 'good_qty', label: 'Produk baik (lolos pertama)', type: 'number', min: 0, value: r.good_qty ?? 0, half: true },
        { name: 'rework_qty', label: 'Dikirim ke rework', type: 'number', min: 0, value: r.rework_qty ?? 0, half: true, help: 'Belum dihitung sebagai produk baik' }]),
    { name: 'reject_completed_qty', label: 'Reject setelah tahap selesai', type: 'number', min: 0, value: r.reject_completed_qty ?? 0, half: true },
    ...(isRw ? [] : [{ name: 'reject_incomplete_qty', label: 'Reject sebelum tahap selesai', type: 'number', min: 0, value: r.reject_incomplete_qty ?? 0, half: true },
      { name: 'wip_qty', label: 'Produk dalam proses (WIP)', type: 'number', min: 0, value: r.wip_qty ?? 0, half: true }]),
    { name: 'reject_reasons', label: 'Alasan reject', type: 'text', value: r.reject_reasons || '', placeholder: 'mis. retak, sudut tidak sesuai' },
    { name: 'rework_reasons', label: 'Alasan rework', type: 'text', value: r.rework_reasons || '' },
    { name: 'is_final', label: 'Status data', type: 'checkbox', checkLabel: 'Hasil final (pekerjaan selesai dihitung)', value: !!r.is_final },
  ];
  if (r.id) f.push({ name: 'reason', label: 'Alasan koreksi', type: 'textarea', required: true, help: 'Versi sebelumnya tetap tersimpan di histori & audit log' });
  return f;
}
export function bindJobActions(root, jobs, reload) {
  root.querySelectorAll('[data-res]').forEach((b) => b.onclick = async () => {
    const a = jobs.find((x) => String(x.job.id) === b.dataset.res);
    const r = await modal({ title: `${a.result ? 'Koreksi' : 'Input'} hasil produksi — ${a.job.work_order_id} (${CATEGORY[a.job.category]})`, fields: resultFields(a.job, a.result || {}),
      onSubmit: (d) => api(`/jobs/${a.job.id}/result`, { method: 'POST', body: d }) });
    if (r) { toast('Hasil produksi disimpan', 'success'); reload(); }
  });
  root.querySelectorAll('[data-verify]').forEach((b) => b.onclick = async () => {
    const a = jobs.find((x) => String(x.result?.id) === b.dataset.verify);
    const r = await modal({ title: 'Verifikasi hasil & penyimpangan', body: `<div class="notice">Stamping normal ${a.cycles.normal}, siklus standar ${a.standard_cycles ?? '—'}, selisih ${a.diff ?? '—'} (${a.diff_pct ?? '—'}%). Status: <b>${esc(a.status_label)}</b>.<br>Penyimpangan adalah indikator pemeriksaan, bukan kesimpulan kecurangan.</div>`,
      fields: [{ name: 'status', label: 'Status verifikasi', type: 'select', options: [{ value: 'VERIFIED', label: 'Terverifikasi' }, { value: 'DISPUTED', label: 'Dipersoalkan — perlu pemeriksaan lanjut' }, { value: 'UNVERIFIED', label: 'Belum diverifikasi' }] },
        { name: 'reconciliation_cycles', label: 'Siklus rekonsiliasi (WIP / reject sebelum tahap selesai)', type: 'number', min: 0, step: '0.01', value: a.result.reconciliation_cycles, help: 'Siklus yang dipakai produk belum selesai; dikurangkan dari selisih' },
        { name: 'explanation', label: 'Penjelasan penyimpangan', type: 'textarea', value: a.result.deviation_explanation || '' },
        { name: 'note', label: 'Catatan supervisor', type: 'textarea' }],
      submit: 'Simpan verifikasi', onSubmit: (d) => api(`/results/${a.result.id}/verify`, { method: 'POST', body: d }) });
    if (r) { toast('Verifikasi tersimpan', 'success'); reload(); }
  });
  root.querySelectorAll('[data-hist]').forEach((b) => b.onclick = async () => {
    const rows = await api(`/results/${b.dataset.hist}/history`);
    modal({ title: 'Histori hasil produksi', wide: true, submit: 'Tutup', body: rows.length ? `<table class="tbl"><thead><tr><th>Versi</th><th>Waktu</th><th>Oleh</th><th>Alasan</th><th>Baik/Reject/Rework/WIP</th><th>Status</th></tr></thead><tbody>${rows.map((h) => { const s = JSON.parse(h.snapshot); return `<tr><td>v${h.version}</td><td>${fmtDT(h.changed_at)}</td><td>${esc(h.changed_by)}</td><td>${esc(h.reason || '')}</td><td>${s.good_qty}/${s.reject_completed_qty + s.reject_incomplete_qty}/${s.rework_qty}/${s.wip_qty}</td><td>${esc(s.verification_status)}</td></tr>`; }).join('')}</tbody></table>` : '<p>Belum ada perubahan.</p>' });
  });
}
