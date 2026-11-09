// Utilitas bersama antarmuka (format waktu Asia/Jakarta, escape HTML, panggilan API)
export const TZ = 'Asia/Jakarta';

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const dtf = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const tf = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const hm = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const df = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDT = (ms) => (ms ? dtf.format(new Date(ms)).replace(/\./g, ':') : '—');
export const fmtT = (ms) => (ms ? tf.format(new Date(ms)).replace(/\./g, ':') : '—');
export const fmtHM = (ms) => (ms ? hm.format(new Date(ms)).replace(/\./g, ':') : '—');
export const fmtDate = (ms) => df.format(new Date(ms));
export function fmtDur(ms) {
  if (ms == null) return '—';
  const neg = ms < 0; let s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600; const m = Math.floor(s / 60); s -= m * 60;
  return (neg ? '−' : '') + (h ? `${h} j ${String(m).padStart(2, '0')} mnt` : m ? `${m} mnt ${String(s).padStart(2, '0')} dtk` : `${s} dtk`);
}
export const fmtNum = (n, d = 0) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('id-ID', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
export const signed = (n, d = 0) => (n == null ? '—' : `${n > 0 ? '+' : ''}${fmtNum(n, d)}`);

/** Tanggal lokal WIB → epoch ms. date "YYYY-MM-DD", time "HH:MM" */
export function wibToMs(date, time = '00:00') {
  const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h || 0, mi || 0) - 7 * 3600e3;
}
export function msToWibDate(ms) { const d = new Date(ms + 7 * 3600e3); return d.toISOString().slice(0, 10); }
export function msToWibTime(ms) { const d = new Date(ms + 7 * 3600e3); return d.toISOString().slice(11, 16); }

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* kosong */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Gagal (${res.status})`); e.status = res.status;
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/terminal') && !path.startsWith('/sim')) window.dispatchEvent(new CustomEvent('unauthorized'));
    throw e;
  }
  return data;
}

export function toast(msg, type = 'info') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<strong>${{ success: '✔ Berhasil', error: '✖ Gagal', warning: '⚠ Perhatian', info: 'ℹ Info' }[type] || ''}</strong> ${esc(msg)}`;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 7000 : 4000);
}

/** Dialog modal sederhana. fields: [{name,label,type,options,required,value,help}] */
export function modal({ title, body = '', fields = [], submit = 'Simpan', danger = false, onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    const fieldHtml = fields.map((f) => {
      const id = `f_${f.name}`;
      const req = f.required ? 'required' : '';
      let input;
      if (f.type === 'select') input = `<select id="${id}" name="${f.name}" ${req}>${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') input = `<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${req} placeholder="${esc(f.placeholder || '')}">${esc(f.value ?? '')}</textarea>`;
      else if (f.type === 'checkbox') input = `<label class="check"><input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''} ${req}> ${esc(f.checkLabel || '')}</label>`;
      else input = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${req} ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.step ? `step="${f.step}"` : ''} placeholder="${esc(f.placeholder || '')}">`;
      return `<div class="field ${f.half ? 'half' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ''}</label>${input}${f.help ? `<small>${esc(f.help)}</small>` : ''}</div>`;
    }).join('');
    wrap.innerHTML = `<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mtitle"><form>
      <header><h3 id="mtitle">${esc(title)}</h3><button type="button" class="icon-btn" data-close aria-label="Tutup">✕</button></header>
      <div class="modal-body">${body}<div class="form-grid">${fieldHtml}</div><div class="form-error" role="alert"></div></div>
      <footer><button type="button" class="btn" data-close>Batal</button><button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submit)}</button></footer></form></div>`;
    document.body.appendChild(wrap);
    const form = wrap.querySelector('form');
    const close = (v) => { wrap.remove(); resolve(v); };
    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = {};
      for (const f of fields) { const el = form.elements[f.name]; data[f.name] = f.type === 'checkbox' ? el.checked : el.value; }
      try {
        const r = onSubmit ? await onSubmit(data) : data;
        close(r ?? data);
      } catch (err) { wrap.querySelector('.form-error').textContent = err.message; }
    });
    setTimeout(() => (form.querySelector('input,select,textarea') || form.querySelector('button[type=submit]')).focus(), 30);
  });
}
export function confirmBox(title, text, { danger = true, submit = 'Ya, lanjutkan' } = {}) { return modal({ title, body: `<p>${esc(text)}</p>`, submit, danger }); }

export const STATUS = {
  presence: { PRESENT: ['ok', 'Hadir'], ABSENT: ['bad', 'Tidak terdeteksi'], CHECKING: ['warn', 'Memeriksa…'], BREAK: ['info', 'Istirahat'], LEAVE: ['info', 'Izin'], UNKNOWN: ['muted', 'Tidak diketahui'], NO_SESSION: ['muted', 'Tidak ada sesi'] },
  physical: { RUNNING: 'ok', IDLE: 'info', STOPPED: 'muted', ESTOP: 'bad', FAULT: 'bad', POWER_OFF: 'bad', UNKNOWN: 'muted' },
  device: { ok: 'ok', offline: 'bad', fault: 'bad', degraded: 'warn', obstructed: 'warn', unknown: 'muted' },
  prod: { OK: 'ok', REVIEW: 'bad', PROVISIONAL: 'warn', NO_STANDARD: 'muted', NOT_APPLICABLE: 'muted' },
  session: { ACTIVE: 'ok', PENDING_PERMISSION: 'warn', LOGOUT_REQUESTED: 'warn', LOGOUT_FAILED: 'bad', CLOSED: 'muted', FORCE_CLOSED: 'warn', PERMISSION_FAILED: 'bad' },
};
const ICON = { ok: '●', bad: '▲', warn: '◆', info: '■', muted: '○' };
/** Lencana status: selalu teks + simbol + warna (tidak mengandalkan warna saja). */
export const badge = (tone, text, title) => `<span class="badge b-${tone}" ${title ? `title="${esc(title)}"` : ''}><span aria-hidden="true">${ICON[tone] || '●'}</span> ${esc(text)}</span>`;
export const CATEGORY = { normal: 'Produksi normal', setup: 'Setup', trial: 'Uji coba', rework: 'Rework', unassigned: 'Tanpa pekerjaan' };
export const CLASS_LABEL = { PRESENT: 'Hadir (deteksi keliru)', ABSENT: 'Tidak hadir', BREAK: 'Istirahat terjadwal', LEAVE: 'Izin disetujui', UNKNOWN: 'Tidak diketahui (gangguan pemantauan)' };
export const DEVICE_NAME = { edge: 'Perangkat lokal', rfid: 'RFID', camera: 'Kamera', sensor: 'Sensor', controller: 'Pengendali', terminal: 'Terminal' };
export function download(path) { const a = document.createElement('a'); a.href = `/api${path}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
export function qs(obj) { const p = new URLSearchParams(); for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; }
