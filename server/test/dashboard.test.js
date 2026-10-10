import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createServer } from '../server.js';
import { DASHBOARD_CSP, DASHBOARD_FILES } from '../dashboard.js';

const server = createServer();
let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

// Raw request so the path reaches the server exactly as written (fetch would
// normalize "..").
const request = (method, path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({
      status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  req.on('error', reject);
  req.end();
});

const source = (file) => readFileSync(new URL(`../dashboard/${file}`, import.meta.url), 'utf8');
const files = [...DASHBOARD_FILES.values()].map(({ file }) => ({ file, text: source(file) }));

test('GET / serves the page as text/html with a strict CSP and nosniff', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/html\b/);
  assert.equal(res.headers['content-security-policy'], DASHBOARD_CSP);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.body, source('index.html'));
  const csp = DASHBOARD_CSP;
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'",
    "connect-src 'self'", "form-action 'none'"]) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!/unsafe|\*|https?:|data:/.test(csp), 'CSP allows nothing beyond same origin');
});

test('page assets are served with their content type and the same headers', async () => {
  const expected = {
    '/dashboard/app.js': /^text\/javascript\b/,
    '/dashboard/view.js': /^text\/javascript\b/,
    '/dashboard/style.css': /^text\/css\b/,
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await request('GET', path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-security-policy'], DASHBOARD_CSP, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.equal(res.body, source(DASHBOARD_FILES.get(path).file), path);
  }
});

test('the page only answers GET: POST, PUT, PATCH, DELETE to it are 405', async () => {
  for (const path of DASHBOARD_FILES.keys()) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await request(method, path);
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, 'GET');
    }
  }
});

test('only the allow-listed files are served: no directories, no traversal', async () => {
  const paths = [
    '/dashboard', '/dashboard/', '/index.html', '/dashboard/index.html', '/server.js',
    '/dashboard/../server.js', '/dashboard/%2e%2e/server.js', '/dashboard/..%2fserver.js',
    '/dashboard/app.js/', '/dashboard/app.js/..', '/dashboard/APP.JS', '//etc/passwd',
    '/dashboard/../../package.json', '/dashboard/.env', '/.env', '/dashboard.js',
  ];
  for (const path of paths) {
    const res = await request('GET', path);
    assert.notEqual(res.status, 200, path);
    assert.ok(!res.body.includes('createServer') && !res.body.includes('import '), path);
  }
});

test('the API routes still answer as before next to the page', async () => {
  const res = await request('GET', '/status');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.deepEqual(JSON.parse(res.body), { online: false, lastSeen: null, status: null });
});

test('the page is read-only: no forms, buttons, or requests other than GET', () => {
  for (const { file, text } of files) {
    for (const bad of [/<form\b/i, /<button\b/i, /<input\b/i, /<textarea\b/i,
      /\b(POST|PUT|PATCH|DELETE)\b/i, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/]) {
      assert.ok(!bad.test(text), `${file} matches ${bad}`);
    }
    const methods = [...text.matchAll(/\bmethod\b\s*:\s*(['"`])(\w+)\1/g)].map((m) => m[2]);
    const mentions = text.match(/\bmethod\b/g) ?? [];
    assert.equal(mentions.length, methods.length, `${file}: every "method" is a literal`);
    assert.ok(methods.every((m) => m === 'GET'), `${file}: methods ${methods}`);
    const fetches = text.match(/\bfetch\s*\(/g) ?? [];
    const gets = text.match(/\bfetch\s*\([^)]*method\s*:\s*'GET'/g) ?? [];
    assert.equal(fetches.length, gets.length, `${file}: every fetch says method GET`);
  }
});

test('the page never writes data as HTML', () => {
  for (const { file, text } of files) {
    for (const bad of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/,
      /\beval\s*\(/, /new Function/]) {
      assert.ok(!bad.test(text), `${file} matches ${bad}`);
    }
  }
});

test('index.html loads only allow-listed same-origin files and has no inline code', () => {
  const html = source('index.html');
  assert.ok(!/https?:\/\//.test(html), 'no external URLs');
  assert.ok(!/<style\b/i.test(html), 'no inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'no style attributes');
  assert.ok(!/\son\w+\s*=/i.test(html), 'no inline event handlers');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1], /\bsrc="/, 'every script has a src');
    assert.equal(m[2].trim(), '', 'no inline script');
  }
  const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) assert.ok(DASHBOARD_FILES.has(ref), `${ref} is served`);
  for (const { file, text } of files.filter((f) => f.file.endsWith('.js'))) {
    for (const m of text.matchAll(/\bimport\b[^'"]*['"]([^'"]+)['"]/g)) {
      assert.ok(DASHBOARD_FILES.has(new URL(m[1], 'http://x/dashboard/').pathname), `${file} imports ${m[1]}`);
    }
  }
});
