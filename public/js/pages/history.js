import { api, esc, fmtDT, fmtT, fmtDur, fmtNum, badge, STATUS, qs, wibToMs, msToWibDate, modal } from '../util.js';
import { timelineHtml, absenceTable, bindAbsenceActions } from '../components.js';

export async function filterBar(el, { withClass = true, withWo = true } = {}) {
  const [machines, ops, shifts, products, wos] = await Promise.all([api('/machines'), api('/operators'), api('/shifts'), api('/products'), withWo ? api('/work-orders') : []]);
  const today = msToWibDate(Date.now());
  el.innerHTML = `<div class="f"><label>Dari tanggal</label><input type="date" name="d1" value="${today}"></div><div class="f"><label>Jam</label><input type="time" name="t1" value="00:00"></div>
    <div class="f"><label>Sampai tanggal</label><input type="date" name="d2" value="${today}"></div><div class="f"><label>Jam</label><input type="time" name="t2" value="23:59"></div>
    <div class="f"><label>Mesin</label><select name="machine_id"><option value="">Semua</option>${machines.map((m) => `<option>${m.id}</option>`).join('')}</select></div>
    <div class="f"><label>Operator</label><select name="operator_id"><option value="">Semua</option>${ops.map((o) => `<option value="${o.id}">${o.id} — ${esc(o.name)}</option>`).join('')}</select></div>
    <div class="f"><label>Shift</label><select name="shift_id"><option value="">Semua</option>${shifts.shifts.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    ${withWo ? `<div class="f"><label>Work order</label><select name="work_order_id"><option value="">Semua</option>${wos.map((w) => `<option>${w.id}</option>`).join('')}</select></div>
    <div class="f"><label>Produk</label><select name="product_id"><option value="">Semua</option>${products.map((p) => `<option value="${p.id}">${p.id}</option>`).join('')}</select></div>` : ''}
    ${withClass ? `<div class="f"><label>Klasifikasi kejadian</label><select name="classification"><option value="">Semua</option><option value="ABSENT">Tidak hadir</option><option value="BREAK">Istirahat</option><option value="LEAVE">Izin</option><option value="UNKNOWN">Pemantauan tdk tersedia</option><option value="PRESENT">Dikoreksi: hadir</option></select></div>` : ''}
    <div class="f"><label>&nbsp;</label><button class="btn btn-primary" data-apply>Terapkan</button></div>`;
  return () => {
    const v = (n) => el.querySelector(`[name=${n}]`)?.value || '';
    return { from: wibToMs(v('d1'), v('t1')), to: wibToMs(v('d2'), v('t2')) + 60000, machine_id: v('machine_id'), operator_id: v('operator_id'), shift_id: v('shift_id'), work_order_id: v('work_order_id'), product_id: v('product_id'), classification: v('classification') };
  };
}

export async function render(el, ctx) {
  el.innerHTML = `<div class="page-head"><div><h1>Riwayat sesi & ketidakhadiran</h1><p>Data ketidakhadiran adalah indikator untuk pemeriksaan, bukan bukti otomatis pelanggaran operator.</p></div></div>
    <div class="filters panel" style="padding:10px 12px" id="fb"></div>
    <div class="tabs" role="tablist"><button role="tab" aria-selected="true" data-tab="s">Sesi</button><button role="tab" aria-selected="false" data-tab="e">Kejadian keberadaan</button></div>
    <div id="out"></div>`;
  const getF = await filterBar(el.querySelector('#fb'), { withWo: true });
  let tab = 's';
  el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; el.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b)); load(); });
  el.querySelector('[data-apply]').onclick = load;
  async function load() {
    const out = el.querySelector('#out');
    const f = getF();
    out.innerHTML = '<div class="empty">Memuat…</div>';
    if (tab === 'e') {
      const evs = await api(`/reports/absences${qs(f)}`);
      out.innerHTML = `<section class="panel"><div class="body">${absenceTable(evs)}</div></section>`;
      bindAbsenceActions(out, load);
      return;
    }
    const rows = await api(`/reports/sessions${qs(f)}`);
    out.innerHTML = `<section class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mesin</th><th>Operator</th><th>Shift</th><th>Login</th><th>Logout</th><th class="num">Durasi</th><th class="num">Hadir</th>
      <th class="num">Tidak hadir*</th><th class="num">Istirahat</th><th class="num">Izin</th><th class="num">Tdk tersedia</th><th class="num">Kejadian</th><th class="num">Stamping</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td><a href="#/mesin/${s.machine_id}">${s.machine_id}</a></td><td>${esc(s.operator_name)} <span class="muted small">${s.operator_id}</span>${s.simulated ? ' <span class="badge b-sim">Sim</span>' : ''}</td><td>${esc(s.shift_name || '')}</td>
        <td>${fmtDT(s.login_at)}${s.late_min ? `<div>${badge('warn', `terlambat ${s.late_min}m`)}</div>` : ''}</td><td>${s.logout_at ? fmtDT(s.logout_at) : badge('warn', 'Belum selesai')}${s.not_logged_out ? `<div>${badge('bad', 'Belum logout')}</div>` : ''}</td>
        <td class="num">${fmtDur(s.duration_ms)}</td><td class="num">${fmtDur(s.present_ms)}</td><td class="num"><b>${fmtDur(s.absent_ms)}</b></td><td class="num">${fmtDur(s.break_ms)}</td><td class="num">${fmtDur(s.leave_ms)}</td><td class="num">${fmtDur(s.unknown_ms)}</td>
        <td class="num">${s.absence_count}</td><td class="num">${fmtNum(s.stamping.total)}${s.stamp_while_absent ? `<div>${badge('warn', `${s.stamp_while_absent} saat tdk terdeteksi`)}</div>` : ''}</td>
        <td>${badge(STATUS.session[s.status] || 'muted', s.status_label)}<div class="small muted">${esc(s.end_reason || '')}</div></td><td><button class="btn btn-sm" data-tl="${s.id}">Timeline</button></td></tr>`).join('') || '<tr><td colspan="15" class="empty">Tidak ada sesi pada filter ini.</td></tr>'}
      </tbody></table></div><div class="body small muted">* Tidak hadir di luar istirahat terjadwal dan izin. Durasi hadir ≠ waktu produksi mesin. Kejadian yang melewati batas istirahat dipecah tanpa menggandakan kejadian asli.</div></section>`;
    out.querySelectorAll('[data-tl]').forEach((b) => b.onclick = async () => {
      const tl = await api(`/sessions/${b.dataset.tl}/timeline`);
      const s = rows.find((x) => x.id === b.dataset.tl);
      modal({ title: `Timeline ${s.machine_id} — ${s.operator_name}`, wide: true, submit: 'Tutup', body: `${timelineHtml(tl)}<h4 style="margin:14px 0 6px">Kejadian</h4>${absenceTable(tl.events.map((e) => ({ ...e, current_duration_ms: (e.end_at || Date.now()) - e.start_at })), { canCorrect: false })}
        <h4 style="margin:14px 0 6px">Rincian kejadian ketidakhadiran (dipecah per klasifikasi)</h4><table class="tbl"><thead><tr><th>Mulai</th><th>Selesai</th><th class="num">Total</th><th class="num">Tidak hadir</th><th class="num">Istirahat</th><th class="num">Izin</th></tr></thead><tbody>
        ${s.absence_events.map((e) => `<tr><td>${fmtT(e.start_at)}</td><td>${e.end_at ? fmtT(e.end_at) : 'berlangsung'}</td><td class="num">${fmtDur(e.duration_ms)}</td><td class="num">${fmtDur(e.parts.absent)}</td><td class="num">${fmtDur(e.parts.break)}</td><td class="num">${fmtDur(e.parts.leave)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Tidak ada</td></tr>'}</tbody></table>` });
    });
  }
  load();
}
