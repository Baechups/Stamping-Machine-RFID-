'use strict';
/**
 * Utilitas waktu Asia/Jakarta (WIB, UTC+7, tanpa daylight saving).
 * Karena offset tetap, konversi dilakukan secara aritmetika agar deterministik.
 */
const OFFSET = 7 * 3600 * 1000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TZ = 'Asia/Jakarta';

const pad = (n) => String(n).padStart(2, '0');

function parts(ms) {
  const d = new Date(ms + OFFSET);
  const dow = d.getUTCDay();
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
    dow: dow === 0 ? 7 : dow, // 1=Senin..7=Minggu
  };
}
function dateStr(ms) { const p = parts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
function timeStr(ms, sec = true) { const p = parts(ms); return sec ? `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}` : `${pad(p.h)}:${pad(p.mi)}`; }
function dateTimeStr(ms) { return ms == null ? '' : `${dateStr(ms)} ${timeStr(ms)}`; }

/** "YYYY-MM-DD" + "HH:MM" (WIB) → epoch ms */
function fromLocal(date, time = '00:00') {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0) - OFFSET;
}
function addDays(date, n) { return dateStr(fromLocal(date) + n * DAY); }
function dowOf(date) { return parts(fromLocal(date, '12:00')).dow; }
function minutesOf(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function hourFloor(ms) { return Math.floor((ms + OFFSET) / HOUR) * HOUR - OFFSET; }
function dayFloor(ms) { return Math.floor((ms + OFFSET) / DAY) * DAY - OFFSET; }

function fmtDuration(ms) {
  if (ms == null) return '-';
  const neg = ms < 0; ms = Math.abs(Math.round(ms / 1000));
  const h = Math.floor(ms / 3600), m = Math.floor((ms % 3600) / 60), s = ms % 60;
  return `${neg ? '-' : ''}${h ? h + ' jam ' : ''}${h || m ? m + ' mnt ' : ''}${s} dtk`.trim();
}

module.exports = { OFFSET, HOUR, DAY, TZ, parts, dateStr, timeStr, dateTimeStr, fromLocal, addDays, dowOf, minutesOf, hourFloor, dayFloor, fmtDuration };
