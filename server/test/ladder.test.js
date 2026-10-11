import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLadder, emergencyMessage } from '../ladder.js';

const contacts = [{ name: 'Mom', number: '+15550000001' }];

const status = (state, overrides = {}) => ({
  state, tempF: 104.5, presence: true, distanceCm: 30,
  minsToDanger: 0, ...overrides,
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

// ---- Steps 2-4 on timers, retries, and the action log (fake clock, no real waiting).

import {
  STEP2_AFTER_MS, STEP3_AFTER_MS, STEP4_AFTER_MS, RETRY_AFTER_MS, MAX_TIMER_RETRIES, realTimers,
} from '../ladder.js';
import { createActionLog } from '../actions.js';
import { createFakeClock } from './fake-clock.js';

const two = [{ name: 'Mom', number: '+15550000001' }, { name: 'Alex', number: '+15550000002' }];

// `outcome(c)` decides each call's result; returning undefined leaves it in flight.
function timed({ contactList = two, outcome = () => ({ ok: true, dialed: false }) } = {}) {
  const clock = createFakeClock();
  const actions = createActionLog({ now: clock.now });
  const calls = [];
  const logs = [];
  const call = (c) => {
    calls.push({ ...c, at: clock.now() });
    const result = outcome(c, calls.length);
    return result === undefined ? new Promise(() => {}) : Promise.resolve(result);
  };
  const ladder = createLadder({
    contacts: contactList, call, timers: clock.timers, actions, log: (m) => logs.push(m),
  });
  return { clock, actions, calls, logs, ladder };
}
const who = (calls) => calls.map((c) => `${c.contact.name}@${c.at - Date.parse('2026-10-10T20:00:00.000Z')}`);

test('step offsets are 2, 3 and 5 minutes; the step-1 retry is well under 2 minutes', () => {
  assert.equal(STEP2_AFTER_MS, 120_000);
  assert.equal(STEP3_AFTER_MS, 180_000);
  assert.equal(STEP4_AFTER_MS, 300_000);
  assert.equal(RETRY_AFTER_MS, 20_000);
  assert.equal(MAX_TIMER_RETRIES, 4);
});

test('with the box silent after one EMERGENCY, steps 2-4 fire exactly at 2, 3 and 5 minutes', async () => {
  const { clock, calls, ladder } = timed();
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(119_999);
  assert.deepEqual(who(calls), ['Mom@0'], 'nothing before 2 minutes');
  await clock.advance(1);
  assert.deepEqual(who(calls), ['Mom@0', 'Mom@120000'], 'step 2 re-calls Contact #1');
  assert.equal(calls[1].reason, 'emergency, ladder step 2');
  await clock.advance(59_999);
  assert.equal(calls.length, 2);
  await clock.advance(1);
  assert.deepEqual(who(calls).slice(2), ['Alex@180000'], 'step 3 calls Contact #2');
  await clock.advance(119_999);
  assert.equal(calls.length, 3);
  await clock.advance(1);
  assert.deepEqual(who(calls).slice(3), ['Mom@300000', 'Alex@300000'], 'step 4 calls everyone');
  assert.ok(calls.slice(3).every((c) => c.reason === 'emergency, ladder step 4'));
  await clock.advance(60 * 60_000);
  assert.equal(calls.length, 5, 'nothing after step 4');
  assert.equal(ladder.inIncident(), true, 'silence never ends the incident');
  assert.equal(clock.pending(), 0);
});

test('later EMERGENCY statuses do not move the schedule; steps use the latest values as sent', async () => {
  const { clock, calls, ladder } = timed();
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(90_000);
  ladder.onStatus(status('EMERGENCY', { tempF: 106.1, minsToDanger: null }));
  await clock.advance(30_000);
  assert.deepEqual(who(calls), ['Mom@0', 'Mom@120000']);
  assert.match(calls[1].message, /106\.1 degrees/);
});

test('only a valid non-EMERGENCY status stops the schedule, and it clears every timer', async () => {
  for (const state of ['IDLE', 'ARMED', 'OCCUPANT', 'WARNING']) {
    const { clock, calls, ladder } = timed({ outcome: () => ({ ok: false, dialed: false }) });
    ladder.onStatus(status('EMERGENCY'));
    await clock.advance(150_000);
    const before = calls.length;
    ladder.onStatus(status(state));
    assert.equal(clock.pending(), 0, `${state}: all timers cleared`);
    await clock.advance(60 * 60_000);
    assert.equal(calls.length, before, `${state}: nothing fires after the incident ends`);
  }
});

test('a failed step 1 is retried on the timer while the box is silent, and stops once placed', async () => {
  const { clock, calls, ladder } = timed({ outcome: (c, n) => (n < 3 ? { ok: false, dialed: false } : { ok: true, dialed: true, sid: 'CA3' }) });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(RETRY_AFTER_MS - 1);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.deepEqual(who(calls), ['Mom@0', `Mom@${RETRY_AFTER_MS}`]);
  await clock.advance(RETRY_AFTER_MS);
  assert.equal(calls.length, 3);
  assert.equal(ladder.incident().step1.status, 'placed');
  await clock.advance(STEP2_AFTER_MS - 2 * RETRY_AFTER_MS - 1);
  assert.equal(calls.length, 3, 'no more step-1 retries once placed');
  await clock.advance(1);
  assert.deepEqual(who(calls).slice(3), ['Mom@120000'], 'step 2 still fires at its time');
});

test('timer retries are bounded per call; step 1 is still retried on each EMERGENCY status', async () => {
  const { clock, calls, ladder } = timed({ outcome: () => ({ ok: false, dialed: false }) });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(STEP2_AFTER_MS - 1);
  assert.equal(calls.length, 1 + MAX_TIMER_RETRIES);
  calls.forEach((c, i) => assert.equal(c.at - calls[0].at, i * RETRY_AFTER_MS));
  ladder.onStatus(status('EMERGENCY'));
  assert.equal(calls.length, 2 + MAX_TIMER_RETRIES, 'status retry is not capped (as before)');
});

test('a timed step dials on time even while a dial to the same contact is in flight; a retry never overlaps', async () => {
  const clock = createFakeClock();
  const calls = [];
  const pending = [];
  // The first call fails; later ones stay in flight until the test resolves them.
  const call = (c) => {
    calls.push({ ...c, at: clock.now() });
    if (calls.length === 1) return Promise.resolve({ ok: false, dialed: false });
    return new Promise((resolve) => pending.push(resolve));
  };
  const ladder2 = createLadder({ contacts: two, call, timers: clock.timers, log: () => {} });
  ladder2.onStatus(status('EMERGENCY'));
  await clock.advance(STEP2_AFTER_MS - 10_000); // step-1 retry is in flight
  assert.equal(calls.length, 2);
  assert.equal(ladder2.incident().step1.status, 'dialing');
  await clock.advance(10_000);
  assert.deepEqual(who(calls).slice(2), ['Mom@120000'], 'step 2 is not delayed by the step-1 dial in flight');

  pending[0]({ ok: false, dialed: false }); // step-1 retry fails while step 2 still dials Mom
  await clock.advance(0);
  ladder2.onStatus(status('EMERGENCY'));
  await clock.advance(RETRY_AFTER_MS);
  assert.equal(calls.filter((c) => c.reason === 'emergency, ladder step 1').length, 2,
    'no step-1 retry while step 2 is dialing Mom');
  pending[1]({ ok: true, dialed: true, sid: 'CA9' }); // step 2 placed
  await clock.advance(RETRY_AFTER_MS);
  assert.equal(calls.filter((c) => c.reason === 'emergency, ladder step 1').length, 3, 'retried once Mom is free');
});

test('a step that never finishes does not delay later steps', async () => {
  const { clock, calls, ladder } = timed({
    outcome: (c) => (c.reason.endsWith('2') ? undefined : { ok: true, dialed: true, sid: 'CA' }),
  });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(STEP4_AFTER_MS);
  assert.deepEqual(who(calls), ['Mom@0', 'Mom@120000', 'Alex@180000', 'Mom@300000', 'Alex@300000']);
});

test('a failing step 3 is retried, bounded, and step 4 still fires on time', async () => {
  const { clock, calls, ladder } = timed({
    outcome: (c) => (c.contact.name === 'Alex' ? { ok: false, dialed: false, error: new Error('x') } : { ok: true, dialed: true, sid: 'CA' }),
  });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(60 * 60_000);
  const step3 = calls.filter((c) => c.reason === 'emergency, ladder step 3');
  assert.equal(step3.length, 1 + MAX_TIMER_RETRIES);
  assert.equal(step3[0].at - calls[0].at, STEP3_AFTER_MS);
  const step4 = calls.filter((c) => c.reason === 'emergency, ladder step 4');
  assert.ok(step4.every((c) => c.at - calls[0].at === STEP4_AFTER_MS || c.contact.name === 'Alex'));
  assert.deepEqual(step4.filter((c) => c.contact.name === 'Mom').map((c) => c.at - calls[0].at), [STEP4_AFTER_MS]);
});

test('action log: { time, action, to, reason } per call, names only, values as sent, not-live said so', async () => {
  const { clock, actions, ladder } = timed();
  ladder.onStatus(status('EMERGENCY', { tempF: 104.5, minsToDanger: 0 }));
  await clock.advance(STEP4_AFTER_MS);
  const entries = actions.entries();
  assert.equal(entries.length, 5);
  for (const e of entries) {
    assert.deepEqual(Object.keys(e), ['time', 'action', 'to', 'reason']);
    assert.equal(e.action, 'call');
    assert.match(e.reason, /tempF 104\.5, minsToDanger 0/);
    assert.match(e.reason, /not live: ECHO_CALLS is not "live"/);
  }
  assert.deepEqual(entries.map((e) => [e.time, e.to]), [
    ['2026-10-10T20:00:00.000Z', 'Mom'],
    ['2026-10-10T20:02:00.000Z', 'Mom'],
    ['2026-10-10T20:03:00.000Z', 'Alex'],
    ['2026-10-10T20:05:00.000Z', 'Mom'],
    ['2026-10-10T20:05:00.000Z', 'Alex'],
  ]);
  assert.match(entries[2].reason, /^ladder step 3:/);
  const text = JSON.stringify(entries);
  for (const c of two) assert.ok(!text.includes(c.number), 'no numbers in the action log');
});

test('action log: placed calls have no not-live note; failures are call_failed without error text', async () => {
  const { clock, actions, ladder } = timed({
    outcome: (c, n) => {
      if (n === 1) return { ok: false, dialed: false, error: new Error('Twilio says +15550000001 is bad') };
      if (n === 2) return { ok: false, dialed: false };
      return { ok: true, dialed: true, sid: 'CA1' };
    },
  });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(2 * RETRY_AFTER_MS);
  const [first, second, third] = actions.entries();
  assert.equal(first.action, 'call_failed');
  assert.match(first.reason, /dial failed .*attempt 1, retrying in/);
  assert.equal(second.action, 'call_failed');
  assert.match(second.reason, /call settings are missing/);
  assert.equal(third.action, 'call');
  assert.doesNotMatch(third.reason, /not live/);
  assert.ok(!JSON.stringify(actions.entries()).includes('+1555'), 'error text with a number never reaches the log');
});

test('a missing Contact #2 skips step 3 (logged with the reason) without touching steps 2 and 4', async () => {
  for (const contactList of [[two[0], { name: 'Contact #2', number: '' }], [two[0]]]) {
    const { clock, actions, calls, logs, ladder } = timed({ contactList });
    ladder.onStatus(status('EMERGENCY'));
    await clock.advance(STEP4_AFTER_MS);
    assert.deepEqual(who(calls), ['Mom@0', 'Mom@120000', 'Mom@300000']);
    const skips = actions.entries().filter((e) => e.action === 'skip');
    assert.equal(skips[0].to, 'Contact #2');
    assert.equal(skips[0].time, '2026-10-10T20:03:00.000Z');
    assert.match(skips[0].reason, /^ladder step 3: .*CONTACT2_NUMBER is not set/);
    assert.ok(logs.some((m) => /step 3 skipped.*CONTACT2_NUMBER/.test(m)), 'skip is logged to the console');
  }
});

test('an in-flight call that finishes after the incident ended is logged but never retried', async () => {
  let resolveFirst;
  const clock = createFakeClock();
  const actions = createActionLog({ now: clock.now });
  let n = 0;
  const ladder = createLadder({
    contacts: two,
    call: () => { n += 1; return n === 1 ? new Promise((r) => { resolveFirst = r; }) : Promise.resolve({ ok: true, dialed: true }); },
    timers: clock.timers,
    actions,
    log: () => {},
  });
  ladder.onStatus(status('EMERGENCY'));
  ladder.onStatus(status('ARMED'));
  resolveFirst({ ok: false, dialed: false });
  await clock.advance(60 * 60_000);
  assert.equal(n, 1);
  assert.equal(actions.entries().length, 1);
  assert.equal(clock.pending(), 0);
});

test('real ladder timers are unref\'d, so a pending step never keeps a process alive', () => {
  const t = realTimers.setTimeout(() => assert.fail('must not fire'), STEP4_AFTER_MS);
  assert.equal(t.hasRef(), false);
  realTimers.clearTimeout(t);
});

test('step-1 retries on statuses do not use up its timer retries before the box goes silent', async () => {
  const { clock, calls, ladder } = timed({ outcome: () => ({ ok: false, dialed: false }) });
  for (let i = 0; i < 5; i++) { // statuses every 2 s, before the first retry timer is due
    ladder.onStatus(status('EMERGENCY'));
    await clock.advance(2_000);
  }
  const before = calls.length;
  assert.equal(before, 5, 'one retry per EMERGENCY status');
  await clock.advance(STEP2_AFTER_MS - 10_000 - 1); // box silent, step 2 not yet due
  assert.equal(calls.length - before, MAX_TIMER_RETRIES, 'timer retries still run once the box is silent');
});

// ---- A throw on a timer-driven path is reported and stops nothing else.

function crashSetup({ contactList, actionThrows, logThrows = false, outcome }) {
  const clock = createFakeClock();
  const base = createActionLog({ now: clock.now });
  const actions = {
    record(entry) {
      if (actionThrows(entry)) throw new Error(`record boom for ${entry.to}`);
      return base.record(entry);
    },
    entries: base.entries,
  };
  const calls = [];
  const errors = [];
  const ladder = createLadder({
    contacts: contactList,
    call: (c) => { calls.push({ ...c, at: clock.now() }); return Promise.resolve(outcome(c)); },
    timers: clock.timers,
    actions,
    log: () => { if (logThrows) throw new Error('log boom'); },
    logError: (...a) => errors.push(a.join(' ')),
  });
  return { clock, calls, errors, ladder, base };
}

test('sync and async throws inside timed steps are reported; other contacts and later steps still dial on time', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const contactList = [
      { name: 'Mom', number: '+15550000001' },
      { name: 'Alex', number: '+15550000002' }, // every call fails
      { name: 'Contact #3', number: '' }, // skipped, and the skip's log throws (sync)
      { name: 'Dan', number: '+15550000004' },
    ];
    const { clock, calls, errors, ladder } = crashSetup({
      contactList,
      // Recording Mom's outcome or any failure throws inside the call's promise (async).
      actionThrows: (e) => e.to === 'Mom' || e.action === 'call_failed',
      logThrows: true,
      outcome: (c) => (c.contact.name === 'Alex' ? { ok: false, dialed: false, error: new Error('x') } : { ok: true, dialed: true, sid: 'CA' }),
    });
    ladder.onStatus(status('EMERGENCY')).catch(() => {}); // the tracker catches this path in the server
    await clock.advance(10 * 60_000);

    const at = (name, step) => calls.filter((c) => c.contact.name === name && c.reason === `emergency, ladder step ${step}`)
      .map((c) => c.at - calls[0].at);
    assert.deepEqual(at('Mom', 2), [STEP2_AFTER_MS]);
    assert.equal(at('Alex', 3)[0], STEP3_AFTER_MS);
    assert.equal(at('Alex', 3).length, 1 + MAX_TIMER_RETRIES, 'timer retries go on after their outcome failed to record');
    assert.deepEqual(at('Mom', 4), [STEP4_AFTER_MS]);
    assert.equal(at('Alex', 4)[0], STEP4_AFTER_MS);
    assert.deepEqual(at('Dan', 4), [STEP4_AFTER_MS], 'the contact after the throwing skip still dials on time');

    assert.deepEqual(unhandled, [], 'no unhandled rejections');
    const text = errors.join('\n');
    assert.match(text, /ladder: step 2 call to Mom failed unexpectedly: record boom for Mom/);
    assert.match(text, /ladder: step 3 call to Alex failed unexpectedly: record boom for Alex/);
    assert.match(text, /ladder: step 3 retry to Alex failed unexpectedly: record boom for Alex/);
    assert.match(text, /ladder: step 4 for contact #3 failed unexpectedly: log boom/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a throw in a timer callback outside any one contact is reported, not thrown, and earlier steps are unaffected', async () => {
  const contactList = [{ name: 'Mom', number: '+15550000001' }, { name: 'Alex', number: '+15550000002' }];
  contactList.map = () => { throw new Error('targets boom'); }; // only step 4 maps over the list
  const { clock, calls, errors, ladder } = crashSetup({
    contactList, actionThrows: () => false, outcome: () => ({ ok: true, dialed: false }),
  });
  ladder.onStatus(status('EMERGENCY'));
  await assert.doesNotReject(clock.advance(10 * 60_000));
  assert.deepEqual(who(calls), ['Mom@0', 'Mom@120000', 'Alex@180000']);
  assert.match(errors.join('\n'), /ladder: step 4 failed unexpectedly: targets boom/);
  assert.equal(ladder.inIncident(), true);
});

test('a status-driven step-1 retry still dials on every status but logs its failures once', async () => {
  const { clock, calls, actions, ladder } = timed({ outcome: () => ({ ok: false, dialed: false }) });
  ladder.onStatus(status('EMERGENCY'));
  for (let i = 0; i < 8; i++) {
    await clock.advance(2_000); // before the first timer retry is due
    ladder.onStatus(status('EMERGENCY'));
  }
  assert.equal(calls.length, 9, 'every status retries');
  assert.deepEqual(calls.map((c) => c.quiet), [false, false, true, true, true, true, true, true, true],
    'the caller is told to stay quiet after the first status-retry failure');
  const failed = actions.entries().filter((e) => e.action === 'call_failed');
  assert.equal(failed.length, 2, 'the first attempt and the first status retry only');
  assert.match(failed[1].reason, /attempt 2.*retried on every EMERGENCY status.*not logged again/);
  await clock.advance(RETRY_AFTER_MS); // a timer retry is still recorded
  assert.equal(actions.entries().filter((e) => e.action === 'call_failed').length, 3);
});

// ---- Status-retry failures that aren't logged one by one are counted in a summary.

import { QUIET_SUMMARY_AFTER_MS } from '../ladder.js';

// Like timed(), with the ladder on the fake clock's `now` too, and a call
// outcome per attempt number. Counts step-1 dials and failures.
function counted(outcome) {
  const clock = createFakeClock();
  const actions = createActionLog({ now: clock.now });
  const step1 = { dials: 0, failed: 0 };
  const errors = [];
  const ladder = createLadder({
    contacts: two,
    call: (c) => {
      const result = outcome(c);
      if (c.reason === 'emergency, ladder step 1') {
        step1.dials += 1;
        if (!result.ok) step1.failed += 1;
      }
      return Promise.resolve(result);
    },
    timers: clock.timers,
    actions,
    log: () => {},
    logError: (...a) => errors.push(a.join(' ')),
    now: clock.now,
  });
  return { clock, actions, step1, errors, ladder };
}
const summaries = (actions) => actions.entries().filter((e) => /status retr(y|ies) failed since/.test(e.reason));
const summed = (e) => Number(/: (\d+) status retr/.exec(e.reason)[1]);

test('summary interval is pinned', () => {
  assert.equal(QUIET_SUMMARY_AFTER_MS, 300_000);
});

test('step 1 succeeding after unlogged status-retry failures records a summary with the exact count, then the call', async () => {
  let fail = true;
  const { clock, actions, errors, ladder } = counted(() => (fail ? { ok: false, dialed: false } : { ok: true, dialed: true, sid: 'CA' }));
  ladder.onStatus(status('EMERGENCY')); // attempt 1: logged
  await clock.advance(2_000);
  ladder.onStatus(status('EMERGENCY')); // attempt 2: first status retry, logged with the note
  for (let i = 0; i < 5; i++) { // attempts 3-7: not logged one by one
    await clock.advance(2_000);
    ladder.onStatus(status('EMERGENCY'));
  }
  assert.equal(summaries(actions).length, 0, 'no summary while the burst goes on');
  fail = false;
  await clock.advance(2_000);
  ladder.onStatus(status('EMERGENCY')); // attempt 8 succeeds
  await clock.advance(0);
  const entries = actions.entries();
  const [summary] = summaries(actions);
  assert.deepEqual(Object.keys(summary), ['time', 'action', 'to', 'reason']);
  assert.equal(summary.action, 'call_failed');
  assert.equal(summary.to, 'Mom');
  assert.equal(summary.reason, 'ladder step 1: 5 status retries failed since 2026-10-10T20:00:04.000Z (not logged one by one)');
  assert.equal(entries.at(-1).action, 'call', 'the success is recorded after the summary');
  assert.deepEqual(entries.slice(-2).map((e) => e.action), ['call_failed', 'call']);
  assert.equal(errors.filter((m) => m.includes('5 status retries failed since')).length, 1, 'mirrored to the console once');
});

test('a valid non-EMERGENCY status after unlogged failures records the summary with the exact count', async () => {
  const { clock, actions, errors, ladder } = counted(() => ({ ok: false, dialed: false }));
  for (let i = 0; i < 6; i++) { // attempt 1 and the first status retry are logged; 4 are not
    ladder.onStatus(status('EMERGENCY'));
    await clock.advance(2_000);
  }
  assert.equal(summaries(actions).length, 0);
  ladder.onStatus(status('ARMED'));
  const all = summaries(actions);
  assert.equal(all.length, 1);
  assert.equal(all[0].reason, 'ladder step 1: 4 status retries failed since 2026-10-10T20:00:04.000Z (not logged one by one)');
  assert.equal(errors.filter((m) => m.includes('4 status retries failed since')).length, 1);
  assert.equal(clock.pending(), 0);
});

test('no unlogged failures, no summary', async () => {
  const { clock, actions, ladder } = counted(() => ({ ok: false, dialed: false }));
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(2_000);
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(2_000);
  ladder.onStatus(status('ARMED'));
  assert.equal(summaries(actions).length, 0);
  assert.equal(actions.entries().length, 2);
});

test('10 minutes of failing calls with a status every 2 s: every failed step-1 dial is accounted for, steps 2-4 survive, the log stays small', async () => {
  const { clock, actions, step1, ladder } = counted(() => ({ ok: false, dialed: false, error: new Error('x') }));
  for (let t = 0; t < 10 * 60_000; t += 2_000) {
    ladder.onStatus(status('EMERGENCY'));
    await clock.advance(2_000);
  }
  assert.deepEqual(summaries(actions).map((e) => e.time), ['2026-10-10T20:05:04.000Z'],
    'a long burst is summed up every QUIET_SUMMARY_AFTER_MS, not only at the end');
  ladder.onStatus(status('ARMED'));
  assert.ok(step1.failed >= 300, `the status retry kept dialing (${step1.failed})`);
  assert.equal(step1.failed, step1.dials);

  const entries = actions.entries();
  const step1Entries = entries.filter((e) => e.reason.startsWith('ladder step 1:'));
  const recorded = step1Entries.reduce((sum, e) => sum + (/status retr(y|ies) failed since/.test(e.reason) ? summed(e) : 1), 0);
  assert.equal(recorded, step1.failed, 'individual entries plus summary counts equal the failed step-1 dials');
  assert.ok(step1Entries.length <= 10, `step-1 entries: ${step1Entries.length}`);
  assert.ok(entries.length <= 40, `whole log: ${entries.length}`);
  for (const [to, step] of [['Mom', 2], ['Alex', 3], ['Mom', 4], ['Alex', 4]]) {
    assert.ok(entries.some((e) => e.to === to && e.reason.startsWith(`ladder step ${step}:`)), `step ${step} for ${to} survives`);
  }
});

test('an unlogged failure that finishes after the incident ended is still summed up', async () => {
  const pending = [];
  const clock = createFakeClock();
  const actions = createActionLog({ now: clock.now });
  let n = 0;
  const ladder = createLadder({
    contacts: two,
    call: () => {
      n += 1;
      if (n <= 2) return Promise.resolve({ ok: false, dialed: false });
      return new Promise((resolve) => pending.push(resolve));
    },
    timers: clock.timers, actions, log: () => {}, logError: () => {}, now: clock.now,
  });
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(2_000);
  ladder.onStatus(status('EMERGENCY'));
  await clock.advance(2_000);
  ladder.onStatus(status('EMERGENCY')); // attempt 3: unlogged, still in flight
  ladder.onStatus(status('ARMED'));
  pending[0]({ ok: false, dialed: false });
  await clock.advance(0);
  const all = summaries(actions);
  assert.equal(all.length, 1);
  assert.match(all[0].reason, /^ladder step 1: 1 status retry failed since /);
  assert.equal(clock.pending(), 0);
});
