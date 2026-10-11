// The Responder can only add actions (ticket #18): wired as in server.js, the
// backup ladder's calls and log entries are identical with any agent attached,
// whether its model throws, hangs, answers nonsense, or calls contacts itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachLadder, attachResponder } from '../server.js';
import { createTracker } from '../status.js';
import { createActionLog } from '../actions.js';
import { readConfig } from '../calls.js';
import { STEP2_AFTER_MS, STEP3_AFTER_MS, STEP4_AFTER_MS } from '../ladder.js';
import { MAX_TURNS_PER_INCIDENT, MAX_REQUESTS_PER_WINDOW, MAX_CALLS_PER_CONTACT_PER_WINDOW } from '../responder.js';
import { ACTIONS_MAX_ENTRIES } from '../actions.js';
import { createFakeClock } from './fake-clock.js';

// Not live: every call is a "would call" log line, never dialed.
const config = readConfig({
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002',
});

const status = (state) => ({
  state, tempF: 104.5, presence: true, distanceCm: 30,
  minsToDanger: 2,
});

const LADDER_CALL = /^calls: \[not live\b[^\]]*\] would call (\w+) .* for emergency, ladder step (\d):/;
const AGENT_CALL = /^calls: \[not live\b[^\]]*\] would call (\w+) .* for emergency, agent turn \d+:/;
const RUN_MS = 6 * 60_000;

// One incident on a fake clock: EMERGENCY every 2 s for RUN_MS, with the
// ladder attached and, if `model` is given, the Responder too, as server.js does.
async function run(model) {
  const clock = createFakeClock();
  const start = clock.now();
  const lines = [];
  const errors = [];
  const log = (m) => lines.push({ at: clock.now() - start, m });
  const logError = (...a) => errors.push(a.join(' '));
  const tracker = createTracker({ now: clock.now, logError });
  const actions = createActionLog({ now: clock.now });
  const opts = { config, log, logError, actions, timers: clock.timers, now: clock.now };
  attachLadder(tracker, opts);
  const responder = attachResponder(tracker, { ...opts, model });
  assert.equal(responder === null, !model);
  for (let t = 0; t < RUN_MS; t += 2000) {
    tracker.update(status('EMERGENCY'));
    await clock.advance(2000);
  }
  const ladderCalls = lines.filter(({ m }) => LADDER_CALL.test(m)).map(({ at, m }) => {
    const [, who, step] = m.match(LADDER_CALL);
    return { at, who, step: Number(step) };
  });
  const agentCalls = lines.filter(({ m }) => AGENT_CALL.test(m)).length;
  const entries = actions.entries();
  const ladderEntries = entries.filter((e) => e.reason.startsWith('ladder step'));
  const agentEntries = entries.filter((e) => e.reason.startsWith('agent: '));
  return { ladderCalls, agentCalls, ladderEntries, agentEntries, entries, errors };
}

const fakeModels = {
  throws: () => { throw new Error('model crashed'); },
  rejects: () => Promise.reject(new Error('model down')),
  'hangs past its timeout': () => new Promise(() => {}),
  'returns a malformed tool call': () => ({ name: 'place_call', args: { contact: 'Mom' } }),
  'returns no tool call': () => null,
  'tries a tool that does not exist': () => ({ name: 'cancel_ladder', args: {} }),
  'calls the contact the ladder is about to call': () => ({ name: 'place_call', args: { contact: 'Mom', message: 'Go now.' } }),
  'calls the next contact early': () => ({ name: 'place_call', args: { contact: 'Alex', message: 'Go now.' } }),
  'spams notes': () => ({ name: 'log_action', args: { note: 'x'.repeat(200) } }),
};

test('without an agent the ladder calls at 0, 2, 3 and 5 minutes', async () => {
  const { ladderCalls, agentCalls, agentEntries } = await run(null);
  assert.deepEqual(ladderCalls, [
    { at: 0, who: 'Mom', step: 1 },
    { at: STEP2_AFTER_MS, who: 'Mom', step: 2 },
    { at: STEP3_AFTER_MS, who: 'Alex', step: 3 },
    { at: STEP4_AFTER_MS, who: 'Mom', step: 4 },
    { at: STEP4_AFTER_MS, who: 'Alex', step: 4 },
  ]);
  assert.equal(agentCalls, 0);
  assert.deepEqual(agentEntries, []);
});

for (const [name, model] of Object.entries(fakeModels)) {
  test(`with an agent whose model ${name}, the ladder's calls and entries match a run with no agent`, async () => {
    const baseline = await run(null);
    const withAgent = await run(model);
    assert.deepEqual(withAgent.ladderCalls, baseline.ladderCalls);
    assert.deepEqual(withAgent.ladderEntries, baseline.ladderEntries, 'same ladder entries at the same times');
    assert.ok(withAgent.entries.every((e) => e.reason.startsWith('ladder step') || e.reason.startsWith('agent: ')));
  });
}

test('an agent that calls only adds calls, capped per contact', async () => {
  const { agentCalls, agentEntries } = await run(fakeModels['calls the contact the ladder is about to call']);
  assert.equal(agentCalls, 2);
  assert.deepEqual(agentEntries.slice(0, 2).map((e) => [e.action, e.to]), [['call', 'Mom'], ['call', 'Mom']]);
  assert.ok(agentEntries.slice(2).every((e) => e.action === 'rejected'));
});

test('an agent writes at most one entry per turn, so it can\'t push an incident\'s ladder entries out of the log', async () => {
  const { agentEntries, ladderEntries } = await run(fakeModels['spams notes']);
  assert.equal(agentEntries.length, MAX_TURNS_PER_INCIDENT);
  assert.ok(MAX_TURNS_PER_INCIDENT + ladderEntries.length < ACTIONS_MAX_ENTRIES);
});

// Flapping: EMERGENCY and ARMED alternate every 2 s, so each EMERGENCY is a
// new incident for both the ladder and the agent.
async function runFlapping(model) {
  const clock = createFakeClock();
  const start = clock.now();
  const lines = [];
  const asked = [];
  const log = (m) => lines.push({ at: clock.now() - start, m });
  const logError = () => {};
  const tracker = createTracker({ now: clock.now, logError });
  // Flapping makes the ladder alone overflow the default cap, so compare in a
  // log big enough to keep every entry.
  const actions = createActionLog({ now: clock.now, maxEntries: 10_000 });
  const opts = { config, log, logError, actions, timers: clock.timers, now: clock.now };
  attachLadder(tracker, opts);
  if (model) attachResponder(tracker, { ...opts, model: (input) => { asked.push(clock.now()); return model(input); } });
  for (let t = 0; t < 20 * 60_000; t += 4000) {
    tracker.update(status('EMERGENCY'));
    await clock.advance(2000);
    tracker.update(status('ARMED'));
    await clock.advance(2000);
  }
  const ladderCalls = lines.filter(({ m }) => LADDER_CALL.test(m)).map(({ at, m }) => `${at} ${m}`);
  const agentCalls = lines.filter(({ m }) => AGENT_CALL.test(m)).length;
  const ladderEntries = actions.entries().filter((e) => e.reason.startsWith('ladder step'));
  return { ladderCalls, agentCalls, asked, ladderEntries };
}

test('flapping statuses: model requests and agent calls stay capped, and the ladder\'s calls are unchanged', async () => {
  const baseline = await runFlapping(null);
  const withAgent = await runFlapping(fakeModels['calls the contact the ladder is about to call']);
  assert.ok(baseline.ladderCalls.length > 100, 'the ladder calls on every new incident');
  assert.deepEqual(withAgent.ladderCalls, baseline.ladderCalls);
  assert.deepEqual(withAgent.ladderEntries, baseline.ladderEntries);
  // 20 minutes is two windows.
  assert.ok(withAgent.asked.length <= 2 * MAX_REQUESTS_PER_WINDOW, `${withAgent.asked.length} model requests`);
  assert.ok(withAgent.agentCalls <= 2 * MAX_CALLS_PER_CONTACT_PER_WINDOW, `${withAgent.agentCalls} agent calls`);
  assert.ok(withAgent.agentCalls > 0);
});
