import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker, validateStatus, OFFLINE_AFTER_MS, STATES } from '../status.js';

// The example from docs/firmware.md, minus `light` (pending; the Mega won't send it yet).
const valid = () => ({
  state: 'WARNING', tempF: 96.4, humidity: 41, presence: true, distanceCm: 38,
  motion: false, minsToDanger: 7.5, battery: 88,
});

test('accepts the documented status without light', () => {
  assert.equal(validateStatus(valid()), null);
});

test('accepts light when present', () => {
  assert.equal(validateStatus({ ...valid(), light: 812 }), null);
});

test('accepts every alert level', () => {
  for (const state of STATES) assert.equal(validateStatus({ ...valid(), state }), null);
});

test('accepts null motion, minsToDanger, and battery', () => {
  assert.equal(validateStatus({ ...valid(), motion: null, minsToDanger: null, battery: null }), null);
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
    tempF: '96.4', humidity: null, presence: 'yes', distanceCm: null,
    motion: 0, minsToDanger: '7.5', battery: true, light: null,
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
