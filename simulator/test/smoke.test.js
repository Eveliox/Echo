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
