import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, attachLadder } from '../server.js';
import { createTracker } from '../status.js';
import { readConfig } from '../calls.js';
import { createActionLog } from '../actions.js';
import { STEP2_AFTER_MS, STEP3_AFTER_MS, STEP4_AFTER_MS } from '../ladder.js';
import { createFakeClock } from './fake-clock.js';

const env = {
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001',
  CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002',
};
const numbers = ['+15550000000', '+15550000001', '+15550000002', 'AC123', 'tok'];

const status = (state) => ({
  state, tempF: 104.5, presence: true, distanceCm: 30,
  minsToDanger: 0,
});

// A live server (fake dialer), a not-live one, and a live one whose every
// dial fails, all on a fake clock.
function setup(config, { fail = false } = {}) {
  const clock = createFakeClock();
  const dialed = [];
  const errors = [];
  const tracker = createTracker({ now: clock.now, logError: () => {} });
  const actions = createActionLog({ now: clock.now });
  attachLadder(tracker, {
    config,
    dial: async (args) => {
      dialed.push({ ...args, at: clock.now() });
      if (fail) throw new Error('Twilio answered 500');
      return { sid: `CA${dialed.length}` };
    },
    log: () => {},
    logError: (...a) => errors.push(a.join(' ')),
    actions,
    timers: clock.timers,
  });
  return { server: createServer({ tracker, actions }), tracker, clock, dialed, errors };
}

const live = setup(readConfig({ ...env, ECHO_CALLS: 'live' }));
const off = setup(readConfig({ ...env }));
const failing = setup(readConfig({ ...env, ECHO_CALLS: 'live' }), { fail: true });
const servers = [live, off, failing];

before(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.server.listen(0, '127.0.0.1', resolve);
}))));
after(() => Promise.all(servers.map((s) => new Promise((resolve) => {
  s.server.close(resolve);
  s.server.closeAllConnections();
}))));

const url = (s, path) => `http://127.0.0.1:${s.server.address().port}${path}`;
const post = async (s, body, path = '/status') => {
  const res = await fetch(url(s, path), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await res.body?.cancel();
  return res.status;
};
const getActions = async (s) => {
  const res = await fetch(url(s, '/actions'));
  assert.equal(res.status, 200);
  return { text: await res.clone().text(), body: await res.json() };
};

test('live: steps 2-4 dial on time through invalid bodies and box silence; GET /actions logs them by name', async () => {
  const t0 = live.clock.now();
  assert.equal(await post(live, status('EMERGENCY')), 200);
  // Invalid bodies (4xx) never reach the ladder, so they can't stop it.
  assert.equal(await post(live, 'not json'), 400);
  assert.equal(await post(live, { ...status('ARMED'), tempF: 'hot' }), 400);
  assert.equal(await post(live, { state: 'IDLE' }), 400);
  await live.clock.advance(STEP4_AFTER_MS);
  assert.equal(live.tracker.isOnline(), false, 'the box has gone silent');
  assert.deepEqual(live.dialed.map((d) => [d.to, d.at - t0]), [
    ['+15550000001', 0],
    ['+15550000001', STEP2_AFTER_MS],
    ['+15550000002', STEP3_AFTER_MS],
    ['+15550000001', STEP4_AFTER_MS],
    ['+15550000002', STEP4_AFTER_MS],
  ]);
  const { text, body } = await getActions(live);
  assert.deepEqual(body.entries.map((e) => [e.action, e.to]), [
    ['call', 'Mom'], ['call', 'Mom'], ['call', 'Alex'], ['call', 'Mom'], ['call', 'Alex'],
  ]);
  for (const e of body.entries) assert.deepEqual(Object.keys(e), ['time', 'action', 'to', 'reason']);
  for (const v of numbers) assert.ok(!text.includes(v), `GET /actions leaks ${v}`);
});

test('live: a valid non-EMERGENCY status stops the schedule', async () => {
  assert.equal(await post(live, status('IDLE')), 200); // ends the previous test's incident
  const before = live.dialed.length;
  assert.equal(await post(live, status('EMERGENCY')), 200);
  await live.clock.advance(STEP2_AFTER_MS);
  assert.equal(live.dialed.length, before + 2);
  assert.equal(await post(live, status('ARMED')), 200);
  await live.clock.advance(60 * 60_000);
  assert.equal(live.dialed.length, before + 2);
  assert.equal(live.clock.pending(), 0);
});

test('/actions is GET only', async () => {
  assert.equal(await post(live, { action: 'call', to: 'x', reason: 'y' }, '/actions'), 405);
  const res = await fetch(url(live, '/actions'), { method: 'DELETE' });
  await res.body?.cancel();
  assert.equal(res.status, 405);
});

test('ECHO_CALLS unset: the whole ladder is only logged, and /actions says it was not dialed', async () => {
  assert.equal(await post(off, status('EMERGENCY')), 200);
  await off.clock.advance(STEP4_AFTER_MS);
  assert.equal(off.dialed.length, 0);
  const { text, body } = await getActions(off);
  assert.equal(body.entries.length, 5);
  for (const e of body.entries) assert.match(e.reason, /not live: ECHO_CALLS is not "live".*not dialed/);
  for (const v of numbers) assert.ok(!text.includes(v), `GET /actions leaks ${v}`);
});

test('failing live calls with EMERGENCY every 2 s for 10 minutes: steps 2-4 stay in /actions, step-1 noise is bounded', async () => {
  const { clock } = failing;
  for (let t = 0; t < 10 * 60_000; t += 2_000) {
    assert.equal(await post(failing, status('EMERGENCY')), 200);
    await clock.advance(2_000);
  }
  const momDials = failing.dialed.filter((d) => d.to === '+15550000001').length;
  assert.ok(momDials >= 300, `the status-driven step-1 retry still dials on every status (${momDials})`);
  const { body } = await getActions(failing);
  const reasons = body.entries.map((e) => `${e.to} ${e.reason}`);
  for (const [to, step] of [['Mom', 2], ['Alex', 3], ['Mom', 4], ['Alex', 4]]) {
    assert.ok(reasons.some((r) => r.startsWith(`${to} ladder step ${step}:`)), `step ${step} for ${to} is still in /actions`);
  }
  const step1 = body.entries.filter((e) => e.reason.startsWith('ladder step 1:'));
  assert.ok(step1.length >= 2 && step1.length <= 7, `step-1 failures in /actions: ${step1.length}`);
  assert.ok(step1.every((e) => e.action === 'call_failed'));
  assert.ok(step1.some((e) => /not logged again/.test(e.reason)), 'says further status-retry failures are quiet');
  const consoleStep1 = failing.errors.filter((m) => /ladder step 1 failed/.test(m)).length;
  assert.ok(consoleStep1 >= 2 && consoleStep1 <= 7, `step-1 failures on the console: ${consoleStep1}`);
});
