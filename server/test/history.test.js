import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createTracker } from '../status.js';
import {
  createHistory, createStatusLog, logDir, logLine, DEFAULT_LOG_DIR,
  HISTORY_WINDOW_MS, HISTORY_MAX_ENTRIES,
} from '../history.js';
import { replay, statusLines } from '../../simulator/replay.js';

// Every log in these tests goes to a temp folder, never server/logs/.
const tmp = mkdtempSync(join(tmpdir(), 'echo-history-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const status = (overrides = {}) => ({
  state: 'OCCUPANT', tempF: 88.2, presence: true, distanceCm: 30,
  minsToDanger: null, ...overrides,
});

// Starts `server` on a random port; returns its base URL and a closer.
async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

const post = async (base, body) => {
  const res = await fetch(`${base}/status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  await res.body?.cancel();
  return res.status;
};

test('history keeps statuses under 10 minutes old, oldest first, dropping them at exactly 10 minutes', () => {
  assert.equal(HISTORY_WINDOW_MS, 600_000);
  let t = 1_000;
  const history = createHistory({ now: () => t });
  history.add(status({ tempF: 1 }));
  t = 2_000;
  history.add(status({ tempF: 2 }));
  assert.deepEqual(history.entries().map((e) => [e.receivedAt, e.status.tempF]), [[1_000, 1], [2_000, 2]]);

  t = 1_000 + HISTORY_WINDOW_MS - 1;
  assert.deepEqual(history.entries().map((e) => e.status.tempF), [1, 2], 'one ms short of 10 minutes: kept');
  t = 1_000 + HISTORY_WINDOW_MS;
  assert.deepEqual(history.entries().map((e) => e.status.tempF), [2], 'exactly 10 minutes old: dropped');
  t = 2_000 + HISTORY_WINDOW_MS;
  assert.deepEqual(history.entries(), []);
});

test('history stays bounded when statuses arrive faster than expected', () => {
  const t = 5_000;
  const history = createHistory({ now: () => t });
  for (let i = 0; i < HISTORY_MAX_ENTRIES + 250; i++) history.add(status({ tempF: i }));
  const entries = history.entries();
  assert.equal(entries.length, HISTORY_MAX_ENTRIES);
  assert.equal(entries[0].status.tempF, 250, 'the oldest are dropped');
  assert.equal(entries.at(-1).status.tempF, HISTORY_MAX_ENTRIES + 249);
});

test('GET /history serves accepted statuses with receive time; rejected ones are not kept', async () => {
  let t = 10_000;
  const now = () => t;
  const { base, close } = await start(createServer({
    tracker: createTracker({ now }), history: createHistory({ now }),
  }));
  try {
    assert.deepEqual(await (await fetch(`${base}/history`)).json(), { entries: [] });
    assert.equal(await post(base, status()), 200);
    t = 12_000;
    assert.equal(await post(base, status({ state: 'PANIC' })), 400);
    assert.equal(await post(base, 'not json'), 400);
    assert.equal(await post(base, status({ state: 'WARNING', tempF: 96.4, minsToDanger: 7.5 })), 200);
    assert.deepEqual(await (await fetch(`${base}/history`)).json(), {
      entries: [
        { receivedAt: 10_000, status: status() },
        { receivedAt: 12_000, status: status({ state: 'WARNING', tempF: 96.4, minsToDanger: 7.5 }) },
      ],
    });
    t = 12_000 + HISTORY_WINDOW_MS;
    assert.deepEqual(await (await fetch(`${base}/history`)).json(), { entries: [] });
    const res = await fetch(`${base}/history`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 405);
    await res.body?.cancel();
  } finally {
    await close();
  }
});

test('log folder: ECHO_LOG_DIR overrides; unset or empty is server/logs/', () => {
  assert.match(DEFAULT_LOG_DIR, /[\\/]server[\\/]logs[\\/]?$/);
  assert.equal(logDir({}), DEFAULT_LOG_DIR);
  assert.equal(logDir({ ECHO_LOG_DIR: '' }), DEFAULT_LOG_DIR);
  assert.equal(logDir({ ECHO_LOG_DIR: tmp }), tmp);
});

test('a body with a line break inside is accepted and logged as one compact JSON line', () => {
  const pretty = JSON.stringify(status(), null, 2);
  assert.equal(logLine(pretty, JSON.parse(pretty)), JSON.stringify(status()));
  assert.equal(logLine(`{"a":1,\r"b":2}`, { a: 1, b: 2 }), '{"a":1,"b":2}');
  // A trailing newline (or \r\n) is only trimmed; the box's bytes are kept.
  assert.equal(logLine('{ "a" : 1.50 }\r\n', { a: 1.5 }), '{ "a" : 1.50 }');
});

test('accepted statuses are logged as "# <ISO time>" + the body as received, and the log replays unchanged', async () => {
  const dirA = join(tmp, 'a', 'not-yet-created');
  const dirB = join(tmp, 'b');
  let t = Date.parse('2026-10-10T20:00:00.000Z');
  const now = () => t;
  const logA = createStatusLog({ dir: dirA, now });
  const historyA = createHistory({ now });
  const a = await start(createServer({ tracker: createTracker({ now }), history: historyA, statusLog: logA }));
  const historyB = createHistory();
  const logB = createStatusLog({ dir: dirB });
  const b = await start(createServer({ history: historyB, statusLog: logB }));
  try {
    // The box's own bytes: odd spacing and number formatting, a Serial line ending.
    // raw[0] is from the old firmware (still sends humidity, which is ignored but
    // logged as received); raw[1] is the new format without humidity.
    const raw = [
      '{"state":"IDLE","tempF":80.40,"humidity":41,"presence":false,"distanceCm":62,"motion":null,"minsToDanger":null,"battery":null}\r\n',
      '{ "state": "WARNING", "tempF": 96.4, "light": 812, "presence": true, "distanceCm": 38, "motion": false, "minsToDanger": 7.5, "battery": 88 }',
    ];
    const pretty = JSON.stringify(status({ state: 'EMERGENCY', tempF: 104.5, minsToDanger: 0 }), null, 2);
    assert.equal(await post(a.base, raw[0]), 200);
    t += 2_000;
    assert.equal(await post(a.base, status({ state: 'PANIC' })), 400); // rejected: not logged
    assert.equal(await post(a.base, '{"state":"WARNING"'), 400);
    assert.equal(await post(a.base, raw[1]), 200);
    t += 2_000;
    assert.equal(await post(a.base, pretty), 200);
    await logA.flush();

    assert.deepEqual(readdirSync(dirA), [logA.file.slice(dirA.length + 1)], 'one file, in the created folder');
    assert.match(logA.file, /status-2026-10-10T20-00-00-000Z-\d+\.jsonl$/);
    const expected = [raw[0].trim(), raw[1], JSON.stringify(JSON.parse(pretty))];
    assert.equal(readFileSync(logA.file, 'utf8'), [
      '# 2026-10-10T20:00:00.000Z', expected[0],
      '# 2026-10-10T20:00:02.000Z', expected[1],
      '# 2026-10-10T20:00:04.000Z', expected[2],
    ].join('\n') + '\n');

    // Replay the log through simulator/replay.js into a second server.
    const lines = statusLines(readFileSync(logA.file, 'utf8'));
    assert.deepEqual(lines, expected, 'replay posts exactly the logged bytes');
    assert.equal(await replay(lines, { url: `${b.base}/status`, intervalMs: 0 }), 3);
    await logB.flush();
    assert.deepEqual(historyB.entries().map((e) => e.status), historyA.entries().map((e) => e.status));
    assert.deepEqual(statusLines(readFileSync(logB.file, 'utf8')), expected, 'the replayed log logs the same lines');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('a failing or stuck log writer never blocks the reply or the ladder, and is reported once per burst', async () => {
  const errors = [];
  let mode = 'fail';
  const appended = [];
  const append = async (file, text) => {
    if (mode === 'fail') throw new Error('disk full');
    if (mode === 'stuck') return new Promise(() => {});
    appended.push(text);
  };
  const statusLog = createStatusLog({
    dir: join(tmp, 'never-written'), append, makeDir: async () => {}, logError: (...a) => errors.push(a.join(' ')),
  });
  const ladderSaw = [];
  const tracker = createTracker();
  tracker.onStatus((s) => { ladderSaw.push(s.state); });
  const { base, close } = await start(createServer({ tracker, statusLog }));
  try {
    for (const state of ['WARNING', 'EMERGENCY', 'EMERGENCY']) assert.equal(await post(base, status({ state })), 200);
    await statusLog.flush();
    assert.deepEqual(ladderSaw, ['WARNING', 'EMERGENCY', 'EMERGENCY'], 'the ladder listener ran for every status');
    assert.equal(errors.length, 1, 'one report for the burst');
    assert.match(errors[0], /status log: write to .* failed: disk full/);

    mode = 'ok';
    assert.equal(await post(base, status({ state: 'ARMED' })), 200);
    await statusLog.flush();
    assert.equal(appended.length, 1, 'writes recover after the burst');
    mode = 'fail';
    assert.equal(await post(base, status({ state: 'ARMED' })), 200);
    await statusLog.flush();
    assert.equal(errors.length, 2, 'a new burst is reported again');

    mode = 'stuck';
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/status`, {
        method: 'POST', body: JSON.stringify(status({ state: 'EMERGENCY' })), signal: AbortSignal.timeout(2000),
      });
      assert.equal(res.status, 200, 'a hung disk does not hold the reply');
      await res.body?.cancel();
    }
    assert.equal(ladderSaw.length, 8);
  } finally {
    await close();
  }
});
