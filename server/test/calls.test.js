import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callsStartupMessage, createCaller, loadEnv, missingCallSettings, readConfig, sayTwiml, twilioDialer,
} from '../calls.js';

const fullEnv = {
  TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000',
  CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001',
};
const request = (config) => ({ contact: config.contacts[0], message: 'Test message', reason: 'test' });

function spies() {
  const dialed = [];
  const logs = [];
  const errors = [];
  return {
    dialed, logs, errors,
    dial: async (args) => { dialed.push(args); return { sid: 'CA1' }; },
    log: (...a) => logs.push(a.join(' ')),
    logError: (...a) => errors.push(a.join(' ')),
  };
}

test('only ECHO_CALLS=live (exactly) is live', () => {
  assert.equal(readConfig({ ECHO_CALLS: 'live' }).live, true);
  for (const value of [undefined, '', 'off', 'LIVE', 'Live', ' live', 'live ', 'true', '1', 'on']) {
    assert.equal(readConfig({ ECHO_CALLS: value }).live, false, `ECHO_CALLS=${JSON.stringify(value)}`);
  }
});

test('with ECHO_CALLS unset or off the call is only logged, never dialed', async () => {
  for (const env of [{ ...fullEnv }, { ...fullEnv, ECHO_CALLS: 'off' }, { ...fullEnv, ECHO_CALLS: 'LIVE' }]) {
    const s = spies();
    const config = readConfig(env);
    const result = await createCaller({ config, dial: s.dial, log: s.log, logError: s.logError })(request(config));
    assert.deepEqual(result, { ok: true, dialed: false });
    assert.equal(s.dialed.length, 0, `no dial with ECHO_CALLS=${env.ECHO_CALLS}`);
    assert.equal(s.logs.length, 1);
    assert.match(s.logs[0], /would call Mom \(\+15550000001\)/);
    assert.match(s.logs[0], /Test message/);
  }
});

test('not live never touches the network even with the default Twilio dialer', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network touched'); };
  try {
    const s = spies();
    const config = readConfig(fullEnv);
    const result = await createCaller({ config, log: s.log, logError: s.logError })(request(config));
    assert.deepEqual(result, { ok: true, dialed: false });
    assert.equal(s.errors.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('with ECHO_CALLS=live the call is dialed to Contact #1 with spoken TwiML', async () => {
  const s = spies();
  const config = readConfig({ ...fullEnv, ECHO_CALLS: 'live' });
  const result = await createCaller({ config, dial: s.dial, log: s.log, logError: s.logError })(request(config));
  assert.deepEqual(result, { ok: true, dialed: true, sid: 'CA1' });
  assert.deepEqual(s.dialed, [{ to: '+15550000001', twiml: sayTwiml('Test message') }]);
});

test('live with missing Twilio settings or number logs an error and does not dial', async () => {
  for (const missing of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'CONTACT1_NUMBER']) {
    const s = spies();
    const config = readConfig({ ...fullEnv, ECHO_CALLS: 'live', [missing]: '' });
    const result = await createCaller({ config, dial: s.dial, log: s.log, logError: s.logError })(request(config));
    assert.equal(result.ok, false, 'missing settings count as a failure so the ladder retries');
    assert.equal(result.dialed, false);
    assert.equal(s.dialed.length, 0, `${missing} missing`);
    assert.equal(s.errors.length, 1);
    assert.match(s.errors[0], new RegExp(missing));
  }
});

test('a failed dial is logged, not thrown', async () => {
  const s = spies();
  const config = readConfig({ ...fullEnv, ECHO_CALLS: 'live' });
  const dial = async () => { throw new Error('Twilio answered 401'); };
  const result = await createCaller({ config, dial, log: s.log, logError: s.logError })(request(config));
  assert.equal(result.ok, false);
  assert.equal(result.dialed, false);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /failed: Twilio answered 401/);
});

test('twilioDialer posts to the Calls resource with basic auth and form fields', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify({ sid: 'CA9' }), { status: 201 });
  };
  const dial = twilioDialer({ accountSid: 'AC123', authToken: 'tok', from: '+15550000000' }, { fetchFn });
  assert.deepEqual(await dial({ to: '+15550000001', twiml: '<Response/>' }), { sid: 'CA9' });
  assert.equal(seen[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json');
  assert.equal(seen[0].opts.method, 'POST');
  assert.equal(seen[0].opts.headers.Authorization, `Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  const form = new URLSearchParams(seen[0].opts.body);
  assert.equal(form.get('To'), '+15550000001');
  assert.equal(form.get('From'), '+15550000000');
  assert.equal(form.get('Twiml'), '<Response/>');
});

test('twilioDialer throws on a non-2xx answer', async () => {
  const fetchFn = async () => new Response('{"message":"bad"}', { status: 400 });
  const dial = twilioDialer({ accountSid: 'AC123', authToken: 'tok', from: '+1' }, { fetchFn });
  await assert.rejects(dial({ to: '+2', twiml: '<Response/>' }), /Twilio answered 400/);
});

test('sayTwiml escapes XML', () => {
  assert.equal(sayTwiml('a < b & "c"'), '<Response><Say loop="2">a &lt; b &amp; &quot;c&quot;</Say></Response>');
});

test('readConfig takes Twilio credentials and Contact #1 from the environment', () => {
  const config = readConfig(fullEnv);
  assert.deepEqual(config.twilio, { accountSid: 'AC123', authToken: 'tok', from: '+15550000000' });
  assert.deepEqual(config.contacts[0], { name: 'Mom', number: '+15550000001' });
});

test('loadEnv reads a .env file without overriding variables already set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, 'ECHO_TEST_FROM_FILE=file\nECHO_TEST_PRESET=file\n');
  process.env.ECHO_TEST_PRESET = 'shell';
  try {
    assert.equal(loadEnv(file, { log: () => {} }), true);
    assert.equal(process.env.ECHO_TEST_FROM_FILE, 'file');
    assert.equal(process.env.ECHO_TEST_PRESET, 'shell', 'shell value wins, so ECHO_CALLS=off on the command line holds');
  } finally {
    delete process.env.ECHO_TEST_FROM_FILE;
    delete process.env.ECHO_TEST_PRESET;
    rmSync(dir, { recursive: true });
  }
});

test('loadEnv with no file logs and does not throw', () => {
  const logs = [];
  assert.equal(loadEnv('/nonexistent/echo/.env', { log: (m) => logs.push(m) }), false);
  assert.equal(logs.length, 1);
});

const REQUIRED = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'CONTACT1_NUMBER'];
const secretEnv = {
  TWILIO_ACCOUNT_SID: 'ACsecretsid999', TWILIO_AUTH_TOKEN: 'supersecrettoken777',
  TWILIO_FROM_NUMBER: '+15557770001', CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15557770002',
};
const secretValues = Object.values(secretEnv).filter((v) => v !== 'Mom');

test('startup: live with all settings present says calls will be dialed', () => {
  const config = readConfig({ ...secretEnv, ECHO_CALLS: 'live' });
  assert.deepEqual(missingCallSettings(config), []);
  const msg = callsStartupMessage(config);
  assert.equal(msg.ok, true);
  assert.equal(msg.level, 'info');
  assert.match(msg.text, /WILL be dialed/);
  for (const v of secretValues) assert.ok(!msg.text.includes(v), 'no values in output');
});

test('startup: live with each setting missing or blank names it, without values, and never says WILL be dialed', () => {
  for (const name of REQUIRED) {
    for (const blank of [undefined, '', '   ']) {
      const env = { ...secretEnv, ECHO_CALLS: 'live', [name]: blank };
      const config = readConfig(env);
      assert.deepEqual(missingCallSettings(config), [name]);
      const msg = callsStartupMessage(config);
      assert.equal(msg.ok, false);
      assert.equal(msg.level, 'error');
      assert.match(msg.text, new RegExp(name));
      assert.doesNotMatch(msg.text, /WILL be dialed/);
      for (const v of secretValues) assert.ok(!msg.text.includes(v), `value leaked with ${name} missing`);
    }
  }
});

test('startup: live with nothing set names every required key', () => {
  const msg = callsStartupMessage(readConfig({ ECHO_CALLS: 'live' }));
  assert.equal(msg.ok, false);
  for (const name of REQUIRED) assert.match(msg.text, new RegExp(name));
});

test('startup: not live is info and does not require settings', () => {
  for (const env of [{}, { ECHO_CALLS: 'off' }, { ...secretEnv }]) {
    const msg = callsStartupMessage(readConfig(env));
    assert.equal(msg.ok, true);
    assert.equal(msg.level, 'info');
    assert.match(msg.text, /only logged/);
    assert.doesNotMatch(msg.text, /WILL be dialed/);
  }
});
