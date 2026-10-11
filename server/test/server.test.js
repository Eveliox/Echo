import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, listenPort, PORT } from '../server.js';
import { createTracker, OFFLINE_AFTER_MS } from '../status.js';

let t = 0;
const tracker = createTracker({ now: () => t });
const server = createServer({ tracker });
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/status`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const status = (overrides = {}) => ({
  state: 'OCCUPANT', tempF: 88.2, presence: true, distanceCm: 30,
  motion: null, minsToDanger: null, battery: null, ...overrides,
});

const post = (body) => fetch(base, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const get = async () => (await fetch(base)).json();

// Tests share one server and run in order.

test('GET before any status reports offline with no status', async () => {
  assert.deepEqual(await get(), { online: false, lastSeen: null, status: null });
});

test('POST /status keeps the latest valid status', async () => {
  t = 1_000;
  let res = await post(status());
  assert.equal(res.status, 200);
  t = 3_000;
  res = await post(status({ state: 'WARNING', tempF: 96.4, minsToDanger: 7.5 }));
  assert.equal(res.status, 200);
  assert.deepEqual(await get(), {
    online: true, lastSeen: 3_000,
    status: status({ state: 'WARNING', tempF: 96.4, minsToDanger: 7.5 }),
  });
});

test('POST /status accepts the old firmware line with humidity and the new one without', async () => {
  const before = await get();
  const oldLine = '{"state":"OCCUPANT","tempF":88.2,"humidity":41,"presence":true,"distanceCm":30,"motion":null,"minsToDanger":null,"battery":null}';
  const newLine = '{"state":"OCCUPANT","tempF":88.2,"presence":true,"distanceCm":30,"motion":null,"minsToDanger":null,"battery":null}';
  assert.equal((await post(oldLine)).status, 200);
  assert.equal((await get()).online, true);
  assert.equal((await post(newLine)).status, 200);
  assert.deepEqual(await get(), { online: true, lastSeen: before.lastSeen, status: JSON.parse(newLine) });
  assert.equal((await post(before.status)).status, 200); // restore for the tests below
});

test('invalid bodies get a 4xx and do not replace the latest status', async () => {
  const before = await get();
  const bad = [
    'not json',
    '{"state":"WARNING"',
    '',
    '[]',
    status({ state: 'PANIC' }),
    status({ tempF: 'hot' }),
    (({ tempF, ...rest }) => rest)(status()),
    'x'.repeat(10_000),
  ];
  for (const body of bad) {
    const res = await post(body);
    assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
    await res.body?.cancel();
  }
  assert.deepEqual(await get(), before);
});

test('box goes offline after the silence window and back online on the next status', async () => {
  t = 3_000 + OFFLINE_AFTER_MS;
  const offline = await get();
  assert.equal(offline.online, false);
  assert.equal(offline.status.state, 'WARNING');

  const res = await post(status({ state: 'EMERGENCY', tempF: 104.5, minsToDanger: 0 }));
  assert.equal(res.status, 200);
  const back = await get();
  assert.equal(back.online, true);
  assert.equal(back.status.state, 'EMERGENCY');
});

test('the box posts to port 3000 (importing server.js does not listen)', () => {
  assert.equal(PORT, 3000);
});

test('ECHO_PORT overrides the port; unset or empty keeps 3000; a bad value throws', () => {
  assert.equal(listenPort({}), 3000);
  assert.equal(listenPort({ ECHO_PORT: '' }), 3000);
  assert.equal(listenPort({ ECHO_PORT: '4123' }), 4123);
  for (const bad of ['abc', '0', '65536', '-1', '3000.5', ' 3001', '0x10']) {
    assert.throws(() => listenPort({ ECHO_PORT: bad }), /ECHO_PORT/, bad);
  }
});

test('unknown paths are 404', async () => {
  const res = await fetch(base.replace('/status', '/nope'));
  assert.equal(res.status, 404);
  await res.body?.cancel();
});
