import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { statusLines, replay, parseArgs, BOX_INTERVAL_MS } from '../replay.js';

// A stub server that records each POST body and its arrival time, and answers
// with `nextCodes` (then 200).
const received = [];
let nextCodes = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ body, at: Date.now() });
    res.writeHead(nextCodes.shift() ?? 200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
});
let url;
before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  url = `http://127.0.0.1:${server.address().port}/status`;
  resolve();
})));
after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

test('statusLines keeps only lines starting with { and trims Serial line endings', () => {
  const text = '# seat baseline failed\r\n{"a":1}\r\n\r\nboot noise\n  {"b":2}  \n#x\n';
  assert.deepEqual(statusLines(text), ['{"a":1}', '{"b":2}']);
});

test('replay posts each line as-is, in order, at the given pace', async () => {
  received.length = 0;
  const lines = ['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'];
  const posted = [];
  const start = Date.now();
  const count = await replay(lines, { url, intervalMs: 50, onPost: (i) => posted.push(i) });
  assert.equal(count, 4);
  assert.deepEqual(received.map((r) => r.body), lines);
  assert.deepEqual(posted, [0, 1, 2, 3]);
  // Paced from the start (no drift), so post i arrives no earlier than i intervals in.
  for (let i = 1; i < received.length; i++) {
    assert.ok(received[i].at - start >= i * 50 - 2, `post ${i + 1} came too early`);
  }
  assert.ok(received.at(-1).at - start < 3 * 50 + 1000, 'replay ran far slower than its pace');
});

test('replay stops at the first non-2xx answer', async () => {
  received.length = 0;
  nextCodes = [200, 400];
  await assert.rejects(
    replay(['{"n":1}', '{"n":2}', '{"n":3}'], { url, intervalMs: 0 }),
    /line 2 of 3: server answered 400/,
  );
  assert.equal(received.length, 2);
});

test('replay rejects when the server is unreachable', async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(replay(['{"n":1}'], { url: `http://127.0.0.1:${port}/status`, intervalMs: 0 }));
});

test('CLI requires --url, defaults to the box pace; --interval-ms overrides', () => {
  assert.equal(BOX_INTERVAL_MS, 2000);
  assert.throws(() => parseArgs(['rec.jsonl']), /--url is required/);
  assert.deepEqual(parseArgs(['rec.jsonl', '--url', 'http://x/status']),
    { file: 'rec.jsonl', url: 'http://x/status', intervalMs: 2000 });
  assert.deepEqual(parseArgs(['--interval-ms', '20', 'rec.jsonl', '--url', 'http://x/status']),
    { file: 'rec.jsonl', url: 'http://x/status', intervalMs: 20 });
  for (const bad of [[], ['--interval-ms', 'fast', 'r'], ['r', 'extra'], ['--bogus', 'r'], ['r', '--url']]) {
    assert.throws(() => parseArgs(bad), undefined, bad.join(' '));
  }
});

test('replay() without a url rejects before posting', async () => {
  received.length = 0;
  await assert.rejects(replay(['{"n":1}'], { intervalMs: 0 }), /needs a url/);
  assert.equal(received.length, 0);
});

test('the CLI without --url exits non-zero with the usage and posts nothing', () => {
  received.length = 0;
  // A path that doesn't exist: if a default URL ever comes back, this run fails
  // on the missing file instead of posting a real EMERGENCY recording to it.
  const recording = fileURLToPath(new URL('../recordings/does-not-exist.jsonl', import.meta.url));
  const replayJs = fileURLToPath(new URL('../replay.js', import.meta.url));
  const run = spawnSync(process.execPath, [replayJs, recording, '--interval-ms', '0'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: .*--url URL/);
  assert.match(run.stderr, /--url is required/);
  assert.doesNotMatch(run.stdout, /replay: \d/, 'nothing was posted');
});
