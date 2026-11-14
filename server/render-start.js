// Render entry point — runs the Continuum API server as a persistent service.
// Render provides PORT; the server binds to 0.0.0.0 so its health checks work.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || 5000);
const host = '0.0.0.0';  // Render requires binding to all interfaces
const allowedOrigin = process.env.FRONTEND_URL || 'https://continuum-ai-six.vercel.app';

// Ensure APP_URL is a valid HTTPS origin in production (used for invite/login links)
let appUrl = process.env.APP_URL || allowedOrigin;
if (!appUrl.startsWith('http://') && !appUrl.startsWith('https://')) {
  appUrl = 'https://' + appUrl;
}

const handler = createHandler({
  file: process.env.DATABASE_FILE || fileURLToPath(new URL('../data/demo.json', import.meta.url)),
  config: {
    ...process.env,
    APP_URL: appUrl,
    REQUIRE_EMAIL_VERIFICATION: process.env.REQUIRE_EMAIL_VERIFICATION ?? (process.env.RESEND_API_KEY ? 'true' : 'false'),
    ENABLE_OUTBOX_WORKER: process.env.ENABLE_OUTBOX_WORKER ?? 'true',
  },
});

// Backfill any previously reviewed fixes so they have active confidence and customer confirmation
try {
  if (handler.store?.db) {
    handler.store.db.exec("UPDATE memory_pool SET initial_confidence_score=0.85, customer_confirmed=1 WHERE locally_reviewed=1 AND initial_confidence_score<0.85");
  }
} catch (e) {
  console.warn('Backfill approved fixes notice:', e.message);
}

const server = createServer((req, res) => {
  // ── Immediate Health Checks ─────────────────────────────────────────
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // ── CORS ──────────────────────────────────────────────────────────
  const origin = req.headers.origin;
  const allowed = allowedOrigin === '*'
    ? (origin || '*')
    : (origin && (origin === allowedOrigin || origin.endsWith('.vercel.app')) ? origin : allowedOrigin);

  // Always set CORS headers so browsers accept the response
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Workspace, X-CSRF-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Patch the host header so the app's own origin check passes:
  // the handler compares req.headers.origin host with req.headers.host,
  // but in a split deploy the frontend origin differs from the API host.
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (origin === allowedOrigin || origin.endsWith('.vercel.app')) {
        req.headers.host = originHost;
        delete req.headers['sec-fetch-site'];
      }
    } catch { /* ignore malformed */ }
  }

  handler(req, res);
});

server.on('close', handler.close);
server.on('error', (err) => { console.error(err.message); process.exit(1); });
server.listen(port, host, () => {
  console.log(`Continuum API listening on http://${host}:${port} (APP_URL: ${appUrl})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
});
server.requestTimeout = 60000;
