import { api, esc, fmtHM, fmtDur, fmtNum, signed, badge, STATUS, CATEGORY, qs, download, msToWibDate } from '../util.js';
import { filterBar } from './history.js';
import { jobsTable, bindJobActions } from '../components.js';

export async function render(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Laporan produksi & penyimpangan</h1><p>Perbandingan stamping aktual dengan hasil produksi berdasarkan standar produk. Penyimpangan memerlukan verifikasi supervisor — tidak ada kesimpulan kecurangan otomatis.</p></div>
      <div class="row"><button class="btn" id="xls">⬇ Ekspor Excel</button><button class="btn" id="pdf">⬇ Ekspor PDF</button></div></div>
    <div class="filters panel" style="padding:10px 12px" id="fb"></div>
    <div class="row" style="margin-bottom:12px"><label class="small">Kelompokkan per</label><select id="grp"><option value="work_order">Work order</option><option value="product">Produk & tahap</option><option value="machine">Mesin</option><option value="operator">Operator</option><option value="shift">Shift</option></select></div>
    <div id="out"></div>`;
  const getF = await filterBar(el.querySelector('#fb'), { withClass: true });
  const q = () => ({ ...getF(), group_by: el.querySelector('#grp').value });
  el.querySelector('[data-apply]').onclick = load;
  el.querySelector('#grp').onchange = load;
  el.querySelector('#xls').onclick = () => download(`/export/report.xlsx${qs(q())}`);
  el.querySelector('#pdf').onclick = () => download(`/export/report.pdf${qs(q())}`);
  async function load() {
    const out = el.querySelector('#out');
    out.innerHTML = '<div class="empty">Memuat…</div>';
    const f = q();
    const [prod, hourly] = await Promise.all([api(`/reports/production${qs(f)}`), api(`/reports/hourly${qs(f)}`)]);
    const g = prod.grouped;
    const tot = g.reduce((a, x) => { for (const k of Object.keys(x.cycles)) a.c[k] = (a.c[k] || 0) + x.cycles[k]; a.good += x.qty.good_total; a.rej += x.qty.reject_completed + x.qty.reject_incomplete; a.rw += x.qty.rework_sent + x.qty.rework_processed; return a; }, { c: {}, good: 0, rej: 0, rw: 0 });
    const maxH = Math.max(1, ...hourly.map((h) => h.total));
    out.innerHTML = `<div class="kpis">
        <div class="kpi"><div class="l">Stamping produksi normal</div><div class="v">${fmtNum(tot.c.normal || 0)}</div></div>
        <div class="kpi"><div class="l">Setup & uji coba</div><div class="v">${fmtNum((tot.c.setup || 0) + (tot.c.trial || 0))}</div></div>
        <div class="kpi"><div class="l">Stamping rework</div><div class="v">${fmtNum(tot.c.rework || 0)}</div></div>
        <div class="kpi"><div class="l">Total stamping</div><div class="v">${fmtNum(tot.c.total || 0)}</div></div>
        <div class="kpi ok"><div class="l">Produk baik</div><div class="v">${fmtNum(tot.good)}</div></div>
        <div class="kpi bad"><div class="l">Reject</div><div class="v">${fmtNum(tot.rej)}</div></div>
        <div class="kpi"><div class="l">Rework (pcs)</div><div class="v">${fmtNum(tot.rw)}</div></div>
        <div class="kpi ${prod.no_session.length ? 'warn' : ''}"><div class="l">Stamping tanpa sesi operator</div><div class="v">${fmtNum(prod.no_session.reduce((a, x) => a + x.n, 0))}</div></div></div>
      <section class="panel"><header><h3>Ringkasan per kelompok</h3></header><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kelompok</th><th class="num">Pekerjaan</th><th class="num">Normal</th><th class="num">Setup</th><th class="num">Uji coba</th><th class="num">Rework</th><th class="num">Tanpa pekerjaan</th><th class="num">Total</th>
        <th class="num">Baik</th><th class="num">Reject</th><th class="num">Dasar pcs</th><th class="num">Siklus standar</th><th class="num">Selisih</th><th class="num">%</th><th class="num">Stamping/baik</th><th>Status</th></tr></thead><tbody>
        ${g.map((x) => `<tr><td><b>${esc(x.key)}</b></td><td class="num">${x.jobs}</td><td class="num">${fmtNum(x.cycles.normal)}</td><td class="num">${fmtNum(x.cycles.setup)}</td><td class="num">${fmtNum(x.cycles.trial)}</td><td class="num">${fmtNum(x.cycles.rework)}</td><td class="num">${fmtNum(x.cycles.unassigned)}</td><td class="num">${fmtNum(x.cycles.total)}</td>
          <td class="num">${fmtNum(x.qty.good_total)}</td><td class="num">${fmtNum(x.qty.reject_completed + x.qty.reject_incomplete)}</td><td class="num">${fmtNum(x.qty.basis_pcs)}</td><td class="num">${fmtNum(x.standard_cycles, 2)}</td>
          <td class="num">${signed(x.diff, 2)}</td><td class="num">${x.diff_pct == null ? '—' : signed(x.diff_pct, 1) + '%'}</td><td class="num">${x.ratio_total_per_good ?? '—'}</td>
          <td>${badge(STATUS.prod[x.status] || 'muted', x.status_label)}${x.completeness.length ? `<div class="small muted">${esc(x.completeness.join('; '))}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="16" class="empty">Tidak ada data.</td></tr>'}
      </tbody></table></div><div class="body small muted">Dasar perhitungan: pcs yang menyelesaikan tahap proses = baik (lolos pertama) + reject setelah tahap selesai + dikirim ke rework. Produk rework yang menjadi baik hanya dihitung sekali. Produk dalam proses & reject sebelum tahap selesai harus direkonsiliasi (status "Sementara").</div></section>
      ${prod.no_session.length ? `<div class="notice warn" style="margin-top:12px">⚑ Stamping tanpa sesi operator: ${prod.no_session.map((n) => `${n.machine_id} (${n.n} siklus)`).join(', ')}. Tidak diatribusikan ke operator mana pun.</div>` : ''}
      <section class="panel" style="margin-top:14px"><header><h3>Rekap per jam</h3><span class="small muted">Durasi keberadaan dipecah tepat pada batas jam</span></header><div class="body">
        <div class="hbars" style="height:140px">${hourly.map((h) => `<div class="hb" title="${fmtHM(h.hour)}"><em>${h.total || ''}</em><div class="b" style="height:${(h.total / maxH) * 100}%"></div><small>${fmtHM(h.hour).slice(0, 2)}</small></div>`).join('')}</div>
        <div class="tbl-wrap" style="margin-top:10px;max-height:360px"><table class="tbl"><thead><tr><th>Jam (WIB)</th><th class="num">Hadir</th><th class="num">Tidak hadir</th><th class="num">Istirahat</th><th class="num">Izin</th><th class="num">Tdk tersedia</th><th class="num">Normal</th><th class="num">Setup</th><th class="num">Uji coba</th><th class="num">Rework</th><th class="num">Tanpa pekerjaan</th><th class="num">Tanpa sesi</th><th class="num">Total</th></tr></thead><tbody>
          ${hourly.map((h) => `<tr><td>${msToWibDate(h.hour)} ${fmtHM(h.hour)}–${fmtHM(h.hour + 3600e3)}</td><td class="num">${fmtDur(h.present)}</td><td class="num">${fmtDur(h.absent)}</td><td class="num">${fmtDur(h.break)}</td><td class="num">${fmtDur(h.leave)}</td><td class="num">${fmtDur(h.unknown)}</td>
            <td class="num">${h.normal}</td><td class="num">${h.setup}</td><td class="num">${h.trial}</td><td class="num">${h.rework}</td><td class="num">${h.unassigned}</td><td class="num">${h.no_session}</td><td class="num"><b>${h.total}</b></td></tr>`).join('') || '<tr><td colspan="13" class="empty">Tidak ada data.</td></tr>'}</tbody></table></div></div></section>
      <section class="panel" style="margin-top:14px"><header><h3>Rincian per pekerjaan</h3></header><div class="body" id="jobs">${jobsTable(prod.rows.slice(0, 300))}</div></section>`;
    bindJobActions(out.querySelector('#jobs'), prod.rows, load);
  }
  load();
}
