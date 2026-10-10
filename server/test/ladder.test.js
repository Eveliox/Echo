import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLadder, emergencyMessage } from '../ladder.js';

const contacts = [{ name: 'Mom', number: '+15550000001' }];

const status = (state, overrides = {}) => ({
  state, tempF: 104.5, humidity: 40, presence: true, distanceCm: 30,
  motion: null, minsToDanger: 0, battery: null, ...overrides,
});

function setup() {
  const calls = [];
  const ladder = createLadder({ contacts, call: (c) => { calls.push(c); return Promise.resolve({ ok: true, dialed: true, sid: 'CA1' }); } });
  const feed = (...states) => states.forEach((s) => ladder.onStatus(typeof s === 'string' ? status(s) : s));
  return { ladder, calls, feed };
}

test('first EMERGENCY calls Contact #1 exactly once; repeats do not call again', () => {
  const { ladder, calls, feed } = setup();
  feed('ARMED', 'OCCUPANT', 'WARNING');
  assert.equal(calls.length, 0, 'no call before EMERGENCY');
  feed('EMERGENCY');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contact, contacts[0]);
  assert.equal(ladder.inIncident(), true);
  feed('EMERGENCY', 'EMERGENCY', 'EMERGENCY');
  assert.equal(calls.length, 1, 'repeated EMERGENCY statuses place no more calls');
});

test('a non-EMERGENCY status ends the incident; a later EMERGENCY is a new incident', () => {
  const { ladder, calls, feed } = setup();
  feed('EMERGENCY', 'EMERGENCY', 'ARMED'); // cancel button
  assert.equal(ladder.inIncident(), false);
  feed('EMERGENCY', 'EMERGENCY');
  assert.equal(calls.length, 2);
  feed('IDLE', 'EMERGENCY'); // ignition, then a new emergency
  assert.equal(calls.length, 3);
});

test('the message uses tempF and minsToDanger exactly as the box sent them', () => {
  const { calls, feed } = setup();
  feed(status('EMERGENCY', { tempF: 101.3, minsToDanger: 2.1 }));
  assert.match(calls[0].message, /101\.3 degrees/);
  assert.match(calls[0].message, /Danger in about 2\.1 minutes/);
});

test('message wording for null, 0, and 1 minsToDanger', () => {
  const nullMsg = emergencyMessage({ tempF: 99.2, minsToDanger: null });
  assert.match(nullMsg, /99\.2 degrees/);
  assert.doesNotMatch(nullMsg, /null|minute/);
  assert.match(nullMsg, /Go to the car now\./);

  assert.match(emergencyMessage({ tempF: 104, minsToDanger: 0 }), /already at the danger level/);
  assert.match(emergencyMessage({ tempF: 103, minsToDanger: 1 }), /about 1 minute\./);
});

// A call() whose results the test resolves by hand, one per attempt.
function manualCall() {
  const attempts = [];
  const call = (c) => new Promise((resolve) => attempts.push({ c, resolve }));
  return { attempts, call };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a failed placement is retried on the next EMERGENCY; after success no more calls', async () => {
  const { attempts, call } = manualCall();
  const ladder = createLadder({ contacts, call });
  ladder.onStatus(status('EMERGENCY'));
  assert.equal(attempts.length, 1);
  attempts[0].resolve({ ok: false, dialed: false });
  await settle();
  assert.equal(ladder.incident().step1.status, 'failed');

  ladder.onStatus(status('EMERGENCY'));
  assert.equal(attempts.length, 2, 'retried on the next EMERGENCY of the same incident');
  attempts[1].resolve({ ok: true, dialed: true, sid: 'CA2' });
  await settle();
  assert.deepEqual(ladder.incident(), { step1: { status: 'placed', attempts: 2, sid: 'CA2' } });

  for (let i = 0; i < 5; i++) ladder.onStatus(status('EMERGENCY'));
  await settle();
  assert.equal(attempts.length, 2, 'exactly 2 dial attempts, then no more');
});

test('while a dial is in flight, more EMERGENCY statuses do not start another', async () => {
  const { attempts, call } = manualCall();
  const ladder = createLadder({ contacts, call });
  for (let i = 0; i < 5; i++) ladder.onStatus(status('EMERGENCY'));
  await settle();
  assert.equal(attempts.length, 1, 'no overlapping calls');
  assert.equal(ladder.incident().step1.status, 'dialing');
  attempts[0].resolve({ ok: true, dialed: true, sid: 'CA1' });
  await settle();
  ladder.onStatus(status('EMERGENCY'));
  assert.equal(attempts.length, 1);
});

test('a call that rejects or throws counts as failed and is retried, never thrown', async () => {
  let n = 0;
  const ladder = createLadder({
    contacts,
    call: () => {
      n += 1;
      if (n === 1) throw new Error('sync boom');
      if (n === 2) return Promise.reject(new Error('async boom'));
      return Promise.resolve({ ok: true, dialed: true, sid: 'CA3' });
    },
  });
  await assert.doesNotReject(ladder.onStatus(status('EMERGENCY')));
  assert.equal(ladder.incident().step1.status, 'failed');
  await assert.doesNotReject(ladder.onStatus(status('EMERGENCY')));
  assert.equal(ladder.incident().step1.status, 'failed');
  await ladder.onStatus(status('EMERGENCY'));
  assert.deepEqual(ladder.incident(), { step1: { status: 'placed', attempts: 3, sid: 'CA3' } });
});

test('not live: the "would call" log counts as done, once per incident', async () => {
  const { attempts, call } = manualCall();
  const ladder = createLadder({ contacts, call });
  ladder.onStatus(status('EMERGENCY'));
  attempts[0].resolve({ ok: true, dialed: false });
  await settle();
  assert.equal(ladder.incident().step1.status, 'logged');
  for (let i = 0; i < 5; i++) ladder.onStatus(status('EMERGENCY'));
  assert.equal(attempts.length, 1);

  ladder.onStatus(status('ARMED'));
  assert.equal(ladder.incident(), null);
  ladder.onStatus(status('EMERGENCY'));
  assert.equal(attempts.length, 2, 'a new incident logs again');
});
