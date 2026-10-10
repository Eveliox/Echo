import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boxTokenStartupMessage, createRejectionLog, readBoxToken, REJECT_LOG_INTERVAL_MS, tokenMatches,
} from '../auth.js';
import { createFakeClock } from './fake-clock.js';

const TOKEN = 'box-token-7f3a9c';

test('readBoxToken: unset, empty, or whitespace-only is off; the value is trimmed', () => {
  for (const value of [undefined, '', '   ', '\t\n']) {
    assert.equal(readBoxToken({ ECHO_BOX_TOKEN: value }), '', JSON.stringify(value));
  }
  assert.equal(readBoxToken({}), '');
  assert.equal(readBoxToken({ ECHO_BOX_TOKEN: ` ${TOKEN} ` }), TOKEN);
});

test('tokenMatches is true only for the exact token, and never throws on other lengths', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  const wrong = ['', 'x', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), ` ${TOKEN}`, 'y'.repeat(10_000), 'é'];
  for (const received of wrong) {
    assert.doesNotThrow(() => tokenMatches(TOKEN, received), JSON.stringify(received));
    assert.equal(tokenMatches(TOKEN, received), false, JSON.stringify(received));
  }
  for (const received of [undefined, null, 42, [TOKEN]]) assert.equal(tokenMatches(TOKEN, received), false);
  assert.equal(tokenMatches('', ''), false, 'an empty expected token never matches');
});

test('startup message says on, or warns loudly when off; never the token', () => {
  const on = boxTokenStartupMessage(TOKEN);
  assert.equal(on.level, 'info');
  assert.match(on.text, /^box token auth: on\b/);
  assert.ok(!on.text.includes(TOKEN));
  const off = boxTokenStartupMessage('');
  assert.equal(off.level, 'warn');
  assert.match(off.text, /^WARNING: box token auth is OFF\b/);
  assert.match(off.text, /ECHO_BOX_TOKEN/);
});

test('rejection log: first line at once, then at most one line per interval with the count', async () => {
  const clock = createFakeClock();
  const lines = [];
  const rejections = createRejectionLog({ log: (m) => lines.push(m), now: clock.now, timers: clock.timers });
  rejections.reject();
  assert.deepEqual(lines, ['rejected 1 status posts: bad or missing token']);

  for (let i = 0; i < 4; i++) {
    await clock.advance(1_000);
    rejections.reject();
  }
  assert.equal(lines.length, 1, 'no new line inside the interval');
  await clock.advance(REJECT_LOG_INTERVAL_MS);
  assert.deepEqual(lines.slice(1), ['rejected 4 status posts: bad or missing token']);
  assert.equal(clock.pending(), 0);

  await clock.advance(REJECT_LOG_INTERVAL_MS * 5); // quiet: no line, no timer
  assert.equal(lines.length, 2);
  rejections.reject();
  assert.deepEqual(lines.slice(2), ['rejected 1 status posts: bad or missing token']);
  assert.equal(rejections.total(), 6);
});

test('the "on" startup message says the box must send the header (ticket #17) or gets 401', () => {
  const { text } = boxTokenStartupMessage(TOKEN);
  assert.match(text, /X-Echo-Token/);
  assert.match(text, /#17/);
  assert.match(text, /401/);
  assert.ok(!text.includes(TOKEN));
});
