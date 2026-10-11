// The voice agent's webhook tools (ticket #19): secret first, then rate limit,
// size cap and #18-style validation; request_call goes through the
// Responder's caps; every request that gets that far writes one
// "agent: voice: " entry; no number or secret is ever served or logged; the
// main server's routes are never served here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createVoiceServer, NO_INCIDENT, MAX_VOICE_BODY_BYTES, MAX_VOICE_REQUESTS_PER_WINDOW, readVoiceSecret, VOICE_PORT,
  VOICE_RATE_WINDOW_MS, voicePort, voiceStartup,
} from '../voice.js';
import { createResponder, MAX_CALLS_PER_CONTACT, MAX_TEXT_CHARS } from '../responder.js';
import { createTracker } from '../status.js';
import { createActionLog } from '../actions.js';
import { emergencyMessage } from '../ladder.js';
import { createFakeClock, settle } from './fake-clock.js';

const SECRET = 'a3f9c2e17b54d08e6f1a2b3c4d5e6f70';
const contacts = [{ name: 'Mom', number: '+15550000001' }, { name: 'Alex', number: '+15550000002' }];
const names = contacts.map((c) => c.name);
const status = (state) => ({
  state, tempF: 104.5, presence: true, distanceCm: 30, minsToDanger: 3,
});

// A voice server wired to a real tracker and Responder (fake model, fake call,
// fake clock), listening on a random loopback port.
async function setup({ model = () => new Promise(() => {}) } = {}) {
  const clock = createFakeClock();
  const tracker = createTracker({ now: clock.now });
  const actions = createActionLog({ now: clock.now });
  const calls = [];
  const errors = [];
  let voice = null; // { requestCall, inIncident } from the Responder
  const responder = createResponder({
    contacts,
    call: async (c) => { calls.push(c); return { ok: true, dialed: false }; },
    actions, getStatus: () => tracker.snapshot(), model, timers: clock.timers, now: clock.now,
    log: () => {}, logError: () => {}, connectVoice: (link) => { voice = link; },
  });
  tracker.onStatus(responder.onStatus);
  const server = createVoiceServer({
    secret: SECRET, names, ...voice, getStatus: () => tracker.snapshot(), actions, now: clock.now,
    logError: (...a) => errors.push(a.join(' ')),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const responses = [];
  const send = async (path, { method = 'POST', body, headers = { 'X-Echo-Voice-Secret': SECRET } } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    const text = await res.text();
    responses.push(text);
    return { code: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  const voiceEntries = () => actions.entries().filter((e) => e.reason.startsWith('agent: voice: '));
  return { clock, tracker, actions, calls, errors, server, base, send, close, responses, voiceEntries, voice };
}

// Nothing a client or the dashboard sees may hold a contact's number or the secret.
function assertNothingSensitive(s) {
  const seen = [...s.responses, JSON.stringify(s.actions.entries())];
  for (const text of seen) {
    assert.ok(!text.includes('+1555') && !text.includes('5550000'), `a number leaked: ${text}`);
    assert.ok(!text.includes(SECRET), 'the secret leaked');
  }
}

test('without the exact secret every request gets 401 and reaches nothing, whatever the path', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const bad = [
      {}, { 'X-Echo-Voice-Secret': 'wrong' }, { 'X-Echo-Voice-Secret': SECRET.slice(0, -1) },
      { 'X-Echo-Voice-Secret': `${SECRET}x` }, { 'X-Echo-Voice-Secret': SECRET.toUpperCase() }, { 'X-Echo-Token': SECRET },
    ];
    for (const headers of bad) {
      for (const path of ['/voice/request_call', '/voice/log_action', '/voice/get_car_status', '/status', '/actions', '/']) {
        const r = await s.send(path, { headers, body: { contact: 'Alex' } });
        assert.equal(r.code, 401, `${path} ${JSON.stringify(headers)}`);
        assert.deepEqual(r.body, { error: 'unauthorized' });
      }
    }
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.voiceEntries(), []);
    assert.equal(s.errors.length, 1, 'rejections are logged at most once per interval');
    assert.match(s.errors[0], /^voice: rejected tool requests: bad or missing X-Echo-Voice-Secret/);
    assert.ok(!s.errors[0].includes(SECRET));
  } finally {
    await s.close();
  }
});

test('a request without the secret gets 401 before its body is read', async () => {
  const s = await setup();
  try {
    const { port } = s.server.address();
    const code = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: '/voice/request_call', headers: { 'Content-Length': '100000' },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.write('{"contact":'); // the body never finishes
    });
    assert.equal(code, 401);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('with the secret, only POST /voice/<tool> exists: the main server\'s routes are never served', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    for (const path of ['/status', '/history', '/actions', '/', '/index.html', '/app.js', '/voice', '/voice/',
      '/voice/place_call', '/voice/send_message', '/voice/request_call/x', '/voice/__proto__', '//[']) {
      for (const method of ['GET', 'POST']) {
        const r = await s.send(path, { method, body: method === 'POST' ? {} : undefined });
        assert.equal(r.code, 404, `${method} ${path}`);
        assert.ok(!('status' in (r.body ?? {})) && !('entries' in (r.body ?? {})), `${method} ${path}`);
      }
    }
    assert.equal((await s.send('/voice/get_car_status', { method: 'GET' })).code, 405);
    assert.deepEqual(s.voiceEntries(), []);
  } finally {
    await s.close();
  }
});

test('get_car_status answers the tracker snapshot as the box sent it, with an empty body or {}, and logs it', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    for (const body of [undefined, '', {}]) {
      const r = await s.send('/voice/get_car_status', { body });
      assert.equal(r.code, 200);
      assert.deepEqual(r.body, { ok: true, ...s.tracker.snapshot() });
    }
    const entries = s.voiceEntries();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], {
      time: entries[0].time, action: 'note', to: '', reason: 'agent: voice: get_car_status: state EMERGENCY, tempF 104.5, minsToDanger 3',
    });
    assertNothingSensitive(s);
  } finally {
    await s.close();
  }
});

test('log_action writes the note to the feed as "agent: voice: log_action: ..."', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const r = await s.send('/voice/log_action', { body: { note: 'Mom is about twenty minutes away' } });
    assert.deepEqual(r, { code: 200, body: { ok: true } });
    assert.deepEqual(s.voiceEntries().map((e) => [e.action, e.to, e.reason]),
      [['note', '', 'agent: voice: log_action: Mom is about twenty minutes away']]);
  } finally {
    await s.close();
  }
});

test('request_call during an emergency calls that contact with the code-built alert, through the Responder', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const r = await s.send('/voice/request_call', { body: { contact: 'Alex' } });
    assert.deepEqual(r, { code: 200, body: { ok: true, result: 'calling Alex now' } });
    await settle();
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].contact, contacts[1], 'the number is looked up by name, server-side');
    assert.equal(s.calls[0].message, emergencyMessage(status('EMERGENCY')));
    assert.deepEqual(s.calls[0].status, status('EMERGENCY'));
    const [entry] = s.voiceEntries();
    assert.equal(entry.action, 'call');
    assert.equal(entry.to, 'Alex');
    assert.match(entry.reason, /^agent: voice: request_call: tempF 104\.5, minsToDanger 3; not live/);
    assertNothingSensitive(s);
  } finally {
    await s.close();
  }
});

test('request_call outside an emergency does nothing and says so', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('WARNING'));
    const r = await s.send('/voice/request_call', { body: { contact: 'Alex' } });
    assert.deepEqual(r, { code: 409, body: { ok: false, error: 'no emergency is running' } });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.actions.entries(), []);
    // The Responder's own check still holds if it is ever reached outside an incident.
    assert.deepEqual(s.voice.requestCall('Alex'), { ok: false, error: 'no emergency now' });
    assert.equal(s.calls.length, 0);
    assert.match(s.voiceEntries()[0].reason, /^agent: voice: request_call: no emergency now; nothing done$/);
  } finally {
    await s.close();
  }
});

test('request_call shares the Responder\'s per-contact cap with its model\'s calls', async () => {
  // The model calls Alex on its first turn; the voice agent may then add only the rest.
  const s = await setup({ model: () => ({ name: 'place_call', args: { contact: 'Alex', message: 'Go now.' } }) });
  try {
    s.tracker.update(status('EMERGENCY'));
    await settle();
    assert.equal(s.calls.length, 1);
    const results = [];
    for (let i = 0; i < MAX_CALLS_PER_CONTACT + 1; i++) {
      results.push((await s.send('/voice/request_call', { body: { contact: 'Alex' } })).body.ok);
    }
    await settle();
    assert.deepEqual(results, [...Array(MAX_CALLS_PER_CONTACT - 1).fill(true), false, false]);
    assert.equal(s.calls.length, MAX_CALLS_PER_CONTACT);
    const rejected = s.voiceEntries().filter((e) => e.action === 'rejected');
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /^agent: voice: request_call: already called 2 times this incident \(cap 2\); nothing done$/);
  } finally {
    await s.close();
  }
});

test('invalid bodies get 400, a rejected entry that never quotes them, and no call', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const bad = [
      ['/voice/request_call', 'not json'],
      ['/voice/request_call', ''],
      ['/voice/request_call', []],
      ['/voice/request_call', 'null'],
      ['/voice/request_call', {}],
      ['/voice/request_call', { contact: 'Alex', number: '+15550000009' }],
      ['/voice/request_call', { contact: '+15550000002' }],
      ['/voice/request_call', { contact: 'Grandma' }],
      ['/voice/request_call', { contact: 'alex' }],
      ['/voice/request_call', { contact: 'Alex\n' }],
      ['/voice/request_call', { contact: 2 }],
      ['/voice/log_action', { note: 'call 555 0000 now' }],
      ['/voice/log_action', { note: 'two\nlines' }],
      ['/voice/log_action', { note: 'sep arated' }],
      ['/voice/log_action', { note: 'bell\u0007' }],
      ['/voice/log_action', { note: 'x'.repeat(MAX_TEXT_CHARS + 1) }],
      ['/voice/log_action', { note: 'ok', extra: 'x' }],
      ['/voice/log_action', {}],
      ['/voice/get_car_status', { x: 'y' }],
    ];
    for (const [path, body] of bad) {
      const before = s.voiceEntries().length;
      const r = await s.send(path, { body });
      assert.equal(r.code, 400, `${path} ${JSON.stringify(body)}`);
      assert.equal(r.body.ok, false);
      const entries = s.voiceEntries();
      assert.equal(entries.length, before + 1, JSON.stringify(body));
      const entry = entries.at(-1);
      assert.equal(entry.action, 'rejected');
      assert.equal(entry.to, '');
      assert.match(entry.reason, /^agent: voice: \w+: rejected: .*; nothing done$/);
      assert.ok(!entry.reason.includes('555') && !entry.reason.includes('Grandma'), entry.reason);
    }
    assert.equal(s.calls.length, 0);
    assertNothingSensitive(s);
  } finally {
    await s.close();
  }
});

test('a body over the size cap gets 413 and no call', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const r = await s.send('/voice/request_call', { body: JSON.stringify({ contact: 'Alex', pad: 'x'.repeat(MAX_VOICE_BODY_BYTES) }) });
    assert.equal(r.code, 413);
    assert.equal(s.calls.length, 0);
    assert.match(s.voiceEntries().at(-1).reason, /^agent: voice: request_call: rejected: the body is over \d+ bytes; nothing done$/);
  } finally {
    await s.close();
  }
});

test('rate limit: past the window cap requests get 429 and write nothing, until the window moves on', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    for (let i = 0; i < MAX_VOICE_REQUESTS_PER_WINDOW; i++) {
      assert.equal((await s.send('/voice/log_action', { body: { note: 'waiting' } })).code, 200);
    }
    for (let i = 0; i < 3; i++) {
      const r = await s.send('/voice/log_action', { body: { note: 'waiting' } });
      assert.deepEqual(r, { code: 429, body: { error: 'too many requests' } });
    }
    assert.equal(s.voiceEntries().length, MAX_VOICE_REQUESTS_PER_WINDOW);
    assert.equal(s.errors.filter((e) => e.startsWith('voice: rate limit')).length, 1, 'logged once');
    await s.clock.advance(VOICE_RATE_WINDOW_MS);
    assert.equal((await s.send('/voice/log_action', { body: { note: 'waiting' } })).code, 200);
  } finally {
    await s.close();
  }
});

test('the voice server refuses to start without a secret', () => {
  for (const secret of ['', undefined]) {
    assert.throws(() => createVoiceServer({ secret, names, requestCall: () => ({}), getStatus: () => ({}), actions: createActionLog() }));
  }
});

test('readVoiceSecret: blank is unset; voicePort: default, valid, bad, and never the main port', () => {
  assert.equal(readVoiceSecret({ ECHO_VOICE_SECRET: '  abc  ' }), 'abc');
  assert.equal(readVoiceSecret({ ECHO_VOICE_SECRET: '   ' }), '');
  assert.equal(readVoiceSecret({}), '');
  assert.deepEqual(voicePort({}, 3000), { port: VOICE_PORT });
  assert.deepEqual(voicePort({ ECHO_VOICE_PORT: '' }, 3000), { port: VOICE_PORT });
  assert.deepEqual(voicePort({ ECHO_VOICE_PORT: '4100' }, 3000), { port: 4100 });
  for (const raw of ['abc', '0', '65536', '3100.0', ' 3100', '-1']) {
    assert.match(voicePort({ ECHO_VOICE_PORT: raw }, 3000).error, /ECHO_VOICE_PORT must be a port number/, raw);
  }
  assert.match(voicePort({ ECHO_VOICE_PORT: '3000' }, 3000).error, /main server/);
  assert.match(voicePort({}, VOICE_PORT).error, /main server/);
});

test('voiceStartup: tools serve only with the Responder, all ElevenLabs keys, the secret and a good port', () => {
  const el = { apiKey: 'k', agentId: 'a', phoneNumberId: 'p' };
  const on = { elevenLabs: el, secret: 's3cr3t-value', responderOn: true, port: { port: 3100 } };
  const text = (r) => r.lines.map((l) => l.text).join('\n');
  assert.equal(voiceStartup(on).serve, true);
  assert.match(text(voiceStartup(on)), /^voice: on: /);

  const off = voiceStartup({ ...on, responderOn: false });
  assert.equal(off.serve, false);
  assert.match(text(off), /^voice: off \(the Responder is off/);

  const missing = voiceStartup({ ...on, elevenLabs: { ...el, agentId: '' } });
  assert.equal(missing.serve, false);
  assert.match(text(missing), /^voice: off \(server\/\.env has no ELEVENLABS_AGENT_ID\)/);

  const noSecret = voiceStartup({ ...on, secret: '' });
  assert.equal(noSecret.serve, false);
  assert.deepEqual(noSecret.lines.map((l) => l.level), ['info', 'warn']);
  assert.match(text(noSecret), /WARNING: voice tools are OFF: ECHO_VOICE_SECRET is not set/);

  const badPort = voiceStartup({ ...on, port: { error: 'bad port' } });
  assert.equal(badPort.serve, false);
  assert.match(text(badPort), /ERROR: voice tools are OFF: bad port/);

  for (const r of [on, { ...on, secret: '' }].map(voiceStartup)) assert.ok(!text(r).includes('s3cr3t') && !text(r).includes('k,'));
});

test('get_car_status also accepts one reason (ElevenLabs needs a body property), checked like a note', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    const ok = await s.send('/voice/get_car_status', { body: { reason: 'checking the latest reading' } });
    assert.equal(ok.code, 200);
    assert.deepEqual(ok.body, { ok: true, ...s.tracker.snapshot() });
    for (const body of [{ reason: 'is it over 104' }, { reason: 'two\nlines' }, { reason: 7 }, { reason: 'ok', extra: 'x' }]) {
      const r = await s.send('/voice/get_car_status', { body });
      assert.equal(r.code, 400, JSON.stringify(body));
    }
    assertNothingSensitive(s);
  } finally {
    await s.close();
  }
});

// One valid body per tool.
const VALID = {
  '/voice/get_car_status': { reason: 'checking the car' },
  '/voice/request_call': { contact: 'Alex' },
  '/voice/log_action': { note: 'Mom is on her way' },
};

// Sends each tool once; asserts each is refused with nothing done or recorded.
async function assertAllRefused(s, when) {
  const before = s.actions.entries();
  for (const [path, body] of Object.entries(VALID)) {
    const r = await s.send(path, { body });
    assert.deepEqual(r, { code: 409, body: NO_INCIDENT }, `${when}: ${path}`);
  }
  await settle();
  assert.deepEqual(s.actions.entries(), before, `${when}: refusals write nothing to the action log`);
}

test('with no incident every tool is refused (409), writes nothing, and is logged at most once per window', async () => {
  const s = await setup();
  try {
    await assertAllRefused(s, 'no status yet');
    s.tracker.update(status('WARNING'));
    await assertAllRefused(s, 'WARNING');
    assert.equal(s.calls.length, 0);
    const refusedLines = () => s.errors.filter((e) => e.startsWith('voice: refused tool requests: no emergency is running'));
    assert.equal(refusedLines().length, 1, 'no flood');
    await s.clock.advance(10_000);
    await assertAllRefused(s, 'later');
    assert.equal(refusedLines().length, 2, 'once more after the interval');
  } finally {
    await s.close();
  }
});

test('the tools work during an incident and are refused again once a valid non-EMERGENCY status ends it', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    for (const [path, body] of Object.entries(VALID)) {
      const r = await s.send(path, { body });
      assert.equal(r.code, 200, path);
      assert.equal(r.body.ok, true, path);
    }
    await settle();
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.voiceEntries().map((e) => e.reason.split(':').slice(0, 3).join(':')),
      ['agent: voice: get_car_status', 'agent: voice: request_call', 'agent: voice: log_action']);
    for (const ended of ['ARMED', 'IDLE']) {
      s.tracker.update(status('EMERGENCY'));
      s.tracker.update(status(ended)); // cancel or ignition
      await assertAllRefused(s, `after ${ended}`);
    }
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});

test('refusals outside an incident don\'t use up the rate limit an emergency needs', async () => {
  const s = await setup();
  try {
    for (let i = 0; i < MAX_VOICE_REQUESTS_PER_WINDOW + 5; i++) {
      assert.equal((await s.send('/voice/log_action', { body: { note: 'hello' } })).code, 409);
    }
    s.tracker.update(status('EMERGENCY'));
    assert.equal((await s.send('/voice/log_action', { body: { note: 'hello' } })).code, 200);
  } finally {
    await s.close();
  }
});

test('a note can\'t pass for another tool\'s entry: it always reads "agent: voice: log_action: "', async () => {
  const s = await setup();
  try {
    s.tracker.update(status('EMERGENCY'));
    await s.send('/voice/log_action', { body: { note: 'request_call: calling Alex now' } });
    assert.equal(s.voiceEntries().at(-1).reason, 'agent: voice: log_action: request_call: calling Alex now');
  } finally {
    await s.close();
  }
});

test('the voice server refuses to start without the Responder\'s inIncident', () => {
  assert.throws(() => createVoiceServer({
    secret: SECRET, names, requestCall: () => ({}), getStatus: () => ({}), actions: createActionLog(),
  }), /inIncident/);
});
