'use strict';
/**
 * Server aplikasi monitoring stamping.
 *   PORT       (default 3000)
 *   DB_PATH    (default data/stamping.db)
 *   SIM_MODE   1 = aktifkan perangkat virtual (default 1 jika tidak diset)
 */
const path = require('node:path');
const express = require('express');
const { createCore } = require('./core');
const { seed } = require('./seed');
const { createSimulator } = require('./sim/simulator');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stamping.db');
const SIM = process.env.SIM_MODE == null ? true : ['1', 'true', 'yes'].includes(String(process.env.SIM_MODE).toLowerCase());

const core = createCore({ dbPath: DB_PATH, simulation: SIM });
if (!core.db.get('SELECT 1 FROM machines LIMIT 1')) seed(core);
core.recoverOnStartup();

const sim = SIM ? createSimulator(core) : null;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const apiRouter = require('./routes/api')(core, sim);
app.use('/api', apiRouter);

// Ekspor memakai autentikasi yang sama
const authOnly = (req, res, next) => {
  const cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')));
  const row = cookies.sm_token && core.db.get('SELECT u.* FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.expires_at > ? AND u.active = 1', cookies.sm_token, Date.now());
  if (!row) return res.status(401).json({ error: 'Silakan login' });
  req.user = row; next();
};
const scopeOf = (req) => {
  if (req.user.role === 'admin') return null;
  const rows = core.db.all('SELECT machine_id FROM supervisor_machines WHERE user_id = ?', req.user.id);
  return rows.length ? rows.map((x) => x.machine_id) : null;
};
app.use('/api', require('./routes/export')(core, { need: authOnly, scopeOf }));

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/terminal/:m', (req, res) => res.redirect(`/terminal.html?m=${encodeURIComponent(req.params.m)}`));

const tick = setInterval(() => { try { core.tick(); } catch (e) { console.error('[tick]', e); } }, 1000);
if (sim) sim.start();

const server = app.listen(PORT, () => {
  console.log(`Monitoring stamping berjalan di http://localhost:${PORT}  (mode ${SIM ? 'SIMULASI' : 'PRODUKSI'})`);
  console.log('Login contoh: admin/admin123 · supervisor/super123 · spv_b/super123 (Area B)');
});
function shutdown() { clearInterval(tick); if (sim) sim.stop(); server.close(); core.db.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
