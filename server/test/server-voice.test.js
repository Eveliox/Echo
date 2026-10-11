// Ticket #19, wired as in server.js with ECHO_CALLS=live but fake Twilio and
// fake ElevenLabs: the ladder's calls (0/2/3/5 min) are identical whatever the
// Responder's ElevenLabs calls do. With ElevenLabs given to the ladder too,
// only step 1's first call to Contact #1 tries a voice call, and it falls back
// to the Twilio call within ELEVENLABS_TIMEOUT_MS; steps 2-4 never change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachLadder, attachResponder } from '../server.js';
import { createTracker } from '../status.js';
import { createActionLog } from '../actions.js';
import { readConfig } from '../calls.js';
import {
  emergencyMessage, STEP2_AFTER_MS, STEP3_AFTER_MS, STEP4_AFTER_MS,
} from '../ladder.js';
import { ELEVENLABS_TIMEOUT_MS } from '../elevenlabs.js';
import { createFakeClock } from './fake-clock.js';

const config = readConfig({
  ECHO_CALLS: 'live', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002',
});
const elevenLabs = { apiKey: 'fake-eleven-key', agentId: 'agent_fake', phoneNumberId: 'phnum_fake' };

const status = {
  state: 'EMERGENCY', tempF: 104.5, presence: true, distanceCm: 30, minsToDanger: 2,
};
const LADDER_CALL = /^calls: called (\w+) .* for emergency, ladder step (\d) \(Twilio call/;
const RUN_MS = 6 * 60_000;

// One live incident on a fake clock; `startVoice` is the fake ElevenLabs, or
// null for no Responder at all.
async function run(startVoice) {
  const clock = createFakeClock();
  const begin = clock.now();
  const lines = [];
  const ladderDials = [];
  const agentDials = [];
  const voiceStarts = [];
  const log = (...a) => lines.push({ at: clock.now() - begin, m: a.join(' ') });
  const logError = () => {};
  const tracker = createTracker({ now: clock.now, logError });
  const actions = createActionLog({ now: clock.now });
  const opts = { config, log, logError, actions, timers: clock.timers, now: clock.now };
  attachLadder(tracker, { ...opts, dial: async (d) => { ladderDials.push({ at: clock.now() - begin, to: d.to }); return { sid: 'CA1' }; } });
  if (startVoice !== null) {
    attachResponder(tracker, {
      ...opts,
      elevenLabs,
      model: () => ({ name: 'place_call', args: { contact: 'Alex', message: 'Please go now.' } }),
      dial: async (d) => { agentDials.push({ at: clock.now() - begin, to: d.to }); return { sid: 'CA2' }; },
      startVoice: (req) => { voiceStarts.push({ at: clock.now() - begin, to: req.to }); return startVoice(req); },
    });
  }
  for (let t = 0; t < RUN_MS; t += 2000) {
    tracker.update(status);
    await clock.advance(2000);
  }
  const ladderCalls = lines.filter(({ m }) => LADDER_CALL.test(m)).map(({ at, m }) => {
    const [, who, step] = m.match(LADDER_CALL);
    return { at, who, step: Number(step) };
  });
  const ladderEntries = actions.entries().filter((e) => e.reason.startsWith('ladder step'));
  const agentEntries = actions.entries().filter((e) => e.reason.startsWith('agent: '));
  return { ladderCalls, ladderDials, agentDials, voiceStarts, ladderEntries, agentEntries };
}

const elevenLabsBehaviors = {
  'accepts every call': async () => ({ conversationId: 'conv_1', callSid: 'CA9' }),
  'answers an error': async () => { throw new Error('ElevenLabs answered 500'); },
  'throws at once': () => { throw new Error('boom'); },
  'never answers': () => new Promise(() => {}),
  // Accepts the call only once Echo has given up on it.
  'accepts just after the timeout': (req) => new Promise((resolve) => {
    req.signal.addEventListener('abort', () => resolve({ conversationId: 'conv_late', callSid: null }));
  }),
};

test('live with no Responder, the ladder calls at 0, 2, 3 and 5 minutes', async () => {
  const { ladderCalls } = await run(null);
  assert.deepEqual(ladderCalls, [
    { at: 0, who: 'Mom', step: 1 },
    { at: STEP2_AFTER_MS, who: 'Mom', step: 2 },
    { at: STEP3_AFTER_MS, who: 'Alex', step: 3 },
    { at: STEP4_AFTER_MS, who: 'Mom', step: 4 },
    { at: STEP4_AFTER_MS, who: 'Alex', step: 4 },
  ]);
});

for (const [name, startVoice] of Object.entries(elevenLabsBehaviors)) {
  test(`live, ElevenLabs ${name}: the ladder's calls and entries match a run with no Responder`, async () => {
    const baseline = await run(null);
    const withVoice = await run(startVoice);
    assert.deepEqual(withVoice.ladderCalls, baseline.ladderCalls);
    assert.deepEqual(withVoice.ladderDials, baseline.ladderDials, 'same Twilio dials at the same times');
    assert.deepEqual(withVoice.ladderEntries, baseline.ladderEntries);
    assert.ok(withVoice.voiceStarts.length > 0, 'the Responder did try ElevenLabs');
    assert.ok(withVoice.voiceStarts.every((v) => v.to === '+15550000002'), 'only the Responder\'s calls, never the ladder\'s');
  });
}

test('live, ElevenLabs fails: each Responder call still reaches the same contact through Twilio, in time', async () => {
  const failed = await run(elevenLabsBehaviors['never answers']);
  assert.ok(failed.agentDials.length > 0);
  assert.deepEqual(failed.agentDials.map((d) => d.to), failed.voiceStarts.map((v) => v.to));
  failed.agentDials.forEach((d, i) => assert.equal(d.at - failed.voiceStarts[i].at, ELEVENLABS_TIMEOUT_MS));
  assert.ok(failed.agentEntries.filter((e) => e.action === 'call').every((e) => e.reason.includes('voice call not placed')));
  const late = await run(elevenLabsBehaviors['accepts just after the timeout']);
  assert.equal(late.agentDials.length, late.voiceStarts.length, 'too late counts as not placed: Twilio calls too');
  const voiced = await run(elevenLabsBehaviors['accepts every call']);
  assert.equal(voiced.agentDials.length, 0, 'a voice call is not doubled by a Twilio <Say> call');
});

test('not live, attachResponder never asks ElevenLabs, even fully configured: calls are only logged', async () => {
  const clock = createFakeClock();
  const lines = [];
  const voiceStarts = [];
  const dials = [];
  const tracker = createTracker({ now: clock.now, logError: () => {} });
  const actions = createActionLog({ now: clock.now });
  attachResponder(tracker, {
    config: { ...config, live: false }, elevenLabs, actions, timers: clock.timers, now: clock.now,
    log: (m) => lines.push(m), logError: () => {},
    model: () => ({ name: 'place_call', args: { contact: 'Alex', message: 'Please go now.' } }),
    dial: async (d) => { dials.push(d); return { sid: 'CA2' }; },
    startVoice: async (req) => { voiceStarts.push(req); return { conversationId: 'conv_1' }; },
  });
  await tracker.update(status);
  await clock.advance(2000);
  assert.equal(voiceStarts.length, 0);
  assert.equal(dials.length, 0);
  assert.ok(lines.some((m) => /^calls: \[not live\b.*would call Alex/.test(m)));
  assert.match(actions.entries()[0].reason, /not live/);
});

// The ladder alone, with ElevenLabs given to it as server.js does.
async function runLadderVoice(startVoice, { live = true, voice = elevenLabs } = {}) {
  const clock = createFakeClock();
  const begin = clock.now();
  const dials = [];
  const voiceStarts = [];
  const tracker = createTracker({ now: clock.now, logError: () => {} });
  const actions = createActionLog({ now: clock.now });
  attachLadder(tracker, {
    config: { ...config, live }, elevenLabs: voice, actions, timers: clock.timers, now: clock.now,
    log: () => {}, logError: () => {},
    dial: async (d) => { dials.push({ at: clock.now() - begin, to: d.to }); return { sid: 'CA1' }; },
    startVoice: (req) => { voiceStarts.push({ at: clock.now() - begin, ...req }); return startVoice(req); },
  });
  for (let t = 0; t < RUN_MS; t += 2000) {
    tracker.update(status);
    await clock.advance(2000);
  }
  return { dials, voiceStarts, entries: actions.entries() };
}

const TIMED_DIALS = [
  { at: STEP2_AFTER_MS, to: '+15550000001' },
  { at: STEP3_AFTER_MS, to: '+15550000002' },
  { at: STEP4_AFTER_MS, to: '+15550000001' },
  { at: STEP4_AFTER_MS, to: '+15550000002' },
];

test('ladder with ElevenLabs: the first call to Contact #1 is a voice call at once, steps 2-4 stay Twilio', async () => {
  const r = await runLadderVoice(elevenLabsBehaviors['accepts every call']);
  assert.equal(r.voiceStarts.length, 1, 'one voice call, never a retry or a later step');
  const [v] = r.voiceStarts;
  assert.equal(v.at, 0);
  assert.equal(v.to, '+15550000001');
  assert.equal(v.firstMessage, emergencyMessage(status));
  assert.equal(v.variables.temp_f, '104.5');
  assert.equal(v.variables.mins_to_danger, '2');
  assert.deepEqual(r.dials, TIMED_DIALS, 'no Twilio call doubles the voice call; steps 2-4 on time');
  const step1 = r.entries.find((e) => e.reason.startsWith('ladder step 1'));
  assert.equal(step1.action, 'call');
  assert.match(step1.reason, /; as an ElevenLabs voice call$/);
});

for (const name of ['answers an error', 'throws at once', 'never answers', 'accepts just after the timeout']) {
  test(`ladder with ElevenLabs that ${name}: Contact #1 gets the Twilio call within the timeout`, async () => {
    const r = await runLadderVoice(elevenLabsBehaviors[name]);
    assert.equal(r.voiceStarts.length, 1);
    const timedOut = name === 'never answers' || name === 'accepts just after the timeout';
    assert.deepEqual(r.dials, [{ at: timedOut ? ELEVENLABS_TIMEOUT_MS : 0, to: '+15550000001' }, ...TIMED_DIALS]);
    const step1 = r.entries.find((e) => e.reason.startsWith('ladder step 1'));
    assert.equal(step1.action, 'call');
    assert.match(step1.reason, /ElevenLabs voice call not placed \(ElevenLabs (did not accept the call in time|failed, see the server log)\), so the Twilio spoken alert instead$/);
  });
}

test('ladder with ElevenLabs and Twilio both failing: step 1 retries through Twilio only', async () => {
  const clock = createFakeClock();
  const voiceStarts = [];
  let dials = 0;
  const tracker = createTracker({ now: clock.now, logError: () => {} });
  const actions = createActionLog({ now: clock.now });
  attachLadder(tracker, {
    config, elevenLabs, actions, timers: clock.timers, now: clock.now, log: () => {}, logError: () => {},
    dial: async () => { dials += 1; throw new Error('Twilio down'); },
    startVoice: async (req) => { voiceStarts.push(req); throw new Error('ElevenLabs answered 500'); },
  });
  for (let t = 0; t < 60_000; t += 2000) {
    tracker.update(status);
    await clock.advance(2000);
  }
  assert.equal(voiceStarts.length, 1);
  assert.ok(dials > 5, 'step 1 keeps retrying through Twilio');
});

test('ladder with ElevenLabs but not live, or not fully configured: same Twilio calls as before, no voice request', async () => {
  const baseline = await runLadderVoice(async () => ({}), { voice: null });
  assert.deepEqual(baseline.dials, [{ at: 0, to: '+15550000001' }, ...TIMED_DIALS]);
  const partial = await runLadderVoice(async () => ({}), { voice: { ...elevenLabs, phoneNumberId: '' } });
  assert.equal(partial.voiceStarts.length, 0);
  assert.deepEqual(partial.dials, baseline.dials);
  assert.deepEqual(partial.entries, baseline.entries);
  const notLive = await runLadderVoice(async () => ({}), { live: false });
  assert.equal(notLive.voiceStarts.length, 0);
  assert.equal(notLive.dials.length, 0);
  assert.match(notLive.entries[0].reason, /not live/);
});

test('ladder with ElevenLabs: cancel during the voice attempt places no Twilio fallback, and logs a skip', async () => {
  const clock = createFakeClock();
  const dials = [];
  const tracker = createTracker({ now: clock.now, logError: () => {} });
  const actions = createActionLog({ now: clock.now });
  attachLadder(tracker, {
    config, elevenLabs, actions, timers: clock.timers, now: clock.now, log: () => {}, logError: () => {},
    dial: async (d) => { dials.push(d.to); return { sid: 'CA1' }; },
    startVoice: elevenLabsBehaviors['never answers'],
  });
  tracker.update(status);
  await clock.advance(2000);
  tracker.update({ ...status, state: 'ARMED' }); // cancel button
  await clock.advance(RUN_MS);
  assert.deepEqual(dials, [], 'nobody is called after the alarm was cleared');
  const entries = actions.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'skip');
  assert.match(entries[0].reason, /^ladder step 1: the incident ended while the ElevenLabs voice call was tried \(ElevenLabs did not accept the call in time\), so no Twilio call was placed$/);
});

test('ladder with ElevenLabs: an EMERGENCY that stays on still gets the Twilio fallback (stillNeeded true)', async () => {
  const r = await runLadderVoice(elevenLabsBehaviors['never answers']);
  assert.equal(r.dials[0].at, ELEVENLABS_TIMEOUT_MS);
  assert.ok(!r.entries.some((e) => e.action === 'skip'));
});
