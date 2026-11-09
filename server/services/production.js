'use strict';
/**
 * Standar stamping, hasil produksi, dan analisis stamping vs hasil.
 *
 * Definisi jumlah (tidak ada penghitungan ganda):
 *  Pekerjaan kategori "normal":
 *    good_qty             = produk baik lolos pertama (first-pass)
 *    rework_qty           = pcs yang menyelesaikan tahap tetapi dikirim ke rework (belum dianggap baik)
 *    reject_completed_qty = reject setelah tahap selesai
 *    reject_incomplete_qty= reject sebelum tahap selesai  → perlu rekonsiliasi
 *    wip_qty              = produk dalam proses           → perlu rekonsiliasi
 *  Pekerjaan kategori "rework":
 *    rework_qty           = pcs yang diproses ulang
 *    rework_good_qty      = pcs rework yang menjadi baik  → ditambahkan ke total produk baik SEKALI
 *    reject_completed_qty = pcs rework yang akhirnya reject
 *
 *  Dasar perhitungan standar (pcs yang menyelesaikan tahap) = good + reject_completed + rework_qty (pekerjaan normal)
 *  Siklus standar = dasar pcs × cycles_per_set ÷ pcs_per_set
 *  Selisih = siklus produksi normal aktual − siklus standar − siklus rekonsiliasi
 */
module.exports = function productionService(core) {
  const { db } = core;

  function standardFor(productId, stageId, t) {
    if (!productId || !stageId) return null;
    return db.get(`SELECT id, product_id, stage_id, cycles_per_set, pcs_per_set, tolerance_pct, effective_from, effective_to, note FROM stamping_standards
      WHERE product_id = ? AND stage_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from DESC LIMIT 1`, productId, stageId, t, t) || null;
  }

  function saveStandard(data, actor) {
    const cps = Number(data.cycles_per_set), pps = Number(data.pcs_per_set), tol = Number(data.tolerance_pct ?? 5);
    if (!(cps > 0) || !(pps > 0)) { const e = new Error('Jumlah siklus dan pcs standar harus lebih dari nol'); e.status = 400; throw e; }
    if (!(tol >= 0 && tol <= 100)) { const e = new Error('Toleransi harus 0–100%'); e.status = 400; throw e; }
    const stage = db.get('SELECT * FROM process_stages WHERE id = ? AND product_id = ?', data.stage_id, data.product_id);
    if (!stage) { const e = new Error('Tahap proses tidak sesuai produk'); e.status = 400; throw e; }
    const from = data.effective_from ? Number(data.effective_from) : core.clock.now();
    let id;
    db.tx(() => {
      const prev = db.get('SELECT * FROM stamping_standards WHERE product_id = ? AND stage_id = ? AND (effective_to IS NULL OR effective_to > ?) ORDER BY effective_from DESC LIMIT 1', data.product_id, data.stage_id, from);
      if (prev) {
        if (prev.effective_from >= from) { const e = new Error('Tanggal berlaku harus setelah standar sebelumnya'); e.status = 400; throw e; }
        db.run('UPDATE stamping_standards SET effective_to = ? WHERE id = ?', from, prev.id);
      }
      const r = db.run(`INSERT INTO stamping_standards (product_id, stage_id, cycles_per_set, pcs_per_set, tolerance_pct, effective_from, note, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, data.product_id, data.stage_id, cps, pps, tol, from, data.note || null, actor?.id ?? null, core.clock.now());
      id = Number(r.lastInsertRowid);
      core.audit(actor, 'STANDARD_CHANGE', 'stamping_standard', id, prev || null, { product: data.product_id, stage: data.stage_id, cps, pps, tol, from }, data.note);
    });
    return db.get('SELECT * FROM stamping_standards WHERE id = ?', id);
  }

  const INT_FIELDS = ['good_qty', 'reject_completed_qty', 'reject_incomplete_qty', 'rework_qty', 'rework_good_qty', 'wip_qty'];

  /** Simpan/koreksi hasil produksi suatu pekerjaan. Setiap koreksi tersimpan di histori & audit log. */
  function saveResult(jobId, data, actor, { source, reason } = {}) {
    const job = db.get('SELECT * FROM session_jobs WHERE id = ?', jobId);
    if (!job) { const e = new Error('Pekerjaan tidak ditemukan'); e.status = 404; throw e; }
    const vals = {};
    for (const f of INT_FIELDS) {
      const v = data[f] == null || data[f] === '' ? 0 : Number(data[f]);
      if (!Number.isInteger(v) || v < 0 || v > 1e6) { const e = new Error(`Nilai ${f} harus bilangan bulat ≥ 0`); e.status = 400; throw e; }
      vals[f] = v;
    }
    if (job.category === 'normal') vals.rework_good_qty = 0;
    if (job.category === 'rework' && vals.rework_good_qty + vals.reject_completed_qty > vals.rework_qty) {
      const e = new Error('Jumlah rework baik + reject tidak boleh melebihi jumlah yang di-rework'); e.status = 400; throw e;
    }
    if (job.category === 'rework') vals.good_qty = 0; // produk baik dari rework dicatat di rework_good_qty
    if ((vals.reject_completed_qty + vals.reject_incomplete_qty) > 0 && !data.reject_reasons) { const e = new Error('Alasan reject wajib diisi'); e.status = 400; throw e; }
    if (job.category === 'normal' && vals.rework_qty > 0 && !data.rework_reasons) { const e = new Error('Alasan rework wajib diisi'); e.status = 400; throw e; }
    const now = core.clock.now();
    const existing = db.get('SELECT * FROM production_results WHERE job_id = ?', jobId);
    let id;
    db.tx(() => {
      if (existing) {
        if (!reason || reason.trim().length < 5) { const e = new Error('Koreksi hasil produksi wajib disertai alasan (minimal 5 karakter)'); e.status = 400; throw e; }
        db.run('INSERT INTO production_result_history (result_id, version, snapshot, changed_by, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)',
          existing.id, existing.version, JSON.stringify(existing), actor?.name || actor?.label || 'sistem', now, reason);
        db.run(`UPDATE production_results SET good_qty=?, reject_completed_qty=?, reject_incomplete_qty=?, rework_qty=?, rework_good_qty=?, wip_qty=?, reject_reasons=?, rework_reasons=?,
          source=?, is_final=?, verification_status='UNVERIFIED', verified_by=NULL, verified_at=NULL, entered_by=?, entered_at=?, version=version+1 WHERE id=?`,
        vals.good_qty, vals.reject_completed_qty, vals.reject_incomplete_qty, vals.rework_qty, vals.rework_good_qty, vals.wip_qty, data.reject_reasons || null, data.rework_reasons || null,
        source, data.is_final ? 1 : 0, actor?.name || actor?.label, now, existing.id);
        id = existing.id;
        core.audit(actor, 'PRODUCTION_CORRECTION', 'production_result', id, existing, { ...vals, is_final: !!data.is_final }, reason);
      } else {
        const r = db.run(`INSERT INTO production_results (job_id, session_id, work_order_id, machine_id, operator_id, good_qty, reject_completed_qty, reject_incomplete_qty, rework_qty,
          rework_good_qty, wip_qty, reject_reasons, rework_reasons, source, is_final, entered_by, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        job.id, job.session_id, job.work_order_id, job.machine_id, job.operator_id, vals.good_qty, vals.reject_completed_qty, vals.reject_incomplete_qty, vals.rework_qty,
        vals.rework_good_qty, vals.wip_qty, data.reject_reasons || null, data.rework_reasons || null, source, data.is_final ? 1 : 0, actor?.name || actor?.label, now);
        id = Number(r.lastInsertRowid);
        core.audit(actor, 'PRODUCTION_RESULT', 'production_result', id, null, { job: job.id, ...vals, source, is_final: !!data.is_final });
      }
    });
    core.changed(job.machine_id);
    return db.get('SELECT * FROM production_results WHERE id = ?', id);
  }

  /** Verifikasi supervisor: status, penjelasan penyimpangan, siklus rekonsiliasi untuk WIP/reject belum selesai. */
  function verifyResult(resultId, actor, { status = 'VERIFIED', explanation, reconciliation_cycles, note }) {
    const r = db.get('SELECT * FROM production_results WHERE id = ?', resultId);
    if (!r) { const e = new Error('Hasil produksi tidak ditemukan'); e.status = 404; throw e; }
    if (!['VERIFIED', 'DISPUTED', 'UNVERIFIED'].includes(status)) { const e = new Error('Status verifikasi tidak valid'); e.status = 400; throw e; }
    const rc = reconciliation_cycles == null || reconciliation_cycles === '' ? r.reconciliation_cycles : Number(reconciliation_cycles);
    if (!(rc >= 0)) { const e = new Error('Siklus rekonsiliasi harus ≥ 0'); e.status = 400; throw e; }
    if (status === 'VERIFIED' && !r.is_final) { const e = new Error('Hasil belum final — tidak dapat diverifikasi'); e.status = 409; throw e; }
    db.tx(() => {
      db.run('INSERT INTO production_result_history (result_id, version, snapshot, changed_by, changed_at, reason) VALUES (?, ?, ?, ?, ?, ?)',
        r.id, r.version, JSON.stringify(r), actor?.name, core.clock.now(), `Verifikasi: ${status}`);
      db.run(`UPDATE production_results SET verification_status = ?, deviation_explanation = COALESCE(?, deviation_explanation), reconciliation_cycles = ?,
        supervisor_note = COALESCE(?, supervisor_note), verified_by = ?, verified_at = ?, version = version + 1 WHERE id = ?`,
      status, explanation || null, rc, note || null, actor?.id ?? null, core.clock.now(), r.id);
      core.audit(actor, 'PRODUCTION_VERIFY', 'production_result', r.id, { status: r.verification_status, reconciliation_cycles: r.reconciliation_cycles },
        { status, reconciliation_cycles: rc, explanation }, note || explanation);
    });
    return db.get('SELECT * FROM production_results WHERE id = ?', resultId);
  }

  function jobCycles(jobId) {
    const out = { normal: 0, setup: 0, trial: 0, rework: 0, unassigned: 0, total: 0 };
    for (const r of db.all('SELECT category, COUNT(*) AS n FROM stamping_events WHERE job_id = ? GROUP BY category', jobId)) { out[r.category] = r.n; out.total += r.n; }
    return out;
  }

  /** Analisis satu pekerjaan. */
  function analyzeJob(job) {
    const cycles = jobCycles(job.id);
    const result = db.get('SELECT * FROM production_results WHERE job_id = ?', job.id) || null;
    const std = job.standard_snapshot ? JSON.parse(job.standard_snapshot) : null;
    return { job, cycles, result, standard: std, ...compute([{ job, cycles, result, std }]) };
  }

  /**
   * Inti perhitungan untuk satu atau beberapa pekerjaan (agregasi per WO/mesin/operator/shift).
   * Standar diterapkan per pekerjaan memakai salinan standar milik pekerjaan tersebut.
   */
  function compute(items) {
    const tot = { normal: 0, setup: 0, trial: 0, rework: 0, unassigned: 0, total: 0 };
    const qty = { good_first_pass: 0, rework_good: 0, good_total: 0, reject_completed: 0, reject_incomplete: 0, rework_sent: 0, rework_processed: 0, wip: 0, basis_pcs: 0 };
    let stdCycles = 0, reconc = 0, missingStd = false, missingResult = false, notFinal = false, needsReconc = false, allVerified = true, anyNormal = false;
    let tolerance = null;
    for (const { job, cycles, result, std } of items) {
      for (const k of Object.keys(tot)) tot[k] += cycles[k] || 0;
      const r = result || {};
      if (job.category === 'normal') {
        anyNormal = true;
        qty.good_first_pass += r.good_qty || 0;
        qty.reject_completed += r.reject_completed_qty || 0;
        qty.reject_incomplete += r.reject_incomplete_qty || 0;
        qty.rework_sent += r.rework_qty || 0;
        qty.wip += r.wip_qty || 0;
        const basis = (r.good_qty || 0) + (r.reject_completed_qty || 0) + (r.rework_qty || 0);
        qty.basis_pcs += basis;
        if (!result) { if (cycles.normal > 0) missingResult = true; }
        else {
          if (!result.is_final) notFinal = true;
          if ((result.wip_qty > 0 || result.reject_incomplete_qty > 0) && !(result.reconciliation_cycles > 0) && result.verification_status !== 'VERIFIED') needsReconc = true;
          reconc += result.reconciliation_cycles || 0;
          if (result.verification_status !== 'VERIFIED') allVerified = false;
        }
        if (!std) { if (cycles.normal > 0 || basis > 0) missingStd = true; }
        else {
          stdCycles += basis * std.cycles_per_set / std.pcs_per_set;
          tolerance = tolerance == null ? std.tolerance_pct : Math.min(tolerance, std.tolerance_pct);
        }
      } else if (job.category === 'rework') {
        qty.rework_processed += r.rework_qty || 0;
        qty.rework_good += r.rework_good_qty || 0;
        qty.reject_completed += r.reject_completed_qty || 0;
        if (result && result.verification_status !== 'VERIFIED') allVerified = false;
      }
    }
    qty.good_total = qty.good_first_pass + qty.rework_good;
    const out = { cycles: tot, qty, standard_cycles: null, reconciliation_cycles: reconc, diff: null, diff_pct: null, ratio_total_per_good: null, tolerance_pct: tolerance };
    out.ratio_total_per_good = qty.good_total > 0 ? round(tot.total / qty.good_total, 3) : null;
    out.basis_explanation = `Dasar perhitungan: ${qty.basis_pcs} pcs yang menyelesaikan tahap proses (baik ${qty.good_first_pass} + reject setelah tahap ${items.reduce((a, i) => a + (i.job.category === 'normal' ? (i.result?.reject_completed_qty || 0) : 0), 0)} + dikirim rework ${qty.rework_sent}). ` +
      `Tidak termasuk produk dalam proses (${qty.wip}) dan reject sebelum tahap selesai (${qty.reject_incomplete})` + (reconc ? `; ${reconc} siklus direkonsiliasi supervisor untuk produk tersebut.` : '.');

    const completeness = [];
    if (tot.unassigned > 0) completeness.push(`${tot.unassigned} siklus tanpa pekerjaan terpilih`);
    if (missingResult) completeness.push('Hasil produksi belum diinput');
    if (notFinal) completeness.push('Hasil produksi belum final');
    if (needsReconc) completeness.push('Produk dalam proses / reject sebelum tahap selesai belum direkonsiliasi');
    out.completeness = completeness;

    if (!anyNormal) { out.status = 'NOT_APPLICABLE'; out.status_label = 'Tidak ada produksi normal'; return out; }
    if (missingStd) { out.status = 'NO_STANDARD'; out.status_label = 'Standar belum tersedia'; return out; }
    out.standard_cycles = round(stdCycles, 2);
    out.diff = round(tot.normal - stdCycles - reconc, 2);
    out.diff_pct = stdCycles > 0 ? round(out.diff / stdCycles * 100, 1) : null;
    if (missingResult && qty.basis_pcs === 0) { out.diff = null; out.diff_pct = null; } // tanpa hasil, selisih tidak bermakna
    if (missingResult || notFinal || needsReconc) { out.status = 'PROVISIONAL'; out.status_label = 'Sementara — perlu rekonsiliasi'; return out; }
    if (stdCycles === 0) { out.status = tot.normal > 0 ? 'REVIEW' : 'OK'; out.status_label = tot.normal > 0 ? 'Perlu ditinjau' : 'Sesuai standar'; }
    else if (Math.abs(out.diff_pct) <= (tolerance ?? 0)) { out.status = 'OK'; out.status_label = 'Sesuai standar'; }
    else { out.status = 'REVIEW'; out.status_label = 'Perlu ditinjau'; }
    out.verified = allVerified;
    if (allVerified && out.status === 'REVIEW') out.status_label = 'Perlu ditinjau — sudah diverifikasi supervisor';
    return out;
  }
  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  function analyzeJobs(jobs) {
    return compute(jobs.map((job) => ({ job, cycles: jobCycles(job.id), result: db.get('SELECT * FROM production_results WHERE job_id = ?', job.id), std: job.standard_snapshot ? JSON.parse(job.standard_snapshot) : null })));
  }

  return { standardFor, saveStandard, saveResult, verifyResult, analyzeJob, analyzeJobs, compute, jobCycles };
};
