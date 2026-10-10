// The dashboard's fonts and logo (#25): served from the fixed asset allow-list
// with their content type and the page's headers, GET only, nothing else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createServer } from '../server.js';
import { DASHBOARD_ASSETS, DASHBOARD_CSP, DASHBOARD_FILES } from '../dashboard.js';

const server = createServer();
let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

// Raw request so the path reaches the server exactly as written.
const request = (method, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end();
});

const asset = (file) => readFileSync(new URL(`../dashboard/${file}`, import.meta.url));

const EXPECTED = {
  '/dashboard/fonts/Doto.ttf': 'font/ttf',
  '/dashboard/fonts/manrope.ttf': 'font/ttf',
  '/dashboard/fonts/outfit.ttf': 'font/ttf',
  '/dashboard/echo-logo.png': 'image/png',
};

test('the asset allow-list is exactly the three app fonts and the logo', () => {
  assert.deepEqual([...DASHBOARD_ASSETS.keys()].sort(), Object.keys(EXPECTED).sort());
  for (const path of DASHBOARD_ASSETS.keys()) assert.ok(!DASHBOARD_FILES.has(path), path);
});

test('fonts and logo are served byte for byte with their content type and the page headers', async () => {
  for (const [path, type] of Object.entries(EXPECTED)) {
    const res = await request('GET', path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-security-policy'], DASHBOARD_CSP, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.ok(res.body.equals(asset(DASHBOARD_ASSETS.get(path).file)), `${path} body`);
  }
  // Real files, not placeholders: TrueType and PNG signatures.
  assert.equal(asset('fonts/Doto.ttf').readUInt32BE(0), 0x00010000);
  assert.equal(asset('echo-logo.png').subarray(1, 4).toString('latin1'), 'PNG');
});

test('the served fonts and logo are the app\'s own files', () => {
  const app = (file) => readFileSync(new URL(`../../app/assets/${file}`, import.meta.url));
  assert.ok(asset('fonts/Doto.ttf').equals(app('fonts/Doto.ttf')));
  assert.ok(asset('fonts/manrope.ttf').equals(app('fonts/manrope.ttf')));
  assert.ok(asset('fonts/outfit.ttf').equals(app('fonts/outfit.ttf')));
  assert.ok(asset('echo-logo.png').equals(app('echo-logo.png')));
});

test('fonts and logo only answer GET: POST, PUT, PATCH, DELETE are 405', async () => {
  for (const path of DASHBOARD_ASSETS.keys()) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(method, path);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, 'GET');
    }
  }
});

test('nothing outside the asset allow-list is served: licenses, other names, traversal', async () => {
  const paths = [
    '/dashboard/fonts', '/dashboard/fonts/', '/dashboard/fonts/doto-OFL.txt',
    '/dashboard/fonts/manrope-OFL.txt', '/dashboard/fonts/outfit-OFL.txt',
    '/dashboard/fonts/doto.ttf', '/dashboard/fonts/Doto.TTF', '/dashboard/fonts/Doto.ttf/',
    '/fonts/Doto.ttf', '/echo-logo.png', '/dashboard/fonts/echo-logo.png',
    '/dashboard/fonts/../../dashboard.js', '/dashboard/fonts/..%2f..%2fserver.js',
    '/dashboard/../app/assets/echo-logo.png', '/app/assets/echo-logo.png',
    '/dashboard/fonts/../../../app/assets/fonts/Doto.ttf',
  ];
  for (const path of paths) {
    const res = await request('GET', path);
    assert.equal(res.status, 404, path);
  }
  // The server resolves ".." (and "%2e%2e") before routing, so these are the
  // allow-listed logo, nothing else.
  for (const path of ['/dashboard/fonts/../echo-logo.png', '/dashboard/fonts/%2e%2e/echo-logo.png']) {
    const res = await request('GET', path);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.equals(asset('echo-logo.png')), path);
  }
});

test('CSP adds only same-origin fonts and images', () => {
  const parts = DASHBOARD_CSP.split('; ');
  assert.ok(parts.includes("font-src 'self'"));
  assert.ok(parts.includes("img-src 'self'"));
  assert.ok(parts.includes("default-src 'none'"));
  assert.ok(!/unsafe|\*|https?:|data:/.test(DASHBOARD_CSP));
});

test('style.css loads the fonts and logo from the allow-list only', () => {
  const css = readFileSync(new URL('../dashboard/style.css', import.meta.url), 'utf8');
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(urls.sort(), Object.keys(EXPECTED).sort());
  assert.ok(!/@import|https?:\/\//.test(css), 'no remote CSS or fonts');
  // Doto renders at 900, the weight of the app's Doto file (Doto Black).
  assert.match(css, /@font-face\s*{[^}]*font-family:\s*"Doto";[^}]*font-weight:\s*900;/);
  assert.match(css, /\.big\s*{[^}]*font:\s*900\b[^}]*"Doto"/);
});
