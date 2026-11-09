import { api, esc, fmtDate, fmtT, toast } from './util.js';

const PAGES = [
  { grp: 'Pemantauan' },
  { path: 'dashboard', label: 'Dashboard 30 mesin', ico: '▦', mod: 'dashboard' },
  { path: 'mesin', label: 'Detail mesin & sesi', ico: '⚙', mod: 'machine', hidden: false },
  { path: 'perangkat', label: 'Status perangkat & gangguan', ico: '⚠', mod: 'devices' },
  { path: 'terminal', label: 'Terminal operator', ico: '🖥', href: '/terminal.html?m=M01', external: true },
  { grp: 'Laporan' },
  { path: 'riwayat', label: 'Riwayat sesi & ketidakhadiran', ico: '🕘', mod: 'history' },
  { path: 'laporan', label: 'Laporan produksi & penyimpangan', ico: '📊', mod: 'reports' },
  { path: 'produksi', label: 'Work order & hasil produksi', ico: '📋', mod: 'workorders' },
  { grp: 'Master data' },
  { path: 'operator', label: 'Operator & RFID', ico: '👤', mod: 'operators' },
  { path: 'shift', label: 'Shift & penugasan', ico: '⏱', mod: 'shifts' },
  { path: 'produk', label: 'Produk & standar stamping', ico: '⬢', mod: 'products' },
  { path: 'kamera', label: 'Kamera & area deteksi', ico: '◎', mod: 'cameras' },
  { grp: 'Administrasi', role: 'admin' },
  { path: 'audit', label: 'Audit log', ico: '🔒', mod: 'audit', role: 'admin' },
  { path: 'pengaturan', label: 'Pengaturan sistem', ico: '⚒', mod: 'settings' },
];

let navToken = 0;
const state = { user: null, info: null, scope: null, cleanup: null, liveHandlers: new Set(), es: null };
const root = document.getElementById('root');

window.addEventListener('unauthorized', () => { state.user = null; renderLogin('Sesi login berakhir. Silakan login kembali.'); });

async function boot() {
  state.info = await api('/public/info').catch(() => ({ plant_name: 'Monitoring Stamping', simulation: false }));
  const me = await api('/auth/me').catch(() => ({ user: null }));
  state.user = me.user; state.scope = me.scope;
  if (!state.user) return renderLogin();
  renderShell();
  route();
}

function renderLogin(msg) {
  closeLive();
  root.innerHTML = `<div class="login-wrap"><div class="login-card">
    <div class="brand" style="color:var(--ink);padding:0"><div class="brand-logo" style="color:#fff">SM</div><div><b>Monitoring Stamping</b><small style="color:var(--ink-3)">${esc(state.info?.plant_name || '')}</small></div></div>
    <h1>Login admin / supervisor</h1><p class="muted">Operator login melalui kartu RFID di terminal mesin.</p>
    ${state.info?.simulation ? '<div class="notice" style="margin-top:10px"><b>Mode simulasi.</b> Akun contoh: <code>admin / admin123</code>, <code>supervisor / super123</code>, <code>spv_b / super123</code> (Area B).</div>' : ''}
    <form id="loginForm">
      <div class="field"><label for="u">Nama pengguna</label><input id="u" name="username" autocomplete="username" required></div>
      <div class="field"><label for="p">Kata sandi</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
      <div class="form-error" role="alert">${esc(msg || '')}</div>
      <button class="btn btn-primary" style="justify-content:center;padding:10px">Masuk</button>
    </form>
    <p class="small muted" style="margin-top:16px">Pemberitahuan: ${esc(state.info?.monitoring_notice || '')}</p>
  </div></div>`;
  const f = document.getElementById('loginForm');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
      state.user = r.user;
      const me = await api('/auth/me'); state.scope = me.scope;
      renderShell(); route();
    } catch (err) { f.querySelector('.form-error').textContent = err.message; }
  });
  document.getElementById('u').focus();
}

function renderShell() {
  const nav = PAGES.filter((p) => !p.role || p.role === state.user.role).map((p) => {
    if (p.grp) return `<div class="grp">${esc(p.grp)}</div>`;
    if (p.external) return `<a href="${p.href}" target="_blank" rel="noopener"><span class="ico" aria-hidden="true">${p.ico}</span>${esc(p.label)} ↗</a>`;
    return `<a href="#/${p.path}" data-path="${p.path}"><span class="ico" aria-hidden="true">${p.ico}</span>${esc(p.label)}</a>`;
  }).join('');
  root.innerHTML = `<div class="app">
    <aside class="sidebar" id="sidebar"><div class="brand"><div class="brand-logo">SM</div><div><b>Monitoring Stamping</b><small>Rangka kursi bus · 30 mesin</small></div></div>
      <nav class="nav" aria-label="Navigasi utama">${nav}</nav></aside>
    <div class="main">
      ${state.info.simulation ? `<div class="sim-banner" role="status">🧪 MODE SIMULASI — RFID, kamera, sensor stamping, dan pengendali adalah perangkat virtual. Data bertanda "Simulasi" bukan dari perangkat fisik.
        <button class="btn btn-sm" id="simStart">▶ Jalankan skenario 30 mesin</button><button class="btn btn-sm" id="simStop">■ Hentikan skenario</button></div>` : ''}
      <header class="topbar"><button class="icon-btn menu-btn" id="menuBtn" aria-label="Buka menu">☰</button>
        <div><b id="pageTitle"></b></div><div class="spacer"></div>
        <span class="clock" id="clock"></span>
        <span class="small">${esc(state.user.name)} · <span class="badge b-info">${state.user.role === 'admin' ? 'Admin' : 'Supervisor'}</span>${state.scope ? ` <span class="badge b-muted" title="${esc(state.scope.join(', '))}">${state.scope.length} mesin</span>` : ''}</span>
        <button class="btn btn-sm" id="logoutBtn">Keluar</button></header>
      <main class="content" id="content"></main>
    </div></div>`;
  document.getElementById('logoutBtn').onclick = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); state.user = null; renderLogin(); };
  document.getElementById('menuBtn').onclick = () => document.getElementById('sidebar').classList.toggle('open');
  const ss = document.getElementById('simStart');
  if (ss) {
    ss.onclick = async () => { ss.disabled = true; try { const r = await api('/sim/scenario/start', { method: 'POST' }); toast(r.ok ? `Skenario dijalankan untuk ${r.shift}: ${r.machines.length} tap login` : r.error, r.ok ? 'success' : 'warning'); } catch (e) { toast(e.message, 'error'); } ss.disabled = false; };
    document.getElementById('simStop').onclick = async () => { await api('/sim/scenario/stop', { method: 'POST' }); toast('Skenario dihentikan (mesin virtual berhenti)', 'info'); };
  }
  const tick = () => { const c = document.getElementById('clock'); if (c) c.textContent = `${fmtDate(Date.now())} · ${fmtT(Date.now())} WIB`; };
  tick(); setInterval(tick, 1000);
  openLive();
}

function openLive() {
  closeLive();
  try {
    state.es = new EventSource('/api/stream');
    state.es.addEventListener('machines', (e) => { const ids = JSON.parse(e.data); for (const h of state.liveHandlers) h(ids); });
  } catch { /* fallback polling di halaman */ }
}
function closeLive() { if (state.es) state.es.close(); state.es = null; }

async function route() {
  if (!state.user) return;
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, ...rest] = hash.split('?')[0].split('/');
  const page = PAGES.find((p) => p.path === path && p.mod) || PAGES[1];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.path === page.path));
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('pageTitle').textContent = page.label;
  document.title = `${page.label} — Monitoring Stamping`;
  if (state.cleanup) { try { state.cleanup(); } catch { /* */ } state.cleanup = null; }
  state.liveHandlers.clear();
  const myToken = ++navToken;
  // Setiap navigasi memakai elemen baru: pemuatan data halaman lama yang terlambat menulis ke elemen terlepas
  const host = document.getElementById('content');
  const el = document.createElement('div');
  el.innerHTML = '<div class="empty">Memuat…</div>';
  host.replaceChildren(el);
  try {
    const mod = await import(`./pages/${page.mod}.js`);
    const ctx = {
      user: state.user, info: state.info, scope: state.scope, params: rest.map(decodeURIComponent),
      query: Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')),
      onLive: (fn) => state.liveHandlers.add(fn), go: (p) => { location.hash = `#/${p}`; },
      isAdmin: state.user.role === 'admin',
      alive: () => myToken === navToken,
    };
    const cleanup = await mod.render(el, ctx);
    if (myToken === navToken) state.cleanup = cleanup; else if (typeof cleanup === 'function') cleanup();
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="notice bad">Gagal memuat halaman: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
boot();
