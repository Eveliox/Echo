// The read-only dashboard page: GET / plus its script and style, served from a
// fixed allow-list of files in server/dashboard/. No other path reaches the
// disk, so there is no directory listing or path traversal.

import { readFile } from 'node:fs/promises';

const DIR = new URL('./dashboard/', import.meta.url);

export const DASHBOARD_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/view.js', { file: 'view.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

// Same-origin script, style, and fetch only; no inline code, forms, or framing.
export const DASHBOARD_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': DASHBOARD_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export const isDashboardPath = (path) => DASHBOARD_FILES.has(path);

// Answers a request for one of DASHBOARD_FILES. Never throws.
export async function serveDashboard(req, res, path, { logError = console.error } = {}) {
  const entry = DASHBOARD_FILES.get(path);
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET', ...SECURITY_HEADERS });
    return res.end(JSON.stringify({ error: 'method not allowed' }));
  }
  let body;
  try {
    body = await readFile(new URL(entry.file, DIR));
  } catch (err) {
    logError(`dashboard: could not read ${entry.file}:`, err?.message ?? err);
    res.writeHead(500, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
    return res.end(JSON.stringify({ error: 'dashboard unavailable' }));
  }
  res.writeHead(200, { 'Content-Type': entry.type, ...SECURITY_HEADERS });
  res.end(body);
}
