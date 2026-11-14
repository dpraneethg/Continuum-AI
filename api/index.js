// Vercel Serverless Function — serves HTML pages with meta injection and proxies API to Render.
import { readFile } from 'node:fs/promises';

const pageMeta = {
  '/': ['Continuum — Support that remembers what works', 'Fixes your customers confirm and your team reviews become trusted answers for the next customer. Company-private, clearly labelled and safe by default.'],
  '/services': ['Product — Continuum', 'One calm workspace for every support request: the conversation, the customer\'s context and every answer labelled with where it came from.'],
  '/about': ['How it works — Continuum', 'A customer reports a problem, a specialist solves it, the customer confirms, and the next customer with the same problem gets the verified fix.'],
  '/pricing': ['Pricing — Continuum', 'Simple per-seat plans for support teams of every size. Request access and we will set up your workspace with you.'],
  '/book-a-session': ['Book a call — Continuum', 'Choose a time for a 30-minute walkthrough of Continuum with your own support scenarios.'],
  '/demo': ['Interactive demo — Continuum', 'Watch one customer\'s confirmed fix become the answer for the next customer, in a two-minute interactive walkthrough.'],
  '/privacy': ['Privacy — Continuum', 'What Continuum stores, why, how personal details are removed before anything is reused, and how to ask for your data.'],
  '/terms': ['Terms — Continuum', 'The terms that apply to using Continuum during early access.'],
  '/security': ['Security — Continuum', 'How Continuum keeps each company\'s knowledge separate, protects accounts and handles secrets.'],
};
const privatePaths = new Set(['/desk', '/team', '/operator', '/style-guide']);
const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const htmlRoutes = new Set([
  '/', '/about', '/services', '/pricing', '/book-a-session', '/style-guide',
  '/team', '/operator', '/desk', '/demo', '/privacy', '/terms', '/security',
]);

let indexHtml, demoHtml;
async function loadHtml(name) {
  return (await readFile(new URL('../web/' + name, import.meta.url))).toString();
}

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const origin = process.env.APP_URL || `https://${process.env.VERCEL_URL || 'localhost'}`;

  // ── Proxy API requests to Render backend ───────────────────────
  if (path.startsWith('/api/')) {
    const backend = (process.env.RENDER_BACKEND_URL || '').replace(/\/+$/, '');
    if (!backend) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        error: 'Backend is being configured. Please set RENDER_BACKEND_URL on Vercel.',
        status: 'PENDING_CONFIG'
      }));
    }
    try {
      const targetUrl = backend + url.pathname + url.search;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (lower === 'host' || lower === 'accept-encoding') continue;
        headers[k] = v;
      }
      headers.host = new URL(backend).host;

      let bodyData;
      if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (chunks.length > 0) bodyData = Buffer.concat(chunks);
      }

      const upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: bodyData,
        redirect: 'manual',
        signal: AbortSignal.timeout(58000),
      });

      res.statusCode = upstream.status;
      for (const [k, v] of upstream.headers) {
        const lower = k.toLowerCase();
        if (['transfer-encoding', 'content-encoding', 'content-length'].includes(lower)) continue;
        res.setHeader(k, v);
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Length', String(buf.length));
      return res.end(buf);
    } catch (err) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'Failed to contact Render backend.', details: err.message }));
    }
  }

  // ── SEO & Bot routes ───────────────────────────────────────────
  if (path === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end(['User-agent: *', 'Disallow: /desk', 'Disallow: /team', 'Disallow: /operator', 'Disallow: /api/', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n'));
  }
  if (path === '/sitemap.xml') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.end(['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...Object.keys(pageMeta).map((p) => `  <url><loc>${escapeAttr(origin + p)}</loc></url>`), '</urlset>', ''].join('\n'));
  }

  // ── HTML page routes ───────────────────────────────────────────
  if (htmlRoutes.has(path)) {
    const templateName = path === '/demo' ? 'demo.html' : 'index.html';
    if (templateName === 'demo.html') {
      demoHtml ??= await loadHtml('demo.html');
    } else {
      indexHtml ??= await loadHtml('index.html');
    }
    let html = templateName === 'demo.html' ? demoHtml : indexHtml;
    const [title, description] = pageMeta[path] || ['Your workspace — Continuum', 'Sign in to your Continuum support workspace.'];
    html = html
      .replaceAll('%TITLE%', escapeAttr(title))
      .replaceAll('%DESCRIPTION%', escapeAttr(description))
      .replaceAll('%URL%', escapeAttr(origin + path))
      .replaceAll('%ORIGIN%', escapeAttr(origin));
    if (privatePaths.has(path) || !pageMeta[path]) {
      html = html.replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.end(html);
  }

  // Fallback
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Not found');
}
