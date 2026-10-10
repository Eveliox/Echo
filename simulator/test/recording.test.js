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

const lines = statusLines(readFileSync(DEFAULT_RECORDING, 'utf8'));
const statuses = lines.map((line) => JSON.parse(line));
const rank = (s) => STATES.indexOf(s.state);
const firstOf = (state) => statuses.findIndex((s) => s.state === state);

test('every line is a status the server accepts, as the box sends it today', () => {
  assert.ok(statuses.length > 0);
  statuses.forEach((s, i) => {
    assert.equal(validateStatus(s), null, `line ${i + 1}: ${lines[i]}`);
    assert.ok(!('light' in s), `line ${i + 1}: light is pending, the box does not send it`);
    assert.equal(s.motion, null, `line ${i + 1}`);
    assert.equal(s.battery, null, `line ${i + 1}`);
    assert.equal(s.minsToDanger, null, `line ${i + 1}`);
  });
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

test('WARNING and EMERGENCY start at their temperatures (minsToDanger is null)', () => {
  const warning = firstOf('WARNING');
  const emergency = firstOf('EMERGENCY');
  assert.ok(statuses.slice(0, warning).every((s) => s.tempF < WARNING_TEMP_F));
  assert.ok(statuses[warning].tempF >= WARNING_TEMP_F);
  assert.ok(statuses.slice(0, emergency).every((s) => s.tempF < EMERGENCY_TEMP_F));
  assert.ok(statuses[emergency].tempF >= EMERGENCY_TEMP_F);
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
