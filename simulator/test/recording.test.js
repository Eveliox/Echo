import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateStatus, STATES } from '../../server/status.js';
import { statusLines } from '../replay.js';
import { DEFAULT_RECORDING } from '../smoke.js';

// The level rules come from the firmware's own constants, not copies.
// Only a plain numeric literal ending the statement counts (`= 30000UL;`,
// `= 95.0f;`); anything else, like `30 * 1000UL` or `30e3`, throws instead of
// being misread.
function parseConstant(source, name) {
  const m = source.match(new RegExp(`\\b${name}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)[fFuUlL]*\\s*;`));
  if (!m) throw new Error(`${name}: no plain numeric literal assignment found in logic.h`);
  return Number(m[1]);
}
const logic = readFileSync(new URL('../../firmware/mega/logic.h', import.meta.url), 'utf8');
const constant = (name) => parseConstant(logic, name);
const OCCUPANT_AFTER_MS = constant('OCCUPANT_AFTER_MS');
const STATUS_PERIOD_MS = constant('STATUS_PERIOD_MS');
const WARNING_TEMP_F = constant('WARNING_TEMP_F');
const EMERGENCY_TEMP_F = constant('EMERGENCY_TEMP_F');
const MINS_TO_DANGER_SAMPLES = constant('MINS_TO_DANGER_SAMPLES');
const DANGER_TEMP_F = constant('DANGER_TEMP_F');
const MIN_WARMING_RATE_F_PER_MIN = constant('MIN_WARMING_RATE_F_PER_MIN');
const WARNING_MINS = constant('WARNING_MINS');
const EMERGENCY_MINS = constant('EMERGENCY_MINS');

// docs/firmware.md "Minutes to danger", as the box does it: a least-squares
// line through the last MINS_TO_DANGER_SAMPLES readings (one per status, so
// one per line, from the first line on), rounded to 0.1 minute. null below
// the minimum warming rate or before the window is full; 0 at or above the
// danger temperature. This test only checks the recording; the box's own math
// is tested in firmware/mega/test/logic_test.cpp.
function expectedMinsToDanger(temps, i) {
  const current = temps[i];
  if (current >= DANGER_TEMP_F) return 0;
  if (i + 1 < MINS_TO_DANGER_SAMPLES) return null;
  const window = temps.slice(i + 1 - MINS_TO_DANGER_SAMPLES, i + 1);
  const xs = window.map((_, j) => (j * STATUS_PERIOD_MS) / 60_000);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mx = mean(xs);
  const my = mean(window);
  let sxy = 0;
  let sxx = 0;
  xs.forEach((x, j) => { sxy += (x - mx) * (window[j] - my); sxx += (x - mx) ** 2; });
  const rate = sxy / sxx;
  if (!(rate >= MIN_WARMING_RATE_F_PER_MIN)) return null;
  return Math.floor(((DANGER_TEMP_F - current) / rate) * 10 + 0.5) / 10;
}

const lines = statusLines(readFileSync(DEFAULT_RECORDING, 'utf8'));
const statuses = lines.map((line) => JSON.parse(line));
const rank = (s) => STATES.indexOf(s.state);
const firstOf = (state) => statuses.findIndex((s) => s.state === state);
const temps = statuses.map((s) => s.tempF);

test('every line is a status the server accepts, as the box sends it today', () => {
  assert.ok(statuses.length > 0);
  statuses.forEach((s, i) => {
    assert.equal(validateStatus(s), null, `line ${i + 1}: ${lines[i]}`);
    assert.deepEqual(Object.keys(s), ['state', 'tempF', 'presence', 'distanceCm', 'minsToDanger'],
      `line ${i + 1}: exactly the box's fields, in order`);
    assert.equal(s.minsToDanger, expectedMinsToDanger(temps, i), `line ${i + 1}: minsToDanger`);
  });
});

test('minsToDanger is null or >= 0, null for the first 2 minutes, and 0 at or above the danger temperature', () => {
  statuses.forEach((s, i) => {
    assert.ok(s.minsToDanger === null || s.minsToDanger >= 0, `line ${i + 1}`);
    if (s.tempF >= DANGER_TEMP_F) assert.equal(s.minsToDanger, 0, `line ${i + 1}`);
    else if (i + 1 < MINS_TO_DANGER_SAMPLES) assert.equal(s.minsToDanger, null, `line ${i + 1}`);
  });
  // The recording exercises real numbers, not only null and 0.
  assert.ok(statuses.some((s) => s.minsToDanger > 0));
});

test('the minutes-to-danger check follows the doc with literal values', () => {
  // Pinned to docs/firmware.md, so the parsed constants can't drift unnoticed.
  assert.equal(MINS_TO_DANGER_SAMPLES, 60);
  assert.equal(DANGER_TEMP_F, 104);
  assert.equal(MIN_WARMING_RATE_F_PER_MIN, 0.05);
  assert.equal(WARNING_MINS, 10);
  assert.equal(EMERGENCY_MINS, 5);
  // 3 F per minute ending at 85.9 F: (104 - 85.9) / 3 = 6.03, sent as 6.0.
  const ramp = Array.from({ length: 60 }, (_, j) => 80 + j * 0.1);
  assert.equal(expectedMinsToDanger(ramp, 59), 6);
  assert.equal(expectedMinsToDanger(ramp, 58), null, 'one sample short of 2 minutes');
  assert.equal(expectedMinsToDanger(Array(60).fill(90), 59), null, 'flat');
  assert.equal(expectedMinsToDanger(Array.from({ length: 60 }, (_, j) => 90 + j * 0.04 / 30), 59), null, '0.04 F/min');
  assert.equal(expectedMinsToDanger([104], 0), 0, 'at the danger temperature, even with one sample');
});

test('levels never drop and climb IDLE, ARMED, OCCUPANT, WARNING, EMERGENCY in order', () => {
  for (let i = 1; i < statuses.length; i++) {
    assert.ok(rank(statuses[i]) >= rank(statuses[i - 1]), `level dropped at line ${i + 1}`);
  }
  assert.deepEqual([...new Set(statuses.map((s) => s.state))], STATES);
  assert.equal(statuses[0].state, 'IDLE');
});

test('OCCUPANT comes only after the seat has been occupied for the hold time', () => {
  const occupant = firstOf('OCCUPANT');
  let firstPresent = occupant;
  while (firstPresent > 0 && statuses[firstPresent - 1].presence) firstPresent--;
  assert.ok(statuses.slice(0, firstPresent).every((s) => !s.presence));
  assert.ok((occupant - firstPresent) * STATUS_PERIOD_MS >= OCCUPANT_AFTER_MS,
    `seat occupied for ${occupant - firstPresent} statuses before OCCUPANT`);
  assert.ok(statuses.slice(firstPresent).every((s) => s.presence), 'the seat stays occupied');
});

test('WARNING and EMERGENCY start on the first condition met: temperature or minutes to danger', () => {
  const known = (m) => m !== null && m >= 0;
  const warns = (s) => s.tempF >= WARNING_TEMP_F || (known(s.minsToDanger) && s.minsToDanger <= WARNING_MINS);
  const emergency = (s) => s.tempF >= EMERGENCY_TEMP_F || (known(s.minsToDanger) && s.minsToDanger <= EMERGENCY_MINS);
  const occupant = firstOf('OCCUPANT');
  const firstFrom = (pred) => occupant + statuses.slice(occupant).findIndex(pred);
  assert.equal(firstOf('WARNING'), firstFrom((s) => warns(s) || emergency(s)));
  assert.equal(firstOf('EMERGENCY'), firstFrom(emergency));
  // In this recording the minutes come first, below both temperatures.
  assert.ok(statuses[firstOf('WARNING')].tempF < WARNING_TEMP_F);
  assert.ok(statuses[firstOf('EMERGENCY')].tempF < EMERGENCY_TEMP_F);
});

test('it ends in EMERGENCY held for several statuses, so the ladder dedup is exercised', () => {
  const emergency = firstOf('EMERGENCY');
  assert.ok(statuses.length - emergency >= 3);
  assert.ok(statuses.slice(emergency).every((s) => s.state === 'EMERGENCY'));
});

test('the logic.h constant parser reads plain literals and rejects anything else', () => {
  const src = (rhs) => `static const uint32_t X = ${rhs};`;
  assert.equal(parseConstant(src('30000UL'), 'X'), 30000);
  assert.equal(parseConstant(src('2000UL'), 'X'), 2000);
  assert.equal(parseConstant(src('95.0f'), 'X'), 95);
  assert.equal(parseConstant(src('104.0f'), 'X'), 104);
  assert.equal(parseConstant(src('7'), 'X'), 7);
  for (const rhs of ['30 * 1000UL', '30e3', '30e3f', '0x7530', 'X_OTHER', '30000UL + 1']) {
    assert.throws(() => parseConstant(src(rhs), 'X'), /X: no plain numeric literal/, rhs);
  }
  assert.throws(() => parseConstant(src('5'), 'MISSING'), /MISSING/);
  assert.throws(() => parseConstant('static const float XY = 5.0f;', 'X'), /X:/, 'whole names only');
});
