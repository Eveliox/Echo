// The read-only dashboard page: GET / plus its script, style, fonts, and logo,
// served from fixed allow-lists of files in server/dashboard/. No other path
// reaches the disk, so there is no directory listing or path traversal.

import { readFile } from 'node:fs/promises';

const DIR = new URL('./dashboard/', import.meta.url);

export const DASHBOARD_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/dashboard/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/chart.js', { file: 'chart.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/cabin.js', { file: 'cabin.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/view.js', { file: 'view.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

// Binary assets: shared app fonts/logo plus the generated transparent car. Kept
// apart from DASHBOARD_FILES (page source) because they are not text. The
// fonts' OFL licenses sit next to them in dashboard/fonts/ and are not served.
export const DASHBOARD_ASSETS = new Map([
  ['/dashboard/assets/transparent-sedan.png', { file: 'assets/transparent-sedan.png', type: 'image/png' }],
  ['/dashboard/fonts/Doto.ttf', { file: 'fonts/Doto.ttf', type: 'font/ttf' }],
  ['/dashboard/fonts/manrope.ttf', { file: 'fonts/manrope.ttf', type: 'font/ttf' }],
  ['/dashboard/fonts/outfit.ttf', { file: 'fonts/outfit.ttf', type: 'font/ttf' }],
  ['/dashboard/echo-logo.png', { file: 'echo-logo.png', type: 'image/png' }],
]);

// Same-origin script, style, font, image, and fetch only; no inline code,
// forms, or framing.
export const DASHBOARD_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'",
  "img-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': DASHBOARD_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

export const isDashboardPath = (path) => DASHBOARD_FILES.has(path) || DASHBOARD_ASSETS.has(path);

// Answers a request for one of DASHBOARD_FILES or DASHBOARD_ASSETS. Never throws.
export async function serveDashboard(req, res, path, { logError = console.error } = {}) {
  const entry = DASHBOARD_FILES.get(path) ?? DASHBOARD_ASSETS.get(path);
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
