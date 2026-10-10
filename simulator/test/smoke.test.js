import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, judgeLog, refuseReason, childEnv, BLANKED_CALL_KEYS, DEFAULT_SMOKE_LOG_DIR } from '../smoke.js';
import { readConfig, missingCallSettings } from '../../server/calls.js';

const last = {
  state: 'EMERGENCY', tempF: 110.5, humidity: 30, presence: true, distanceCm: 38,
  motion: null, minsToDanger: null, battery: null,
};
const snapshot = { online: true, lastSeen: 1, status: { ...last } };
const ladder = 'calls: [not live, ECHO_CALLS is not "live"] would call Contact #1 (number not set) for emergency, ladder step 1: "..."';
const called = 'calls: called Contact #1 (+15550000001) for emergency, ladder step 1 (Twilio call CA1)';
const startup = ['Echo server listening on port 4000', 'ECHO_CALLS is not "live": calls are only logged'];

test('passes with exactly one logged ladder call and the last status online', () => {
  assert.deepEqual(judge({ output: [...startup, ladder], snapshot, lastStatus: last }), []);
});

test('fails with no ladder call or more than one', () => {
  assert.equal(judge({ output: startup, snapshot, lastStatus: last }).length, 1);
  assert.equal(judge({ output: [...startup, ladder, ladder], snapshot, lastStatus: last }).length, 1);
});

test('fails on any dialed call, even alongside one ladder line', () => {
  assert.match(judge({ output: [ladder, called], snapshot, lastStatus: last }).join(), /0 dialed/);
});

test('fails when GET /status is offline, not EMERGENCY, or not the last status', () => {
  assert.notDeepEqual(judge({ output: [ladder], snapshot: { ...snapshot, online: false }, lastStatus: last }), []);
  const warning = { ...last, state: 'WARNING' };
  assert.notDeepEqual(judge({ output: [ladder], snapshot: { ...snapshot, status: warning }, lastStatus: warning }), []);
  assert.notDeepEqual(judge({ output: [ladder], snapshot: { ...snapshot, status: { ...last, tempF: 1 } }, lastStatus: last }), []);
  assert.notDeepEqual(judge({ output: [ladder], snapshot: null, lastStatus: last }), []);
});

test('refuses to run when ECHO_CALLS is live in its environment', () => {
  for (const value of ['live', 'LIVE', ' live ']) assert.match(refuseReason({ ECHO_CALLS: value }), /refusing/);
  for (const value of [undefined, 'off', '', 'lively']) assert.equal(refuseReason({ ECHO_CALLS: value }), null);
});

// Real-looking values, as a parent shell or server/.env might hold them.
const realLooking = {
  TWILIO_ACCOUNT_SID: 'fake-account-sid', TWILIO_AUTH_TOKEN: 'fake-auth-token',
  TWILIO_FROM_NUMBER: '+15551230000', CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15551230001',
  CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15551230002',
};

test('the child server env forces ECHO_CALLS=off and blanks the call settings, whatever the parent has', () => {
  assert.deepEqual(BLANKED_CALL_KEYS.toSorted(), Object.keys(realLooking).toSorted());
  for (const echoCalls of [undefined, 'off', 'live']) {
    const env = childEnv({ ...realLooking, ECHO_CALLS: echoCalls, PATH: '/bin' }, 4123);
    assert.equal(env.ECHO_CALLS, 'off');
    assert.equal(env.ECHO_PORT, '4123');
    assert.equal(env.PATH, '/bin');
    for (const key of BLANKED_CALL_KEYS) assert.equal(env[key], '', key);
  }
});

test('blanked settings survive a server/.env with real values, so nothing could dial', () => {
  // The child process does what server.js does: load a .env, then read the config.
  const dir = mkdtempSync(join(tmpdir(), 'echo-smoke-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, Object.entries(realLooking).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  try {
    const calls = fileURLToPath(new URL('../../server/calls.js', import.meta.url));
    const script = `const { loadEnv, readConfig } = await import(${JSON.stringify(calls)});`
      + `loadEnv(${JSON.stringify(file)}); console.log(JSON.stringify(readConfig()));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv(realLooking, 4123), encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const config = JSON.parse(run.stdout);
    assert.equal(config.live, false);
    assert.deepEqual(config.twilio, { accountSid: '', authToken: '', from: '' });
    assert.deepEqual(config.contacts[0], { name: 'Contact #1', number: '' });
    assert.deepEqual(config.contacts[1], { name: 'Contact #2', number: '' });
    // Even if the live gate were bypassed, a call would be blocked as unconfigured.
    assert.deepEqual(missingCallSettings({ ...config, live: true }),
      ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'CONTACT1_NUMBER']);
    assert.equal(readConfig(childEnv(realLooking, 1)).contacts[0].number, '');
    assert.equal(readConfig(childEnv(realLooking, 1)).contacts[1].number, '');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the judge passes the would-call line for the blanked contact', () => {
  const blanked = 'calls: [not live, ECHO_CALLS is not "live"] would call Contact #1 (number not set) '
    + 'for emergency, ladder step 1: "This is Echo, an emergency alert."';
  assert.deepEqual(judge({ output: [...startup, blanked], snapshot, lastStatus: last }), []);
});

test('the child server logs statuses to the given temp folder, never into the repo', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const dir = join(tmpdir(), 'echo-smoke-logs-x');
  assert.equal(childEnv({ ECHO_LOG_DIR: join(repo, 'server', 'logs') }, 4123, dir).ECHO_LOG_DIR, dir);
  const fallback = childEnv({ ECHO_LOG_DIR: join(repo, 'server', 'logs') }, 4123).ECHO_LOG_DIR;
  assert.equal(fallback, DEFAULT_SMOKE_LOG_DIR);
  assert.ok(!fallback.startsWith(repo), `${fallback} is inside the repo`);
});

test('judgeLog passes one log whose status lines are the recording\'s, and fails otherwise', () => {
  const lines = ['{"n":1}', '{ "n" : 2 }'];
  const log = '# 2026-10-10T20:00:00.000Z\n{"n":1}\n# 2026-10-10T20:00:02.000Z\n{ "n" : 2 }\n';
  assert.deepEqual(judgeLog({ logs: [log], lines }), []);
  assert.equal(judgeLog({ logs: [], lines }).length, 1);
  assert.equal(judgeLog({ logs: [log, log], lines }).length, 1);
  assert.equal(judgeLog({ logs: [log.replace('{ "n" : 2 }', '{"n":2}')], lines }).length, 1, 're-serialized is not unchanged');
  assert.equal(judgeLog({ logs: ['# 2026-10-10T20:00:00.000Z\n{"n":1}\n'], lines }).length, 1, 'a missing line fails');
});

test('the child server gets the token smoke chose, never the parent\'s; none given means auth off', () => {
  const parent = { ...realLooking, ECHO_BOX_TOKEN: 'parent-box-token' };
  assert.equal(childEnv(parent, 4123, DEFAULT_SMOKE_LOG_DIR, 'smoke-token').ECHO_BOX_TOKEN, 'smoke-token');
  assert.equal(childEnv(parent, 4123).ECHO_BOX_TOKEN, '');
  assert.equal(childEnv({}, 4123).ECHO_BOX_TOKEN, '');
});

test('a server/.env ECHO_BOX_TOKEN does not override the token smoke gives its child', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-smoke-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'ECHO_BOX_TOKEN=file-box-token\n');
  try {
    const calls = fileURLToPath(new URL('../../server/calls.js', import.meta.url));
    const auth = fileURLToPath(new URL('../../server/auth.js', import.meta.url));
    const script = `const { loadEnv } = await import(${JSON.stringify(calls)});`
      + `const { readBoxToken } = await import(${JSON.stringify(auth)});`
      + `loadEnv(${JSON.stringify(file)}); console.log(JSON.stringify(readBoxToken()));`;
    for (const [token, expected] of [['smoke-token', 'smoke-token'], [undefined, '']]) {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: childEnv({ ECHO_BOX_TOKEN: 'parent-box-token' }, 4123, DEFAULT_SMOKE_LOG_DIR, token),
        encoding: 'utf8',
        timeout: 10_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout), expected);
    }
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('judgeAuth passes with the auth-on line and exactly one rejection of one post, and fails otherwise', async () => {
  const { judgeAuth, REJECTED_ONE_LINE } = await import('../smoke.js');
  const authOn = 'box token auth: on (the box must send X-Echo-Token, ticket #17; until then every box status gets 401)';
  const rejected = 'rejected 1 status posts: bad or missing token';
  assert.equal(REJECTED_ONE_LINE, rejected);
  assert.deepEqual(judgeAuth({ output: [...startup, authOn, rejected, ladder] }), []);
  assert.equal(judgeAuth({ output: [...startup, rejected, ladder] }).length, 1, 'missing auth-on line');
  assert.equal(judgeAuth({ output: [...startup, 'WARNING: box token auth is OFF: ...', ladder] }).length, 2, 'auth off');
  assert.equal(judgeAuth({ output: [...startup, authOn, ladder] }).length, 1, 'missing rejection line');
  assert.equal(judgeAuth({ output: [authOn, rejected, rejected] }).length, 1, 'two rejection lines');
  assert.equal(judgeAuth({ output: [authOn, 'rejected 2 status posts: bad or missing token'] }).length, 1, 'wrong count');
  assert.equal(judgeAuth({ output: ['  box token auth: on', rejected] }).length, 1, 'prefix only at line start');
});

test('the child server env blanks the Responder\'s Gemini key too, whatever the parent has', async () => {
  const { BLANKED_AGENT_KEYS } = await import('../smoke.js');
  assert.deepEqual(BLANKED_AGENT_KEYS, ['GEMINI_API_KEY']);
  for (const key of BLANKED_CALL_KEYS) assert.ok(!BLANKED_AGENT_KEYS.includes(key));
  const env = childEnv({ ...realLooking, GEMINI_API_KEY: 'fake-gemini-key', GEMINI_MODEL: 'gemini-x' }, 4123);
  assert.equal(env.GEMINI_API_KEY, '');
  assert.equal(env.GEMINI_MODEL, 'gemini-x', 'the model name is not a secret');
  for (const key of BLANKED_CALL_KEYS) assert.equal(env[key], '', key);
});

test('a server/.env GEMINI_API_KEY does not survive the blank, so the child\'s Responder is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-smoke-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'GEMINI_API_KEY=fake-gemini-key\n');
  try {
    const calls = fileURLToPath(new URL('../../server/calls.js', import.meta.url));
    const gemini = fileURLToPath(new URL('../../server/gemini.js', import.meta.url));
    const script = `const { loadEnv } = await import(${JSON.stringify(calls)});`
      + `const { readGeminiConfig, responderStartupMessage } = await import(${JSON.stringify(gemini)});`
      + `loadEnv(${JSON.stringify(file)}); console.log(responderStartupMessage(readGeminiConfig()));`;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv({ GEMINI_API_KEY: 'parent-gemini-key' }, 4123), encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'responder: off (no GEMINI_API_KEY)');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('judgeResponder passes only when the server printed the Responder-off line', async () => {
  const { judgeResponder, RESPONDER_OFF_LINE } = await import('../smoke.js');
  assert.equal(RESPONDER_OFF_LINE, 'responder: off (no GEMINI_API_KEY)');
  assert.deepEqual(judgeResponder({ output: [...startup, RESPONDER_OFF_LINE, ladder] }), []);
  assert.equal(judgeResponder({ output: [...startup, ladder] }).length, 1, 'no line');
  assert.equal(judgeResponder({ output: ['responder: on (Gemini gemini-x; ...)', ladder] }).length, 1, 'on');
  assert.equal(judgeResponder({ output: [`  ${RESPONDER_OFF_LINE}`] }).length, 1, 'whole line only');
});

test('the child server env blanks the ElevenLabs keys and the voice secret too, whatever the parent has', async () => {
  const { BLANKED_VOICE_KEYS, BLANKED_AGENT_KEYS } = await import('../smoke.js');
  assert.deepEqual(BLANKED_VOICE_KEYS,
    ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID', 'ECHO_VOICE_SECRET']);
  const parent = {
    ...realLooking, GEMINI_API_KEY: 'fake-gemini-key', ELEVENLABS_API_KEY: 'fake-eleven-key',
    ELEVENLABS_AGENT_ID: 'agent_fake', ELEVENLABS_PHONE_NUMBER_ID: 'phnum_fake', ECHO_VOICE_SECRET: 'fake-voice-secret',
  };
  const env = childEnv(parent, 4123);
  for (const key of [...BLANKED_CALL_KEYS, ...BLANKED_AGENT_KEYS, ...BLANKED_VOICE_KEYS]) assert.equal(env[key], '', key);
});

test('a server/.env with ElevenLabs and a voice secret does not survive the blank, so voice is off in smoke', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-smoke-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'ELEVENLABS_API_KEY=fake-eleven-key\nELEVENLABS_AGENT_ID=agent_fake\n'
    + 'ELEVENLABS_PHONE_NUMBER_ID=phnum_fake\nECHO_VOICE_SECRET=fake-voice-secret\n');
  try {
    const calls = fileURLToPath(new URL('../../server/calls.js', import.meta.url));
    const eleven = fileURLToPath(new URL('../../server/elevenlabs.js', import.meta.url));
    const voice = fileURLToPath(new URL('../../server/voice.js', import.meta.url));
    const script = `const { loadEnv } = await import(${JSON.stringify(calls)});`
      + `const { readElevenLabsConfig, missingElevenLabsSettings } = await import(${JSON.stringify(eleven)});`
      + `const { readVoiceSecret } = await import(${JSON.stringify(voice)});`
      + `loadEnv(${JSON.stringify(file)});`
      + 'console.log(JSON.stringify([missingElevenLabsSettings(readElevenLabsConfig()), readVoiceSecret()]));';
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: childEnv({ ELEVENLABS_API_KEY: 'parent-eleven-key' }, 4123), encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout),
      [['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID'], '']);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('judgeVoice passes only with a "voice: off" line and no voice tools listening', async () => {
  const { judgeVoice } = await import('../smoke.js');
  const off = 'voice: off (the Responder is off; only its calls use ElevenLabs)';
  const tools = 'voice: tool webhooks on 127.0.0.1:3100 only; tunnel only this port (ngrok http 127.0.0.1:3100), never 3000';
  assert.deepEqual(judgeVoice({ output: [...startup, off, ladder] }), []);
  assert.equal(judgeVoice({ output: [...startup, ladder] }).length, 1, 'no line');
  assert.equal(judgeVoice({ output: ['voice: on: ...', tools] }).length, 2, 'on and listening');
  assert.equal(judgeVoice({ output: [off, tools] }).length, 1, 'tools listening');
  assert.equal(judgeVoice({ output: [`  ${off}`] }).length, 1, 'line start only');
});
