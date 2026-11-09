'use strict';
/** Ekspor laporan ke Excel (.xlsx) dan PDF. */
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const T = require('../lib/time');

const min = (ms) => (ms == null ? '' : Math.round(ms / 600) / 100); // menit, 2 desimal
const CAT = { normal: 'Produksi normal', setup: 'Setup', trial: 'Uji coba', rework: 'Rework', unassigned: 'Tanpa pekerjaan' };

module.exports = function exportRoutes(core, { need, scopeOf }) {
  const express = require('express');
  const r = express.Router();

  function collect(req) {
    const f = { ...req.query, machines: scopeOf(req) };
    return { f, sessions: core.reports.sessionReport(f), hourly: core.reports.hourly(f), prod: core.reports.production(f) };
  }
  function filterText(f) {
    const parts = [];
    if (f.from) parts.push(`Dari ${T.dateTimeStr(Number(f.from))}`);
    if (f.to) parts.push(`Sampai ${T.dateTimeStr(Number(f.to))}`);
    for (const [k, l] of [['machine_id', 'Mesin'], ['operator_id', 'Operator'], ['shift_id', 'Shift'], ['work_order_id', 'WO'], ['product_id', 'Produk'], ['classification', 'Klasifikasi']]) if (f[k]) parts.push(`${l} ${f[k]}`);
    return parts.join(' · ') || 'Semua data';
  }

  r.get('/export/report.xlsx', need, async (req, res) => {
    try {
      const { f, sessions, hourly, prod } = collect(req);
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Sistem Monitoring Stamping';
      wb.created = new Date();
      const info = wb.addWorksheet('Info');
      info.addRows([['Laporan Monitoring Operasional & Produksi Stamping'], ['Dibuat', T.dateTimeStr(Date.now()) + ' WIB'], ['Filter', filterText(f)], ['Mode', core.simulation ? 'SIMULASI — data bukan dari perangkat fisik' : 'Produksi'],
        [], ['Catatan', 'Data ketidakhadiran dan penyimpangan produksi adalah indikator untuk pemeriksaan, bukan bukti otomatis pelanggaran. Penilaian disiplin wajib melalui verifikasi supervisor.']]);
      info.getColumn(1).width = 16; info.getColumn(2).width = 110; info.getRow(1).font = { bold: true, size: 14 };

      const ws = wb.addWorksheet('Sesi');
      ws.columns = [
        ['Mesin', 'machine_id', 8], ['Operator', 'operator_name', 22], ['ID', 'operator_id', 8], ['Shift', 'shift_name', 18], ['Tanggal shift', 'shift_date', 12],
        ['Login', 'login', 19], ['Logout', 'logout', 19], ['Status', 'status_label', 18], ['Belum logout', 'nlo', 10], ['Durasi sesi (mnt)', 'dur', 12], ['Hadir (mnt)', 'present', 11],
        ['Tidak hadir di luar istirahat/izin (mnt)', 'absent', 16], ['Istirahat (mnt)', 'break', 11], ['Izin (mnt)', 'leave', 10], ['Pemantauan tdk tersedia (mnt)', 'unknown', 14],
        ['Jml kejadian', 'absence_count', 10], ['Stamping normal', 'normal', 10], ['Setup', 'setup', 8], ['Uji coba', 'trial', 8], ['Rework', 'rework', 8], ['Tanpa pekerjaan', 'unassigned', 10], ['Total stamping', 'total', 10],
        ['Produk baik', 'good', 10], ['Reject', 'reject', 8], ['Rework (pcs)', 'rework_pcs', 10], ['Siklus standar', 'std', 10], ['Selisih', 'diff', 9], ['Selisih %', 'pct', 9],
        ['Status produksi', 'pstatus', 26], ['Kelengkapan data', 'complete', 40], ['Stamping saat tdk terdeteksi', 'swa', 12], ['Simulasi', 'sim', 8],
      ].map(([header, key, width]) => ({ header, key, width }));
      for (const s of sessions) {
        const p = s.production;
        ws.addRow({ ...s, login: T.dateTimeStr(s.login_at), logout: s.logout_at ? T.dateTimeStr(s.logout_at) : 'Belum selesai', nlo: s.not_logged_out ? 'Ya' : '',
          dur: min(s.duration_ms), present: min(s.present_ms), absent: min(s.absent_ms), break: min(s.break_ms), leave: min(s.leave_ms), unknown: min(s.unknown_ms),
          ...s.stamping, good: p.qty.good_total, reject: p.qty.reject_completed + p.qty.reject_incomplete, rework_pcs: p.qty.rework_sent, std: p.standard_cycles ?? '', diff: p.diff ?? '', pct: p.diff_pct ?? '',
          pstatus: p.status_label, complete: p.completeness.join('; '), swa: s.stamp_while_absent || '', sim: s.simulated ? 'Ya' : '' });
      }
      ws.getRow(1).font = { bold: true }; ws.getRow(1).alignment = { wrapText: true, vertical: 'top' }; ws.views = [{ state: 'frozen', ySplit: 1 }];

      const we = wb.addWorksheet('Kejadian keberadaan');
      we.columns = [['Mesin', 'm', 8], ['Operator', 'op', 22], ['Mulai', 'start', 19], ['Selesai', 'end', 19], ['Durasi (mnt)', 'dur', 11], ['Tidak hadir (mnt)', 'absent', 12], ['Istirahat (mnt)', 'break', 12], ['Izin (mnt)', 'leave', 10],
        ['Klasifikasi asli', 'cls', 14], ['Koreksi', 'corr', 12], ['Verifikasi', 'ver', 12]].map(([header, key, width]) => ({ header, key, width }));
      for (const s of sessions) for (const e of s.absence_events) {
        we.addRow({ m: s.machine_id, op: s.operator_name, start: T.dateTimeStr(e.start_at), end: e.end_at ? T.dateTimeStr(e.end_at) : 'Berlangsung', dur: min(e.duration_ms),
          absent: min(e.parts.absent), break: min(e.parts.break), leave: min(e.parts.leave), cls: e.classification, corr: e.corrected_classification || '', ver: e.verification_status });
      }
      we.getRow(1).font = { bold: true };

      const wh = wb.addWorksheet('Rekap per jam');
      wh.columns = [['Jam', 'h', 18], ['Hadir (mnt)', 'present', 11], ['Tidak hadir (mnt)', 'absent', 12], ['Istirahat (mnt)', 'break', 12], ['Izin (mnt)', 'leave', 10], ['Tdk tersedia (mnt)', 'unknown', 12],
        ['Normal', 'normal', 9], ['Setup', 'setup', 8], ['Uji coba', 'trial', 8], ['Rework', 'rework', 8], ['Tanpa pekerjaan', 'unassigned', 10], ['Tanpa sesi', 'no_session', 10], ['Total', 'total', 8]].map(([header, key, width]) => ({ header, key, width }));
      for (const h of hourly) wh.addRow({ ...h, h: `${T.dateStr(h.hour)} ${T.timeStr(h.hour, false)}–${T.timeStr(h.hour + T.HOUR, false)}`, present: min(h.present), absent: min(h.absent), break: min(h.break), leave: min(h.leave), unknown: min(h.unknown) });
      wh.getRow(1).font = { bold: true };

      const wp = wb.addWorksheet('Produksi');
      wp.columns = [['Mesin', 'm', 8], ['Operator', 'op', 22], ['WO', 'wo', 14], ['Produk', 'prod', 28], ['Tahap', 'stage', 16], ['Kategori', 'cat', 14], ['Mulai', 'start', 19], ['Selesai', 'end', 19],
        ['Siklus', 'cyc', 8], ['Standar (siklus/pcs)', 'stdtxt', 14], ['Dasar pcs', 'basis', 9], ['Baik', 'good', 8], ['Reject', 'rej', 8], ['Rework', 'rw', 8], ['WIP', 'wip', 6],
        ['Siklus standar', 'std', 10], ['Selisih', 'diff', 9], ['Selisih %', 'pct', 9], ['Status', 'status', 26], ['Verifikasi', 'ver', 12], ['Sumber', 'src', 10]].map(([header, key, width]) => ({ header, key, width }));
      for (const x of prod.rows) {
        const j = x.job, rs = x.result || {};
        wp.addRow({ m: j.machine_id, op: j.operator_name, wo: j.work_order_id, prod: j.product_name, stage: j.stage_name, cat: CAT[j.category], start: T.dateTimeStr(j.started_at), end: j.ended_at ? T.dateTimeStr(j.ended_at) : 'Berjalan',
          cyc: x.cycles.total, stdtxt: x.standard ? `${x.standard.cycles_per_set} / ${x.standard.pcs_per_set}` : 'Belum tersedia', basis: x.qty.basis_pcs, good: x.qty.good_total,
          rej: (rs.reject_completed_qty || 0) + (rs.reject_incomplete_qty || 0), rw: rs.rework_qty || 0, wip: rs.wip_qty || 0, std: x.standard_cycles ?? '', diff: x.diff ?? '', pct: x.diff_pct ?? '',
          status: x.status_label, ver: rs.verification_status || 'Belum ada hasil', src: rs.source || '' });
      }
      wp.getRow(1).font = { bold: true };
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="laporan-stamping-${T.dateStr(Date.now())}.xlsx"`);
      await wb.xlsx.write(res);
      res.end();
      core.audit(req.user ? { id: req.user.id, name: req.user.name } : null, 'EXPORT_XLSX', 'report', null, null, req.query);
    } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });

  r.get('/export/report.pdf', need, (req, res) => {
    try {
      const { f, sessions, prod } = collect(req);
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="laporan-stamping-${T.dateStr(Date.now())}.pdf"`);
      doc.pipe(res);
      doc.fontSize(15).text('Laporan Monitoring Operasional & Produksi Stamping', { continued: false });
      doc.fontSize(9).fillColor('#444').text(`${core.settings.get('plant_name')} · Dibuat ${T.dateTimeStr(Date.now())} WIB · ${filterText(f)}`);
      if (core.simulation) doc.fillColor('#b45309').text('MODE SIMULASI — data dihasilkan perangkat virtual, bukan perangkat fisik.');
      doc.fillColor('#444').text('Data ketidakhadiran & penyimpangan produksi adalah indikator pemeriksaan, bukan bukti otomatis pelanggaran. Wajib diverifikasi supervisor.').moveDown(0.6);

      const table = (title, cols, rows) => {
        doc.fillColor('#000').fontSize(11).text(title).moveDown(0.2);
        const x0 = 30; const widths = cols.map((c) => c[1]);
        const drawRow = (vals, bold) => {
          if (doc.y > 540) doc.addPage();
          const y = doc.y; let x = x0;
          doc.fontSize(7).font(bold ? 'Helvetica-Bold' : 'Helvetica');
          const h = Math.max(...vals.map((v, i) => doc.heightOfString(String(v ?? ''), { width: widths[i] - 4 }))) + 4;
          vals.forEach((v, i) => { doc.text(String(v ?? ''), x + 2, y + 2, { width: widths[i] - 4 }); x += widths[i]; });
          doc.moveTo(x0, y + h).lineTo(x, y + h).strokeColor('#ccc').stroke();
          doc.y = y + h; doc.x = x0;
        };
        drawRow(cols.map((c) => c[0]), true);
        for (const r0 of rows) drawRow(r0, false);
        doc.moveDown(0.8);
      };
      table('Ringkasan sesi', [['Mesin', 34], ['Operator', 90], ['Shift', 70], ['Login', 70], ['Logout', 70], ['Durasi', 45], ['Hadir', 45], ['Tdk hadir', 45], ['Istirahat', 42], ['Izin', 38], ['Tdk tersedia', 45],
        ['Kej.', 24], ['Stamping (N/S/U/R)', 72], ['Baik/Reject', 50], ['Selisih', 50], ['Status', 85]],
      sessions.map((s) => [s.machine_id, s.operator_name, s.shift_name, T.dateTimeStr(s.login_at).slice(5), s.logout_at ? T.dateTimeStr(s.logout_at).slice(5) : (s.not_logged_out ? 'Belum logout' : 'Berjalan'),
        T.fmtDuration(s.duration_ms), T.fmtDuration(s.present_ms), T.fmtDuration(s.absent_ms), T.fmtDuration(s.break_ms), T.fmtDuration(s.leave_ms), T.fmtDuration(s.unknown_ms), s.absence_count,
        `${s.stamping.normal}/${s.stamping.setup}/${s.stamping.trial}/${s.stamping.rework} (Σ${s.stamping.total})`, `${s.production.qty.good_total}/${s.production.qty.reject_completed + s.production.qty.reject_incomplete}`,
        s.production.diff == null ? '-' : `${s.production.diff > 0 ? '+' : ''}${s.production.diff} (${s.production.diff_pct ?? '-'}%)`, s.production.status_label]));
      table('Produksi per kelompok', [['Kelompok', 150], ['Pekerjaan', 45], ['Normal', 45], ['Setup+Uji', 50], ['Rework', 45], ['Total', 45], ['Baik', 45], ['Reject', 45], ['Dasar pcs', 50], ['Siklus std', 55], ['Selisih', 55], ['%', 40], ['Status', 110]],
        prod.grouped.map((g) => [g.key, g.jobs, g.cycles.normal, g.cycles.setup + g.cycles.trial, g.cycles.rework, g.cycles.total, g.qty.good_total, g.qty.reject_completed + g.qty.reject_incomplete, g.qty.basis_pcs, g.standard_cycles ?? '-', g.diff ?? '-', g.diff_pct ?? '-', g.status_label]));
      if (prod.no_session.length) table('Stamping tanpa sesi operator', [['Mesin', 60], ['Jumlah', 60], ['Pertama', 110], ['Terakhir', 110]], prod.no_session.map((n) => [n.machine_id, n.n, T.dateTimeStr(n.first), T.dateTimeStr(n.last)]));
      doc.fontSize(8).fillColor('#444').text('Verifikasi supervisor: ______________________   Tanggal: ____________   Tanda tangan: ______________________');
      doc.end();
      core.audit(req.user ? { id: req.user.id, name: req.user.name } : null, 'EXPORT_PDF', 'report', null, null, req.query);
    } catch (e) { console.error(e); if (!res.headersSent) res.status(500).json({ error: e.message }); }
  });
  return r;
};
