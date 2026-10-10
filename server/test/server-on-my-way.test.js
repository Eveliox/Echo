import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, attachLadder } from '../server.js';
import { createTracker } from '../status.js';
import { createHistory } from '../history.js';
import { createActionLog } from '../actions.js';
import { readConfig } from '../calls.js';
import { createFakeClock } from './fake-clock.js';

async function setup(t) {
  const clock = createFakeClock();
  const tracker = createTracker({ now: clock.now });
  const history = createHistory({ now: clock.now });
  const actions = createActionLog({ now: clock.now });
  const calls = [];
  const ladder = attachLadder(tracker, { config: readConfig({ CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002' }), actions, timers: clock.timers, now: clock.now, log: () => calls.push(clock.now()), logError: () => {} });
  const server = createServer({ tracker, history, actions, now: clock.now });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const post = async (path, body = '') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', body });
    await response.arrayBuffer(); return response.status;
  };
  return { clock, tracker, history, actions, ladder, calls, post, server };
}
test('on-my-way is fixed log only: status, incident and ladder schedule stay unchanged', async t => {
  const s = await setup(t);
  const status = { state: 'EMERGENCY', tempF: 104, humidity: 40, presence: true, distanceCm: 30, motion: null, minsToDanger: 0, battery: null };
  assert.equal(await s.post('/status', JSON.stringify(status)), 200);
  const before = { status: s.tracker.snapshot(), incident: s.ladder.incident(), history: s.history.entries(), pending: s.clock.pending() };
  const t0 = s.clock.now();
  assert.equal(await s.post('/on-my-way', '{"state":"IDLE","phone":"SECRET","reason":"cancel"}'), 200);
  assert.deepEqual({ status: s.tracker.snapshot(), incident: s.ladder.incident(), history: s.history.entries(), pending: s.clock.pending() }, before);
  assert.equal(s.ladder.inIncident(), true);
  assert.deepEqual(s.actions.entries().at(-1), { time: new Date(t0).toISOString(), action: 'note', to: 'App', reason: "I'm on my way; alarm and backup calls continue." });
  await s.clock.advance(300000);
  assert.deepEqual(s.calls.map(time => time - t0), [0, 120000, 180000, 300000, 300000]);
  assert.equal(s.ladder.inIncident(), true);
});
test('body cap, global cooldown and method restrictions cannot flood or inject the action log', async t => {
  const s = await setup(t);
  assert.equal(await s.post('/on-my-way', 'x'.repeat(4097)), 413);
  assert.equal(s.actions.entries().length, 0);
  assert.equal(await s.post('/on-my-way', 'not even JSON'), 200);
  for (let i = 0; i < 5; i++) assert.equal(await s.post('/on-my-way'), 429);
  assert.equal(s.actions.entries().length, 1);
  await s.clock.advance(60000);
  assert.equal(await s.post('/on-my-way'), 200);
  const response = await fetch(`http://127.0.0.1:${s.server.address().port}/on-my-way`);
  assert.equal(response.status, 405); await response.arrayBuffer();
  assert.equal(s.actions.entries().length, 2);
});

test('chunked bodies also enforce the cap without storing their contents', async t => {
  const s = await setup(t);
  const response = await fetch(`http://127.0.0.1:${s.server.address().port}/on-my-way`, {
    method: 'POST', duplex: 'half',
    body: (async function* () { yield 'x'.repeat(2048); yield 'y'.repeat(2049); })(),
  });
  assert.equal(response.status, 413); await response.arrayBuffer();
  assert.equal(s.actions.entries().length, 0);
  assert.equal(await s.post('/on-my-way'), 200, 'rejected upload did not consume the note cooldown');
});
