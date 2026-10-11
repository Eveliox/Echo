// The Responder's voice caller (ticket #19): ElevenLabs when live and
// configured, else the same contact gets the Twilio <Say> call with the same
// code-built message. Fakes only: no ElevenLabs or Twilio request is ever made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceCaller, FALLBACK_REASONS, voiceVariables } from '../voice.js';
import { ELEVENLABS_TIMEOUT_MS, elevenLabsDialer } from '../elevenlabs.js';
import { createCaller, readConfig, sayTwiml } from '../calls.js';
import { emergencyMessage } from '../ladder.js';
import { agentMessage, createResponder } from '../responder.js';
import { createActionLog } from '../actions.js';
import { createFakeClock, settle } from './fake-clock.js';

const env = {
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002',
};
const elevenLabs = { apiKey: 'fake-eleven-key', agentId: 'agent_fake', phoneNumberId: 'phnum_fake' };
const names = ['Mom', 'Alex'];
const status = {
  state: 'EMERGENCY', tempF: 103.25, presence: true, distanceCm: 30,
  minsToDanger: 2.5,
};

// A voice caller on a fake clock with a fake Twilio dial and a fake ElevenLabs
// `start` (by default it accepts the call).
function setup({ live = true, el = elevenLabs, start } = {}) {
  const clock = createFakeClock();
  const dialed = [];
  const started = [];
  const logs = [];
  const errors = [];
  const config = readConfig({ ...env, ECHO_CALLS: live ? 'live' : 'off' });
  const log = (...a) => logs.push(a.join(' '));
  const logError = (...a) => errors.push(a.join(' '));
  const say = createCaller({
    config, dial: async (d) => { dialed.push(d); return { sid: 'CA1' }; }, log, logError,
  });
  const call = createVoiceCaller({
    live: config.live, elevenLabs: el, names, timers: clock.timers, log, logError, say,
    start: start === null ? undefined : async (req) => {
      started.push(req);
      return (start ?? (() => ({ conversationId: 'conv_1', callSid: 'CA9' })))(req);
    },
  });
  return { clock, call, config, dialed, started, logs, errors };
}

const request = (s, contact = s.config.contacts[1]) => ({
  contact, message: agentMessage(status, 'Please go now.'), reason: 'emergency, agent turn 1', status,
});

test('live and configured: one ElevenLabs call that opens with emergencyMessage and gets the box values as sent', async () => {
  const s = setup();
  const result = await s.call(request(s));
  assert.deepEqual(result, { ok: true, dialed: true, voice: true });
  assert.equal(s.dialed.length, 0, 'no Twilio <Say> call');
  assert.equal(s.started.length, 1);
  const { to, firstMessage, variables, signal } = s.started[0];
  assert.equal(to, '+15550000002', 'the number comes from server config, by contact');
  assert.equal(firstMessage, emergencyMessage(status));
  assert.deepEqual(variables, {
    emergency_message: emergencyMessage(status), car_state: 'EMERGENCY', temp_f: '103.25', mins_to_danger: '2.5',
    contact_name: 'Alex', contact_names: 'Mom, Alex',
  });
  assert.ok(signal instanceof AbortSignal);
  assert.match(s.logs.at(-1), /^calls: called Alex \(\+15550000002\) for emergency, agent turn 1 \(ElevenLabs voice call, conversation conv_1\)$/);
});

test('voiceVariables passes a null minsToDanger and whole numbers through as the box sent them', () => {
  const v = voiceVariables({ ...status, tempF: 110, minsToDanger: null }, { name: 'Mom', number: '+15559990000' }, names);
  assert.equal(v.temp_f, '110');
  assert.equal(v.mins_to_danger, 'null');
  assert.equal(v.emergency_message, emergencyMessage({ tempF: 110, minsToDanger: null }));
  assert.ok(!JSON.stringify(v).includes('9990000'), 'never the number');
});

test('not live: only the "would call" log line, never ElevenLabs or Twilio, even with the real dialer', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network touched'); };
  try {
    for (const start of [undefined, null]) {
      const s = setup({ live: false, start });
      const result = await s.call(request(s));
      assert.deepEqual(result, { ok: true, dialed: false });
      assert.equal(s.started.length, 0);
      assert.equal(s.dialed.length, 0);
      assert.equal(s.logs.length, 1);
      assert.match(s.logs[0], /^calls: \[not live\b.*would call Alex/);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Each way ElevenLabs can let a call down, and the fallback reason it records.
const failures = {
  'is not configured': { el: { ...elevenLabs, apiKey: '' }, reason: FALLBACK_REASONS.unconfigured },
  'is missing every key': { el: null, reason: FALLBACK_REASONS.unconfigured },
  'answers 4xx': { start: () => elevenLabsDialer(elevenLabs, { fetchFn: async () => new Response('{}', { status: 422 }) })({}), reason: FALLBACK_REASONS.failed },
  'answers 5xx': { start: () => elevenLabsDialer(elevenLabs, { fetchFn: async () => new Response('x', { status: 503 }) })({}), reason: FALLBACK_REASONS.failed },
  'does not accept the call': { start: () => elevenLabsDialer(elevenLabs, { fetchFn: async () => Response.json({ success: false }) })({}), reason: FALLBACK_REASONS.failed },
  throws: { start: () => { throw new Error('boom'); }, reason: FALLBACK_REASONS.failed },
  'hangs past ELEVENLABS_TIMEOUT_MS': { start: () => new Promise(() => {}), reason: FALLBACK_REASONS.timeout, hangs: true },
};

for (const [name, { el, start, reason, hangs }] of Object.entries(failures)) {
  test(`live, ElevenLabs ${name}: the same contact gets the Twilio <Say> call with the same message`, async () => {
    const s = setup({ el, start });
    const req = request(s);
    const pending = s.call(req);
    if (hangs) {
      await s.clock.advance(ELEVENLABS_TIMEOUT_MS - 1);
      assert.equal(s.dialed.length, 0, 'no fallback before the timeout');
      await s.clock.advance(1);
    }
    const result = await pending;
    assert.deepEqual(result, { ok: true, dialed: true, sid: 'CA1', fallback: reason });
    assert.equal(s.dialed.length, 1);
    assert.deepEqual(s.dialed[0], { to: '+15550000002', twiml: sayTwiml(req.message) });
    assert.ok(req.message.startsWith(emergencyMessage(status)));
    assert.equal(s.clock.pending(), 0, 'no timer left behind');
  });
}

test('the timeout aborts the ElevenLabs request it gave up on', async () => {
  const s = setup({ start: () => new Promise(() => {}) });
  const pending = s.call(request(s));
  await s.clock.advance(ELEVENLABS_TIMEOUT_MS);
  await pending;
  assert.equal(s.started[0].signal.aborted, true);
});

test('a fallback whose Twilio call fails too is still ok: false, so it reads as failed', async () => {
  const s = setup({ start: () => { throw new Error('down'); } });
  const result = await s.call(request(s, { name: 'Alex', number: '' }));
  assert.equal(result.ok, false);
  assert.equal(result.fallback, FALLBACK_REASONS.failed);
  assert.equal(s.started.length, 0, 'no number: ElevenLabs is not even asked');
});

// The Responder records how each of its calls went out.
async function responderEntry(callOptions) {
  const clock = createFakeClock();
  const actions = createActionLog({ now: clock.now });
  const s = setup(callOptions);
  const responder = createResponder({
    contacts: s.config.contacts, call: s.call, actions,
    getStatus: () => ({ online: true, lastSeen: clock.now(), status }),
    model: () => ({ name: 'place_call', args: { contact: 'Alex', message: 'Please go now.' } }),
    timers: s.clock.timers, now: clock.now, log: () => {}, logError: () => {},
  });
  const turn = responder.onStatus(status);
  if (callOptions.hangs) await s.clock.advance(ELEVENLABS_TIMEOUT_MS);
  await turn;
  await settle();
  return { entries: actions.entries(), s };
}

test('the action log says a Responder call went out as a voice call, or why it fell back; never a number', async () => {
  const voice = await responderEntry({});
  assert.equal(voice.entries.length, 1);
  assert.equal(voice.entries[0].action, 'call');
  assert.match(voice.entries[0].reason, /^agent: turn 1: tempF 103\.25, minsToDanger 2\.5; message: "Please go now\."; as an ElevenLabs voice call$/);
  for (const [name, options] of Object.entries(failures)) {
    const { entries, s } = await responderEntry(options);
    assert.equal(entries.length, 1, name);
    assert.equal(entries[0].action, 'call', name);
    assert.ok(entries[0].reason.endsWith(`; ElevenLabs voice call not placed (${options.reason}), so the Twilio spoken alert instead`),
      `${name}: ${entries[0].reason}`);
    assert.equal(s.dialed.length, 1, name);
    assert.ok(!entries[0].reason.includes('+1555'), name);
  }
});
