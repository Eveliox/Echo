import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, validateStatus, OFFLINE_AFTER_MS, STATES } from '../status.js';

// The example from docs/firmware.md.
const valid = () => ({
  state: 'WARNING', tempF: 96.4, presence: true, distanceCm: 38, minsToDanger: 7.5,
});

// The exact line the oldest firmware (with the DHT11) sends, until the Mega is re-flashed.
const OLD_FIRMWARE_LINE =
  '{"state":"WARNING","tempF":96.4,"humidity":41,"presence":true,"distanceCm":38,"motion":false,"minsToDanger":7.5,"battery":88}';
// The firmware after the DHT11 removal: no humidity, still motion and battery.
const NO_HUMIDITY_FIRMWARE_LINE =
  '{"state":"WARNING","tempF":96.4,"presence":true,"distanceCm":38,"motion":null,"minsToDanger":7.5,"battery":null}';
// The same reading from the current firmware: no humidity, motion, or battery.
const NEW_FIRMWARE_LINE =
  '{"state":"WARNING","tempF":96.4,"presence":true,"distanceCm":38,"minsToDanger":7.5}';

test('accepts the documented status', () => {
  assert.equal(validateStatus(valid()), null);
});

test('accepts a new-firmware status with no humidity, motion, or battery field', () => {
  assert.equal(validateStatus(JSON.parse(NEW_FIRMWARE_LINE)), null);
  for (const field of ['humidity', 'motion', 'battery', 'light']) {
    assert.ok(!(field in JSON.parse(NEW_FIRMWARE_LINE)), field);
  }
});

test('accepts an older-firmware status that still sends motion and battery', () => {
  assert.equal(validateStatus(JSON.parse(NO_HUMIDITY_FIRMWARE_LINE)), null);
});

test('accepts an old-firmware status that still sends a numeric humidity', () => {
  assert.equal(validateStatus(JSON.parse(OLD_FIRMWARE_LINE)), null);
  assert.equal(validateStatus({ ...valid(), humidity: 0 }), null, 'old firmware placeholder');
});

test('ignores any legacy humidity value instead of rejecting the status', () => {
  for (const humidity of [null, '41', true, -5, 1000, {}, []]) {
    assert.equal(validateStatus({ ...valid(), humidity }), null, `humidity=${JSON.stringify(humidity)}`);
  }
});

// motion, battery, and light are no longer fields: any value an old box (or a
// box with a stray sensor) sends is ignored, never a reason to reject.
test('ignores any legacy motion, battery, or light value instead of rejecting the status', () => {
  for (const field of ['motion', 'battery', 'light']) {
    for (const value of [null, false, true, 0, 88, 812, -5, '41', {}, []]) {
      assert.equal(validateStatus({ ...valid(), [field]: value }), null, `${field}=${JSON.stringify(value)}`);
    }
  }
  assert.equal(validateStatus({
    ...valid(), humidity: 41, motion: false, battery: 88, light: 812,
  }), null, 'all legacy fields at once');
});

test('accepts every alert level', () => {
  for (const state of STATES) assert.equal(validateStatus({ ...valid(), state }), null);
});

test('accepts null minsToDanger', () => {
  assert.equal(validateStatus({ ...valid(), minsToDanger: null }), null);
});

test('rejects non-objects', () => {
  for (const body of [null, 42, 'WARNING', [], true]) assert.notEqual(validateStatus(body), null);
});

test('rejects an unknown state', () => {
  assert.notEqual(validateStatus({ ...valid(), state: 'warning' }), null);
  assert.notEqual(validateStatus({ ...valid(), state: 'PANIC' }), null);
});

test('rejects each missing required field', () => {
  for (const field of Object.keys(valid())) {
    const body = valid();
    delete body[field];
    assert.notEqual(validateStatus(body), null, `missing ${field} should be rejected`);
  }
});

test('rejects wrong types', () => {
  const bad = {
    tempF: '96.4', presence: 'yes', distanceCm: null, minsToDanger: '7.5',
  };
  for (const [field, value] of Object.entries(bad)) {
    assert.notEqual(validateStatus({ ...valid(), [field]: value }), null, `${field}=${JSON.stringify(value)}`);
  }
});

test('tracker is offline with no status yet', () => {
  const tracker = createTracker({ now: () => 0 });
  assert.deepEqual(tracker.snapshot(), { online: false, lastSeen: null, status: null });
});

test('tracker goes offline after the silence window and online on the next message', () => {
  assert.equal(OFFLINE_AFTER_MS, 10_000, 'silence window from docs/firmware.md');
  let t = 1_000;
  const tracker = createTracker({ now: () => t });
  const first = valid();
  tracker.update(first);
  assert.equal(tracker.isOnline(), true);

  t += OFFLINE_AFTER_MS - 1;
  assert.equal(tracker.isOnline(), true);

  t += 1;
  assert.equal(tracker.isOnline(), false);
  assert.equal(tracker.snapshot().status, first, 'latest status is kept while offline');

  const second = { ...valid(), state: 'EMERGENCY' };
  tracker.update(second);
  assert.deepEqual(tracker.snapshot(), { online: true, lastSeen: t, status: second });
});

test('tracker calls onStatus listeners with each new status', () => {
  const tracker = createTracker({ now: () => 0 });
  const seen = [];
  tracker.onStatus((s) => seen.push(s.state));
  tracker.update({ ...valid(), state: 'OCCUPANT' });
  tracker.update({ ...valid(), state: 'WARNING' });
  assert.deepEqual(seen, ['OCCUPANT', 'WARNING']);
});

test('a listener that throws is logged and does not stop the update or later listeners', () => {
  const errors = [];
  const tracker = createTracker({ now: () => 0, logError: (...a) => errors.push(a) });
  const seen = [];
  tracker.onStatus(() => { throw new Error('boom'); });
  tracker.onStatus((s) => seen.push(s.state));
  assert.doesNotThrow(() => tracker.update({ ...valid(), state: 'EMERGENCY' }));
  assert.equal(tracker.snapshot().status.state, 'EMERGENCY');
  assert.deepEqual(seen, ['EMERGENCY']);
  assert.equal(errors.length, 1);
});

test('a listener that rejects is logged, not left as an unhandled rejection', async () => {
  const errors = [];
  const tracker = createTracker({ now: () => 0, logError: (...a) => errors.push(a) });
  tracker.onStatus(async () => { throw new Error('async boom'); });
  tracker.update(valid());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /async boom/);
});
