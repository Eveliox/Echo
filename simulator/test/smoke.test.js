import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, refuseReason } from '../smoke.js';

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
