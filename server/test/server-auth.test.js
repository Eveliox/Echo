// POST /status with ECHO_BOX_TOKEN set: no exact X-Echo-Token, no effect.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { createTracker } from '../status.js';
import { createHistory } from '../history.js';
import { createRejectionLog } from '../auth.js';
import { createFakeClock } from './fake-clock.js';

const TOKEN = 'box-token-7f3a9c';
const WRONG = 'wrong-token-value-1234';

const status = (overrides = {}) => ({
  state: 'OCCUPANT', tempF: 88.2, presence: true, distanceCm: 30,
  minsToDanger: null, ...overrides,
});

// A server with spies on everything a status reaches.
function setup(boxToken) {
  const clock = createFakeClock();
  const seen = { listener: [], log: [], errors: [] };
  const tracker = createTracker({ now: clock.now });
  tracker.onStatus((s) => seen.listener.push(s)); // where the ladder listens
  const history = createHistory({ now: clock.now });
  const statusLog = { write: (...a) => seen.log.push(a) };
  const logError = (...a) => seen.errors.push(a.join(' '));
  const rejections = createRejectionLog({ log: logError, now: clock.now, timers: clock.timers });
  const server = createServer({ tracker, history, statusLog, logError, boxToken, rejections });
  return { server, tracker, history, seen, rejections };
}

const on = setup(TOKEN);
const off = setup('');

before(() => Promise.all([on, off].map((s) => new Promise((resolve) => {
  s.server.listen(0, '127.0.0.1', resolve);
}))));
after(() => Promise.all([on, off].map((s) => new Promise((resolve) => {
  s.server.close(resolve);
  s.server.closeAllConnections();
}))));

const url = (s) => `http://127.0.0.1:${s.server.address().port}/status`;
const post = async (s, body, headers = {}) => {
  const res = await fetch(url(s), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  return { code: res.status, body: await res.json() };
};
const get = async (s) => (await fetch(url(s))).json();

test('token on: missing, wrong, or different-length header gets 401 and reaches nothing', async () => {
  const bad = [
    {}, { 'X-Echo-Token': WRONG }, { 'X-Echo-Token': TOKEN.slice(0, -1) }, { 'X-Echo-Token': `${TOKEN}x` },
    { 'X-Echo-Token': 'x' }, { 'X-Echo-Token': TOKEN.toUpperCase() }, { 'X-Other-Token': TOKEN },
  ];
  for (const headers of bad) {
    // Even an EMERGENCY, or a body that would fail validation, is turned away unread.
    for (const body of [status({ state: 'EMERGENCY', tempF: 104.5, minsToDanger: 0 }), 'not json', 'x'.repeat(10_000)]) {
      const res = await post(on, body, headers);
      assert.equal(res.code, 401, JSON.stringify(headers));
      assert.deepEqual(res.body, { error: 'unauthorized' });
    }
  }
  assert.deepEqual(await get(on), { online: false, lastSeen: null, status: null });
  assert.deepEqual(on.seen.listener, [], 'the ladder never heard of them');
  assert.deepEqual(on.history.entries(), []);
  assert.deepEqual(on.seen.log, []);
  assert.equal(on.rejections.total(), bad.length * 3);
});

test('token on: rejections are logged with a count, never the token or the sent value', () => {
  assert.ok(on.seen.errors.length >= 1);
  assert.match(on.seen.errors[0], /^rejected \d+ status posts: bad or missing token$/);
  for (const line of on.seen.errors) {
    assert.ok(!line.includes(TOKEN), line);
    assert.ok(!line.includes(WRONG), line);
    assert.ok(!/box-token/i.test(line), line);
  }
});

test('token on: the exact header is accepted (any header-name case) and feeds everything', async () => {
  const s = status({ state: 'WARNING', tempF: 96.4, minsToDanger: 7.5 });
  assert.equal((await post(on, s, { 'X-Echo-Token': TOKEN })).code, 200);
  assert.equal((await post(on, s, { 'x-echo-token': TOKEN })).code, 200);
  assert.deepEqual((await get(on)).status, s);
  assert.equal(on.seen.listener.length, 2);
  assert.equal(on.history.entries().length, 2);
  assert.equal(on.seen.log.length, 2);
  // Validation still applies after auth.
  assert.equal((await post(on, 'not json', { 'X-Echo-Token': TOKEN })).code, 400);
});

test('token on: GET routes need no token', async () => {
  for (const path of ['/status', '/history', '/actions']) {
    const res = await fetch(url(on).replace('/status', path));
    assert.equal(res.status, 200, path);
    assert.ok(!(await res.text()).includes(TOKEN), `${path} never serves the token`);
  }
});

test('token off: posts are accepted with or without a header, as before', async () => {
  assert.equal((await post(off, status())).code, 200);
  assert.equal((await post(off, status({ state: 'ARMED' }), { 'X-Echo-Token': WRONG })).code, 200);
  assert.equal((await get(off)).status.state, 'ARMED');
  assert.equal(off.seen.listener.length, 2);
  assert.equal(off.rejections.total(), 0);
  assert.deepEqual(off.seen.errors, []);
});
