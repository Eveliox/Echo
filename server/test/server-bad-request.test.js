// A malformed request or an unexpected error in the handler must never take
// the server (and with it the backup ladder) down.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from '../server.js';
import { createTracker } from '../status.js';

// Without the guards the server never answers, so fail fast instead of hanging.
const TIMEOUT_MS = 5000;

const errors = [];
const server = createServer({ logError: (...a) => errors.push(a.join(' ')) });
let port;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

// Sends `target` as written over a raw socket; resolves with the status code.
const raw = (method, target, p = port) => new Promise((resolve, reject) => {
  const sock = net.connect(p, '127.0.0.1');
  let data = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { data += d; });
  sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
  sock.on('error', reject);
  sock.setTimeout(2000, () => { sock.destroy(); reject(new Error(`no answer to ${method} ${target}`)); });
  sock.write(`${method} ${target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
});

const status = (overrides = {}) => ({
  state: 'OCCUPANT', tempF: 88.2, humidity: 40, presence: true, distanceCm: 30,
  motion: null, minsToDanger: null, battery: null, ...overrides,
});

const base = (p = port) => `http://127.0.0.1:${p}`;
// A fetch that gives up after 2 s, so an unanswered request fails the test.
const quick = (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(2000) });

test('malformed request targets get a 4xx and the server keeps working', { timeout: TIMEOUT_MS }, async () => {
  for (const target of ['//[', 'http://[', '/%zz', '//[/status', 'http://[::1', '//%']) {
    for (const method of ['GET', 'POST']) {
      const code = await raw(method, target);
      assert.ok(code >= 400 && code < 500, `${method} ${target}: expected 4xx, got ${code}`);
    }
  }

  let res = await fetch(`${base()}/status`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, null);

  res = await fetch(`${base()}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status()),
  });
  assert.equal(res.status, 200);
  await res.body?.cancel();
  res = await fetch(`${base()}/status`);
  assert.deepEqual((await res.json()).status, status());
  assert.deepEqual(errors, [], 'a bad target is a 400, not an internal error');
});

test('an unexpected throw in the handler answers 500, is logged, and the server stays up', { timeout: TIMEOUT_MS }, async () => {
  const logged = [];
  let explode = true;
  const tracker = createTracker({ logError: () => {} });
  const real = { snapshot: tracker.snapshot.bind(tracker), update: tracker.update.bind(tracker) };
  tracker.snapshot = () => { if (explode) throw new Error('snapshot broke'); return real.snapshot(); };
  tracker.update = (s) => { if (explode) throw new Error('update broke'); return real.update(s); };
  const broken = createServer({ tracker, logError: (...a) => logged.push(a.join(' ')) });
  await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve));
  const p = broken.address().port;
  try {
    let res = await quick(`${base(p)}/status`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });

    res = await quick(`${base(p)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status()),
    });
    assert.equal(res.status, 500, 'a throw after the body is read is caught too');
    await res.body?.cancel();
    assert.equal(logged.length, 2);
    assert.match(logged[0], /snapshot broke/);
    assert.match(logged[1], /update broke/);

    explode = false;
    res = await quick(`${base(p)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status()),
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
    res = await quick(`${base(p)}/status`);
    assert.deepEqual((await res.json()).status, status());
  } finally {
    await new Promise((resolve) => { broken.close(resolve); broken.closeAllConnections(); });
  }
});
