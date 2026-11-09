import { api, esc, fmtHM, fmtT, fmtDT, fmtDur, fmtNum, signed, badge, STATUS, DEVICE_NAME, CATEGORY, modal, toast, wibToMs, msToWibDate, msToWibTime } from '../util.js';
import { simPanel, timelineHtml, absenceTable, bindAbsenceActions, jobsTable, bindJobActions } from '../components.js';

export async function render(el, ctx) {
  let machineId = ctx.params[0];
  if (!machineId) {
    const ms = await api('/machines');
    el.innerHTML = `<div class="page-head"><div><h1>Detail mesin & sesi aktif</h1><p>Pilih mesin.</p></div></div><div class="mgrid">${ms.map((m) => `<a class="mcard s-idle" href="#/mesin/${m.id}"><div class="mno">${m.id}</div><div class="mname">${esc(m.name)} · ${esc(m.area)}</div></a>`).join('')}</div>`;
    return;
  }
  let timer = null;
  async function load() {
    const d = await api(`/machines/${machineId}`);
    const c = d.card, s = c.session;
    const tl = s ? await api(`/sessions/${s.id}/timeline`) : null;
    if (!ctx.alive()) return;
    const [ptone] = STATUS.presence[c.presence.code] || ['muted'];
    el.innerHTML = `<div class="page-head"><div><a href="#/dashboard" class="small">← Dashboard</a><h1>${esc(c.id)} — ${esc(c.name)}</h1><p>${esc(c.area || '')} · <a href="/terminal.html?m=${c.id}" target="_blank" rel="noopener">Buka terminal operator ↗</a></p></div>
        <div class="row"><label class="small" for="msel">Mesin lain</label><select id="msel"></select></div></div>
      <div class="grid g3">
        <section class="panel"><header><h3>Sesi operator</h3>${s ? badge(STATUS.session[s.status], s.status_label) : badge('muted', 'Tidak ada sesi')}</header><div class="body">
          ${s ? `<div class="row" style="gap:12px;align-items:flex-start"><div style="width:56px;height:56px;border-radius:10px;background:#e7effc;display:grid;place-items:center;font-size:26px">${s.photo_url ? `<img src="${esc(s.photo_url)}" alt="" style="width:56px;height:56px;border-radius:10px;object-fit:cover">` : '👤'}</div>
              <div><div style="font-size:17px;font-weight:700">${esc(s.operator_name)}</div><div class="muted">${esc(s.operator_id)} · ${esc(s.employee_no)}</div></div></div>
            <dl class="kv" style="margin-top:10px"><dt>Shift</dt><dd>${esc(s.shift_name)} (selesai ${fmtHM(s.shift_end)})</dd><dt>Login</dt><dd>${fmtDT(s.login_at)}${s.late_min ? ` ${badge('warn', `terlambat ${s.late_min} mnt`)}` : ''}</dd>
              <dt>Durasi sesi</dt><dd>${fmtDur(s.duration_ms)}</dd><dt>Izin operasional</dt><dd>${badge(s.permission_status === 'GRANTED' ? 'ok' : 'warn', s.permission_label)}</dd>
              <dt>Pesan</dt><dd>${esc(s.status_message || '')}</dd><dt>Pekerjaan</dt><dd>${s.job ? `${esc(s.job.work_order_id)} · ${esc(s.job.product_name)} · ${esc(CATEGORY[s.job.category])}` : '<i>Belum dipilih</i>'}</dd></dl>
            ${s.not_logged_out ? '<div class="notice warn" style="margin-top:8px">⚑ Belum logout — shift telah berakhir. Mesin tidak dihentikan otomatis.</div>' : ''}
            <div class="row" style="margin-top:12px">
              <button class="btn btn-sm" id="aJob">Ganti pekerjaan</button><button class="btn btn-sm" id="aLeave">Beri izin</button>
              <button class="btn btn-sm" id="aHand">Pergantian shift (lanjut)</button><button class="btn btn-sm btn-warn" id="aLogout">Logout / ganti operator</button>
              <button class="btn btn-sm btn-danger" id="aForce">Tutup paksa</button></div>`
          : `<p class="muted">Tidak ada operator aktif. Operator login dengan tap kartu RFID di terminal mesin.</p>`}
          ${c.terminal.message ? `<div class="notice ${c.terminal.level === 'error' ? 'bad' : c.terminal.level === 'warning' ? 'warn' : ''}" style="margin-top:10px"><b>Terminal (${fmtT(c.terminal.at)}):</b> ${esc(c.terminal.message)}</div>` : ''}
        </div></section>
        <section class="panel"><header><h3>Status mesin & keberadaan</h3></header><div class="body">
          <dl class="kv"><dt>Status fisik</dt><dd>${badge(STATUS.physical[c.physical_state] || 'muted', c.physical_label)} <span class="small muted">dari umpan balik PLC</span></dd>
            <dt>Keberadaan</dt><dd>${badge(ptone, c.presence.label)} ${c.presence.ongoing_ms ? fmtDur(c.presence.ongoing_ms) : ''}</dd>
            ${s ? `<dt>Tidak hadir (sesi)</dt><dd>${fmtDur(s.absent_total_ms)} · ${s.absence_count} kejadian</dd><dt>Pemantauan tdk tersedia</dt><dd>${fmtDur(s.unknown_ms)}</dd>` : ''}</dl>
          <h4 style="margin:12px 0 6px">Perangkat</h4>
          <table class="tbl"><tbody>${d.devices.map((x) => `<tr><td>${esc(DEVICE_NAME[x.type])}</td><td>${badge(STATUS.device[x.status] || 'muted', { ok: 'Normal', offline: 'Terputus', unknown: 'Tidak diketahui', fault: 'Gangguan', degraded: 'Tidak andal', obstructed: 'Tertutup' }[x.status] || x.status)}</td><td class="small muted">${esc(x.status_detail || '')}${x.type === 'edge' && x.clock_offset_ms != null ? ` · selisih jam ${x.clock_offset_ms} ms` : ''}</td></tr>`).join('')}</tbody></table>
        </div></section>
        <section class="panel"><header><h3>Stamping & produksi</h3>${s ? badge(STATUS.prod[s.production.status] || 'muted', s.production.status_label) : ''}</header><div class="body">
          ${s ? `<div class="grid g2" style="gap:8px">${['normal', 'setup', 'trial', 'rework', 'unassigned'].map((k) => `<div class="kpi" style="padding:8px 10px"><div class="l">${CATEGORY[k]}</div><div class="v" style="font-size:20px">${fmtNum(s.stamping[k])}</div></div>`).join('')}
              <div class="kpi" style="padding:8px 10px"><div class="l">Total stamping</div><div class="v" style="font-size:20px">${fmtNum(s.stamping.total)}</div></div></div>
            <dl class="kv" style="margin-top:10px"><dt>Produk baik</dt><dd>${fmtNum(s.production.qty.good_total)}</dd><dt>Reject</dt><dd>${fmtNum(s.production.qty.reject_completed + s.production.qty.reject_incomplete)}</dd>
              <dt>Siklus standar</dt><dd>${fmtNum(s.production.standard_cycles, 2)}</dd><dt>Selisih</dt><dd>${signed(s.production.diff, 2)} ${s.production.diff_pct != null ? `(${signed(s.production.diff_pct, 1)}%)` : ''}</dd>
              <dt>Rasio stamping/baik</dt><dd>${s.production.ratio_total_per_good ?? '—'}</dd></dl>
            ${s.production.completeness.length ? `<div class="notice warn small" style="margin-top:6px">${esc(s.production.completeness.join(' · '))}</div>` : ''}` : '<p class="muted">Tidak ada sesi aktif.</p>'}
          <h4 style="margin:12px 0 0">Stamping per jam (12 jam terakhir)</h4>
          <div class="hbars">${(() => { const mx = Math.max(1, ...d.hourly.map((h) => h.total)); return d.hourly.map((h) => `<div class="hb" title="${fmtHM(h.hour)}: ${h.total} siklus (normal ${h.normal}, setup ${h.setup}, uji ${h.trial}, rework ${h.rework}, tanpa sesi ${h.no_session})"><em>${h.total || ''}</em><div class="b" style="height:${(h.total / mx) * 100}%"></div><small>${fmtHM(h.hour).slice(0, 2)}</small></div>`).join('') || '<div class="muted small">Belum ada data</div>'; })()}</div>
        </div></section>
      </div>
      ${tl ? `<section class="panel" style="margin-top:14px"><header><h3>Timeline sesi aktif</h3></header><div class="body">${timelineHtml(tl)}</div></section>` : ''}
      ${s ? `<section class="panel" style="margin-top:14px"><header><h3>Pekerjaan & hasil produksi sesi ini</h3><span class="small muted">Pergantian produk/tahap/WO dicatat terpisah</span></header><div class="body" id="jobsBox">${jobsTable(d.jobs)}</div></section>
        <section class="panel" style="margin-top:14px"><header><h3>Kejadian keberadaan sesi ini</h3><span class="small muted">Indikator pemeriksaan — bukan bukti pelanggaran</span></header><div class="body" id="absBox">${absenceTable(tl.events.map((e) => ({ ...e, current_duration_ms: (e.end_at || Date.now()) - e.start_at })))}</div></section>` : ''}
      <div id="simBox" style="margin-top:14px"></div>
      <div class="grid g2" style="margin-top:14px">
        <section class="panel"><header><h3>Riwayat sesi (3 hari)</h3></header><div class="body tbl-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th>Operator</th><th>Shift</th><th>Login</th><th>Logout</th><th class="num">Stamping</th><th class="num">Tdk hadir</th><th>Status</th></tr></thead><tbody>
          ${d.sessions.map((x) => `<tr><td>${esc(x.operator_name)}</td><td>${esc(x.shift_name || '')}</td><td>${fmtDT(x.login_at)}</td><td>${x.logout_at ? fmtT(x.logout_at) : '—'}</td><td class="num">${x.stamping.total}</td><td class="num">${fmtDur(x.absent_ms)}</td><td>${badge(STATUS.session[x.status] || 'muted', x.status_label)}${x.not_logged_out ? ' ' + badge('warn', 'Belum logout') : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada</td></tr>'}</tbody></table></div></section>
        <section class="panel"><header><h3>Tap RFID & perintah pengendali</h3></header><div class="body tbl-wrap" style="max-height:340px"><table class="tbl"><thead><tr><th>Waktu</th><th>Kejadian</th><th>Keterangan</th></tr></thead><tbody>
          ${[...d.taps.map((t) => ({ t: t.device_time, k: `Tap ${t.card_uid}`, o: t.outcome, m: t.message, rcv: t.received_at })), ...d.commands.map((x) => ({ t: x.created_at, k: `Perintah ${x.type}`, o: x.status, m: x.error || '' }))]
            .sort((a, b) => b.t - a.t).slice(0, 40).map((x) => `<tr><td class="small">${fmtT(x.t)}${x.rcv && Math.abs(x.rcv - x.t) > 1000 ? `<div class="muted">diterima ${fmtT(x.rcv)}</div>` : ''}</td><td><b>${esc(x.k)}</b><div>${badge(/REJECT|FAIL|TIMEOUT/.test(x.o) ? 'bad' : /IGNORED/.test(x.o) ? 'muted' : 'ok', x.o)}</div></td><td class="small">${esc(x.m || '')}</td></tr>`).join('')}</tbody></table></div></section>
      </div>
      <section class="panel" style="margin-top:14px"><header><h3>Anomali counter & sensor</h3></header><div class="body tbl-wrap" style="max-height:260px">${d.anomalies.length ? `<table class="tbl"><thead><tr><th>Waktu</th><th>Jenis</th><th class="num">Jumlah</th><th>Detail</th></tr></thead><tbody>${d.anomalies.map((a) => `<tr><td>${fmtDT(a.at)}</td><td>${esc({ RESET: 'Reset counter', GAP: 'Kehilangan data', STUCK: 'Sinyal tertahan', BOUNCE: 'Sinyal berulang difilter', SENSOR_FAULT: 'Gangguan sensor', SENSOR_RESTORED: 'Sensor pulih', LATE_FILL: 'Data terlambat' }[a.type] || a.type)}</td><td class="num">${a.count ?? ''}</td><td class="small mono">${esc(a.details || '')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Tidak ada anomali.</div>'}</div></section>`;

    const ms = await api('/machines');
    if (!ctx.alive()) return;
    const sel = el.querySelector('#msel'); sel.innerHTML = ms.map((m) => `<option value="${m.id}" ${m.id === machineId ? 'selected' : ''}>${m.id} — ${esc(m.name)}</option>`).join('');
    sel.onchange = () => ctx.go(`mesin/${sel.value}`);
    if (s) {
      bindJobActions(el.querySelector('#jobsBox'), d.jobs, load);
      bindAbsenceActions(el.querySelector('#absBox'), load);
      const act = (id, fn) => { const b = el.querySelector(id); if (b) b.onclick = fn; };
      act('#aJob', async () => {
        const r = await modal({ title: 'Ganti pekerjaan (oleh supervisor)', fields: [
          { name: 'work_order_id', label: 'Work order', type: 'select', options: d.work_orders.map((w) => ({ value: w.id, label: `${w.id} — ${w.product_name}` })), value: s.job?.work_order_id },
          { name: 'category', label: 'Kategori stamping', type: 'select', options: Object.entries(CATEGORY).filter(([k]) => k !== 'unassigned').map(([value, label]) => ({ value, label })), value: s.job?.category || 'normal' }],
        onSubmit: (b) => api(`/sessions/${s.id}/job`, { method: 'POST', body: b }) });
        if (r) { toast('Pekerjaan diganti — pencatatan dipisahkan', 'success'); load(); }
      });
      act('#aLeave', async () => {
        const now = Date.now();
        const r = await modal({ title: `Izin meninggalkan area — ${s.operator_name}`, fields: [
          { name: 'date', label: 'Tanggal', type: 'date', value: msToWibDate(now), half: true }, { name: 'from', label: 'Dari (WIB)', type: 'time', value: msToWibTime(now), half: true },
          { name: 'minutes', label: 'Durasi (menit)', type: 'number', min: 1, value: 15, half: true }, { name: 'reason', label: 'Alasan', type: 'textarea', required: true }],
        onSubmit: (b) => { const start = wibToMs(b.date, b.from); return api('/leave', { method: 'POST', body: { operator_id: s.operator_id, session_id: s.id, start_at: start, end_at: start + Number(b.minutes) * 60000, reason: b.reason } }); } });
        if (r) { toast('Izin dicatat', 'success'); load(); }
      });
      act('#aHand', async () => {
        const r = await modal({ title: 'Pergantian shift — operator melanjutkan', body: '<p class="small">Sesi saat ini ditutup dan sesi baru dibuat untuk shift berikutnya (memerlukan penugasan atau lembur yang disetujui). Izin operasional dilanjutkan tanpa menghentikan mesin.</p>',
          fields: [{ name: 'reason', label: 'Alasan', type: 'textarea', required: true }], onSubmit: (b) => api(`/sessions/${s.id}/handover`, { method: 'POST', body: b }) });
        if (r) { toast('Pergantian shift tercatat', 'success'); load(); }
      });
      act('#aLogout', async () => {
        const r = await modal({ title: 'Logout / pergantian operator', body: '<p class="small">Permintaan penghentian dikirim ke pengendali. Sesi ditutup setelah kondisi aman dikonfirmasi. Operator pengganti kemudian tap kartunya.</p>',
          fields: [{ name: 'reason', label: 'Alasan', type: 'textarea', required: true }], submit: 'Kirim permintaan', onSubmit: (b) => api(`/sessions/${s.id}/logout`, { method: 'POST', body: b }) });
        if (r) { toast('Permintaan logout dikirim', 'info'); setTimeout(load, 1200); }
      });
      act('#aForce', async () => {
        const r = await modal({ title: 'Tutup sesi secara paksa', danger: true, submit: 'Tutup sesi',
          body: '<div class="notice bad">Gunakan hanya jika pengendali tidak dapat mengonfirmasi. Periksa langsung bahwa mesin dalam kondisi aman sebelum melanjutkan.</div>',
          fields: [{ name: 'reason', label: 'Alasan', type: 'textarea', required: true }, { name: 'safety_confirmed', label: 'Konfirmasi keselamatan', type: 'checkbox', checkLabel: 'Saya telah memeriksa langsung: mesin berhenti & aman', required: true }],
          onSubmit: (b) => api(`/sessions/${s.id}/force-close`, { method: 'POST', body: b }) });
        if (r) { toast('Sesi ditutup supervisor', 'warning'); load(); }
      });
    }
    if (d.sim) simPanel(el.querySelector('#simBox'), machineId, () => setTimeout(load, 300));
  }
  await load();
  let pending = false;
  ctx.onLive((ids) => { if (!ids.includes(machineId) || pending || document.querySelector('.modal-backdrop')) return; pending = true; setTimeout(async () => { pending = false; if (!document.querySelector('.modal-backdrop')) await load(); }, 2500); });
  timer = setInterval(() => { if (!document.querySelector('.modal-backdrop')) load(); }, 15000);
  return () => clearInterval(timer);
}
