import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, attachLadder } from '../server.js';
import { createTracker } from '../status.js';
import { readConfig } from '../calls.js';

const env = {
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001',
};

const status = (state) => ({
  state, tempF: 104.5, humidity: 40, presence: true, distanceCm: 30,
  motion: null, minsToDanger: 0, battery: null,
});

// Two servers: one live with a fake dialer, one with ECHO_CALLS unset.
// The fake dialer fails its first attempt and succeeds after. It, and a
// listener that throws, must not break either server.
function setup(config) {
  const dialed = [];
  const logs = [];
  const errors = [];
  const tracker = createTracker({ logError: (...a) => errors.push(a) });
  tracker.onStatus(() => { throw new Error('a broken listener'); });
  attachLadder(tracker, {
    config,
    dial: async (args) => {
      dialed.push(args);
      if (dialed.length === 1) throw new Error('Twilio down');
      return { sid: `CA${dialed.length}` };
    },
    log: (m) => logs.push(m),
    logError: (m) => errors.push([m]),
  });
  return { server: createServer({ tracker }), dialed, logs, errors };
}

const live = setup(readConfig({ ...env, ECHO_CALLS: 'live' }));
const off = setup(readConfig({ ...env }));

before(() => Promise.all([live, off].map((s) => new Promise((resolve) => {
  s.server.listen(0, '127.0.0.1', resolve);
}))));
// closeAllConnections so a crashed request fails the run instead of hanging it.
after(() => Promise.all([live, off].map((s) => new Promise((resolve) => {
  s.server.close(resolve);
  s.server.closeAllConnections();
}))));

const post = async (s, body) => {
  const res = await fetch(`http://127.0.0.1:${s.server.address().port}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  await res.body?.cancel();
  return res.status;
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('live: a failed dial is logged and retried on the next EMERGENCY, then no more calls this incident', async () => {
  for (const state of ['OCCUPANT', 'WARNING', 'EMERGENCY']) {
    assert.equal(await post(live, status(state)), 200);
  }
  await tick();
  assert.equal(live.dialed.length, 1);
  assert.equal(live.dialed[0].to, '+15550000001');
  assert.ok(live.errors.some(([m]) => /failed: Twilio down/.test(m)), 'failed dial is logged');

  for (let i = 0; i < 3; i++) {
    assert.equal(await post(live, status('EMERGENCY')), 200);
    await tick();
  }
  assert.equal(live.dialed.length, 2, 'one retry, then placed; no more step-1 calls');

  assert.equal(await post(live, status('ARMED')), 200); // cancel ends the incident
  assert.equal(await post(live, status('EMERGENCY')), 200); // new incident
  await tick();
  assert.equal(live.dialed.length, 3);
});

test('ECHO_CALLS unset: posted EMERGENCY is only logged, never dialed', async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(await post(off, status('EMERGENCY')), 200);
    await tick();
  }
  assert.equal(off.dialed.length, 0);
  assert.equal(off.logs.filter((m) => /would call Mom/.test(m)).length, 1);
});
