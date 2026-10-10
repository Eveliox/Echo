import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionLog, ACTIONS_MAX_ENTRIES } from '../actions.js';

test('records { time, action, to, reason } with an ISO time, oldest first', () => {
  let t = Date.parse('2026-10-10T20:00:00.000Z');
  const log = createActionLog({ now: () => t });
  log.record({ action: 'call', to: 'Mom', reason: 'r1' });
  t += 1500;
  log.record({ action: 'skip', to: 'Contact #2', reason: 'r2', number: '+15550000002' });
  assert.deepEqual(log.entries(), [
    { time: '2026-10-10T20:00:00.000Z', action: 'call', to: 'Mom', reason: 'r1' },
    { time: '2026-10-10T20:00:01.500Z', action: 'skip', to: 'Contact #2', reason: 'r2' },
  ], 'only the four fields, nothing extra');
});

test('is bounded: the oldest entries drop past the cap; entries() are copies', () => {
  assert.ok(ACTIONS_MAX_ENTRIES > 0 && ACTIONS_MAX_ENTRIES <= 1000);
  const log = createActionLog({ now: () => 0, maxEntries: 3 });
  for (let i = 1; i <= 5; i++) log.record({ action: 'call', to: `C${i}`, reason: '' });
  assert.deepEqual(log.entries().map((e) => e.to), ['C3', 'C4', 'C5']);
  log.entries()[0].to = 'changed';
  assert.equal(log.entries()[0].to, 'C3');
  const big = createActionLog({ now: () => 0 });
  for (let i = 0; i < ACTIONS_MAX_ENTRIES + 50; i++) big.record({ action: 'call', to: 'x', reason: '' });
  assert.equal(big.entries().length, ACTIONS_MAX_ENTRIES);
});
