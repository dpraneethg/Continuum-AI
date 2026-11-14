// Render entry point — runs the Continuum API server as a persistent service.
// Render provides PORT; the server binds to 0.0.0.0 so its health checks work.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const port = Number(process.env.PORT || 5000);
const host = '0.0.0.0';  // Render requires binding to all interfaces
const allowedOrigin = process.env.FRONTEND_URL || '*';

const handler = createHandler({
  file: process.env.DATABASE_FILE || fileURLToPath(new URL('../data/demo.json', import.meta.url)),
  config: {
    ...process.env,
    APP_URL: process.env.APP_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'localhost'}`,
    ENABLE_OUTBOX_WORKER: process.env.ENABLE_OUTBOX_WORKER ?? 'true',
  },
});

const server = createServer((req, res) => {
  // ── CORS ──────────────────────────────────────────────────────────
  const origin = req.headers.origin;
  const allowed = allowedOrigin === '*'
    ? origin || '*'
    : allowedOrigin;

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
  if (origin && process.env.FRONTEND_URL) {
    try {
      const frontendHost = new URL(process.env.FRONTEND_URL).host;
      const originHost = new URL(origin).host;
      if (originHost === frontendHost) {
        // Trust the frontend — let the handler's own check pass
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
  console.log(`Continuum API: http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close();
  setTimeout(() => process.exit(0), 1500).unref();
});
server.requestTimeout = 60000;
