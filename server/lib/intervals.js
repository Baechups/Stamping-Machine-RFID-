'use strict';
/**
 * Aritmetika interval [start, end) untuk perhitungan durasi tanpa penggandaan.
 * Kejadian asli tidak pernah diubah; pemecahan hanya untuk pelaporan.
 */
const { hourFloor, HOUR } = require('./time');

function clip(a, s, e) {
  const start = Math.max(a.start, s), end = Math.min(a.end, e);
  return end > start ? { ...a, start, end } : null;
}
function overlap(aS, aE, bS, bE) { return Math.max(0, Math.min(aE, bE) - Math.max(aS, bS)); }

/** Pecah [start,end) pada batas jam WIB. */
function splitByHour(start, end) {
  const out = [];
  let t = start;
  while (t < end) {
    const next = Math.min(end, hourFloor(t) + HOUR);
    out.push({ hour: hourFloor(t), start: t, end: next });
    t = next;
  }
  return out;
}

/**
 * Partisi rentang [start,end) menjadi potongan elementer berdasarkan semua batas
 * dari layer interval. Setiap potongan diberi label oleh fungsi classify(activeLayers).
 * layers: { name: [{start,end,...}] }
 * Mengembalikan potongan berurutan yang tidak saling tumpang tindih.
 */
function partition(start, end, layers, classify, { splitHours = false } = {}) {
  const points = new Set([start, end]);
  for (const list of Object.values(layers)) {
    for (const it of list) {
      if (it.start > start && it.start < end) points.add(it.start);
      if (it.end > start && it.end < end) points.add(it.end);
    }
  }
  if (splitHours) {
    for (let h = hourFloor(start) + HOUR; h < end; h += HOUR) points.add(h);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const s = sorted[i], e = sorted[i + 1];
    if (e <= s) continue;
    const mid = s + (e - s) / 2;
    const active = {};
    for (const [name, list] of Object.entries(layers)) {
      active[name] = list.filter((it) => it.start <= mid && it.end > mid);
    }
    pieces.push({ start: s, end: e, hour: hourFloor(s), label: classify(active), active });
  }
  return pieces;
}

function sumBy(pieces, label) { return pieces.filter((p) => p.label === label).reduce((a, p) => a + (p.end - p.start), 0); }

module.exports = { clip, overlap, splitByHour, partition, sumBy };
