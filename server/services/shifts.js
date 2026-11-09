'use strict';
/**
 * Shift 1–5 yang dapat dikonfigurasi. Instans shift dihitung dari tanggal mulai
 * (shift melewati tengah malam berakhir pada hari berikutnya). Zona waktu Asia/Jakarta.
 */
const T = require('../lib/time');

module.exports = function shiftsService(core) {
  const { db } = core;

  function getShift(id) {
    const s = db.get('SELECT * FROM shifts WHERE id = ?', id);
    if (!s) return null;
    s.breaks = db.all('SELECT id, name, start_time, end_time FROM shift_breaks WHERE shift_id = ? ORDER BY start_time', id);
    s.daysArr = s.days ? s.days.split(',').filter(Boolean).map(Number) : [];
    return s;
  }
  function listShifts() { return [1, 2, 3, 4, 5].map(getShift).filter(Boolean); }

  /** Instans konkret shift pada tanggal mulai tertentu. */
  function instance(shift, date) {
    const start = T.fromLocal(date, shift.start_time);
    let end = T.fromLocal(date, shift.end_time);
    if (end <= start) end += T.DAY;
    const startMin = T.minutesOf(shift.start_time);
    const breaks = (shift.breaks || []).map((b) => {
      let bs = T.fromLocal(date, b.start_time);
      if (T.minutesOf(b.start_time) < startMin) bs += T.DAY; // istirahat setelah tengah malam
      let be = T.fromLocal(T.dateStr(bs), b.end_time);
      if (be <= bs) be += T.DAY;
      return { name: b.name, start: bs, end: be };
    }).filter((b) => b.start >= start && b.end <= end);
    return {
      shift_id: shift.id, name: shift.name, date, start, end, breaks,
      late_tolerance_min: shift.late_tolerance_min, early_login_min: shift.early_login_min,
      logout_grace_min: shift.logout_grace_min, version: shift.version,
    };
  }

  /** Semua instans shift aktif yang jendelanya (termasuk login awal) mencakup t. */
  function instancesAround(t, { includeEarly = true, shifts } = {}) {
    const list = shifts || listShifts().filter((s) => s.enabled);
    const today = T.dateStr(t);
    const out = [];
    for (const date of [T.addDays(today, -1), today, T.addDays(today, 1)]) {
      const dow = T.dowOf(date);
      for (const s of list) {
        if (!s.daysArr.includes(dow)) continue;
        const inst = instance(s, date);
        const from = inst.start - (includeEarly ? s.early_login_min * 60000 : 0);
        if (t >= from && t < inst.end) out.push(inst);
      }
    }
    return out;
  }

  function activeAssignments(operatorId, date) {
    return db.all(`SELECT * FROM shift_assignments WHERE operator_id = ? AND active = 1
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)`, operatorId, date, date);
  }

  /**
   * Menentukan shift untuk login operator pada mesin di waktu t.
   * Mengembalikan { ok, instance, assignment, overtime, lateMin, reason }.
   */
  function resolveLoginShift(operatorId, machineId, t) {
    const settings = core.settings.all();
    const candidates = instancesAround(t);
    let wrongMachine = null;
    for (const inst of candidates) {
      const asg = activeAssignments(operatorId, inst.date).filter((a) => a.shift_id === inst.shift_id);
      if (!asg.length) continue;
      const exact = asg.find((a) => a.machine_id === machineId);
      if (!exact && !settings.allow_login_unassigned_machine) { wrongMachine = { inst, asg: asg[0] }; continue; }
      const lateMs = t - inst.start - inst.late_tolerance_min * 60000;
      return { ok: true, instance: inst, assignment: exact || asg[0], lateMin: lateMs > 0 ? Math.round((t - inst.start) / 60000) : 0 };
    }
    // Lembur yang disetujui
    const ot = db.get(`SELECT * FROM overtime_requests WHERE operator_id = ? AND machine_id = ? AND status = 'approved'
      AND start_at - 1800000 <= ? AND end_at > ? ORDER BY start_at LIMIT 1`, operatorId, machineId, t, t);
    if (ot) {
      const shift = ot.shift_id ? getShift(ot.shift_id) : null;
      const inst = {
        shift_id: ot.shift_id, name: shift ? `${shift.name} (lembur)` : 'Lembur', date: T.dateStr(ot.start_at),
        start: ot.start_at, end: ot.end_at, breaks: [], late_tolerance_min: 0, early_login_min: 30, logout_grace_min: 15, overtime: true,
      };
      return { ok: true, instance: inst, overtime: ot, lateMin: 0 };
    }
    if (wrongMachine) {
      return { ok: false, code: 'WRONG_MACHINE', reason: `Operator ditugaskan pada mesin ${wrongMachine.asg.machine_id} untuk ${wrongMachine.inst.name}` };
    }
    // Terlalu awal?
    const upcoming = listShifts().filter((s) => s.enabled).flatMap((s) => {
      const out = [];
      for (const date of [T.dateStr(t), T.addDays(T.dateStr(t), 1)]) {
        if (!s.daysArr.includes(T.dowOf(date))) continue;
        const inst = instance(s, date);
        if (inst.start > t && inst.start - t < 6 * T.HOUR && activeAssignments(operatorId, date).some((a) => a.shift_id === s.id)) out.push(inst);
      }
      return out;
    }).sort((a, b) => a.start - b.start)[0];
    if (upcoming) {
      const opens = upcoming.start - upcoming.early_login_min * 60000;
      return { ok: false, code: 'TOO_EARLY', reason: `Login untuk ${upcoming.name} dibuka pukul ${T.timeStr(opens, false)}` };
    }
    return { ok: false, code: 'NO_SHIFT', reason: 'Di luar jadwal shift dan tidak ada lembur yang disetujui' };
  }

  /** Shift yang berlaku untuk mesin pada waktu t (untuk stamping tanpa sesi). */
  function machineShiftAt(machineId, t) {
    const insts = instancesAround(t, { includeEarly: false });
    for (const inst of insts) {
      const a = db.get(`SELECT 1 FROM shift_assignments WHERE machine_id = ? AND shift_id = ? AND active = 1 AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)`,
        machineId, inst.shift_id, inst.date, inst.date);
      if (a) return inst;
    }
    return insts[0] || null;
  }

  // ---------- Deteksi tabrakan ----------
  /** Interval mingguan [menit] untuk sebuah shift. */
  function weeklyIntervals(s) {
    const days = typeof s.days === 'string' ? s.days.split(',').filter(Boolean).map(Number) : s.daysArr || s.days;
    const st = T.minutesOf(s.start_time); let en = T.minutesOf(s.end_time);
    if (en <= st) en += 1440;
    const W = 7 * 1440, out = [];
    for (const d of days) {
      const a = (d - 1) * 1440 + st, b = (d - 1) * 1440 + en;
      if (b <= W) out.push([a, b]); else { out.push([a, W]); out.push([0, b - W]); }
    }
    return out;
  }
  function shiftsOverlap(a, b) {
    const A = weeklyIntervals(a), B = weeklyIntervals(b);
    return A.some(([s1, e1]) => B.some(([s2, e2]) => Math.min(e1, e2) > Math.max(s1, s2)));
  }
  const datesOverlap = (a, b) => (a.valid_from <= (b.valid_to || '9999-12-31')) && (b.valid_from <= (a.valid_to || '9999-12-31'));

  /** Memeriksa tabrakan penugasan baru terhadap penugasan aktif lain. */
  function assignmentConflicts(asg, { shiftOverride } = {}) {
    const shiftsById = Object.fromEntries(listShifts().map((s) => [s.id, s]));
    if (shiftOverride) shiftsById[shiftOverride.id] = { ...shiftsById[shiftOverride.id], ...shiftOverride };
    const target = shiftsById[asg.shift_id];
    if (!target) return ['Shift tidak ditemukan'];
    const others = db.all('SELECT a.*, o.name AS operator_name FROM shift_assignments a JOIN operators o ON o.id = a.operator_id WHERE a.active = 1 AND a.id != ?', asg.id || -1);
    const conflicts = [];
    for (const o of others) {
      if (!datesOverlap(asg, o)) continue;
      const other = shiftsById[o.shift_id];
      if (!other) continue;
      const sameShift = o.shift_id === asg.shift_id;
      const timeClash = sameShift || (target.enabled && other.enabled && shiftsOverlap(target, other));
      if (!timeClash) continue;
      if (o.operator_id === asg.operator_id) conflicts.push(`Operator ${o.operator_id} sudah ditugaskan pada ${other.name} (mesin ${o.machine_id}) yang waktunya bertabrakan`);
      if (o.machine_id === asg.machine_id) conflicts.push(`Mesin ${o.machine_id} sudah ditugaskan ke ${o.operator_name} pada ${other.name} yang waktunya bertabrakan`);
    }
    return conflicts;
  }

  function validateShift(s) {
    const errs = [];
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!s.name || !String(s.name).trim()) errs.push('Nama shift wajib diisi');
    if (!re.test(s.start_time) || !re.test(s.end_time)) errs.push('Format jam harus HH:MM');
    if (s.start_time === s.end_time) errs.push('Jam mulai dan selesai tidak boleh sama');
    const days = String(s.days || '').split(',').filter(Boolean).map(Number);
    if (s.enabled && !days.length) errs.push('Pilih minimal satu hari operasional');
    if (days.some((d) => d < 1 || d > 7)) errs.push('Hari tidak valid');
    if (!errs.length) {
      const st = T.minutesOf(s.start_time); let en = T.minutesOf(s.end_time); if (en <= st) en += 1440;
      for (const b of s.breaks || []) {
        if (!re.test(b.start_time) || !re.test(b.end_time)) { errs.push(`Format jam istirahat "${b.name}" tidak valid`); continue; }
        let bs = T.minutesOf(b.start_time); if (bs < st) bs += 1440;
        let be = T.minutesOf(b.end_time); if (be < st) be += 1440; if (be <= bs) be += 1440;
        if (bs < st || be > en) errs.push(`Istirahat "${b.name}" berada di luar jam shift`);
      }
    }
    for (const k of ['late_tolerance_min', 'early_login_min', 'logout_grace_min']) {
      if (s[k] != null && (isNaN(s[k]) || s[k] < 0 || s[k] > 240)) errs.push(`Nilai ${k} tidak valid (0–240 menit)`);
    }
    return errs;
  }

  function saveShift(id, data, actor) {
    const before = getShift(id);
    const merged = { ...before, ...data, id };
    const errs = validateShift(merged);
    if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
    // Perubahan jam tidak boleh menyebabkan tabrakan penugasan yang sudah ada
    const asgs = db.all('SELECT * FROM shift_assignments WHERE shift_id = ? AND active = 1', id);
    const conflicts = [];
    for (const a of asgs) conflicts.push(...assignmentConflicts(a, { shiftOverride: { ...merged, daysArr: undefined } }));
    if (conflicts.length) { const e = new Error('Perubahan menyebabkan tabrakan penugasan: ' + [...new Set(conflicts)].slice(0, 5).join('; ')); e.status = 409; throw e; }
    db.tx(() => {
      const version = (before.version || 0) + 1;
      db.run(`UPDATE shifts SET name=?, enabled=?, start_time=?, end_time=?, days=?, late_tolerance_min=?, early_login_min=?, logout_grace_min=?, overtime_enabled=?, version=?, updated_at=? WHERE id=?`,
        merged.name, merged.enabled ? 1 : 0, merged.start_time, merged.end_time, merged.days, merged.late_tolerance_min, merged.early_login_min,
        merged.logout_grace_min, merged.overtime_enabled ? 1 : 0, version, core.clock.now(), id);
      if (data.breaks) {
        db.run('DELETE FROM shift_breaks WHERE shift_id = ?', id);
        for (const b of data.breaks) db.run('INSERT INTO shift_breaks (shift_id, name, start_time, end_time) VALUES (?, ?, ?, ?)', id, b.name || 'Istirahat', b.start_time, b.end_time);
      }
      const after = getShift(id);
      db.run('INSERT INTO shift_versions (shift_id, version, snapshot, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)', id, version, JSON.stringify(after), actor?.id ?? null, core.clock.now());
      core.audit(actor, 'SHIFT_UPDATE', 'shift', id, before, after);
    });
    return getShift(id);
  }

  return { getShift, listShifts, instance, instancesAround, resolveLoginShift, machineShiftAt, assignmentConflicts, shiftsOverlap, validateShift, saveShift, activeAssignments };
};
