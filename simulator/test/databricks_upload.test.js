import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validName, loadConfig, fileUrl, request, existsInVolume, putFile, planDir, newestStatusLog, copyLatest,
  parseArgs, main, runJob, stableItems, DEFAULT_VOLUME_PATH, FRESH_LOG_MS,
} from '../databricks_upload.js';

// No network here: fetch is always a stub, files live in a fresh temp folder.

const TOKEN = 'dapiTESTTOKEN0123456789abcdef';
const HOST = 'https://dbc-test.cloud.databricks.com';
const env = (extra = {}) => ({ DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: TOKEN, ...extra });
const config = () => loadConfig(env());

// Stub fetch: `handler(url, init)` returns a status or { status, json }.
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const r = handler(url, init, calls.length);
    if (r instanceof Error) throw r;
    const { status, json } = typeof r === 'number' ? { status: r } : r;
    const noBody = init.method === 'HEAD' || status === 204 || status === 304;
    return new Response(noBody ? null : JSON.stringify(json ?? {}), { status });
  };
  fn.calls = calls;
  return fn;
}

function capture() {
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.lines = lines;
  return log;
}

const fast = (extra = {}) => ({ delays: [1, 1, 1], sleep: async () => {}, log: capture(), ...extra });

function tempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-dbx-test-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const LOG_TEXT = '# 2026-10-10T18:00:00.000Z\n{"tempF":80}\n';

test('upload names: real-/sim- .jsonl only', () => {
  for (const ok of ['real-2026-10-11-mug1.jsonl', 'sim-2026-10-10-joystick.jsonl', 'real-a_b.c.jsonl']) {
    assert.equal(validName(ok), true, ok);
  }
  for (const bad of [
    'status-2026-10-10T18-00-00-123.jsonl', 'spoiled-2026-10-10.jsonl', 'real-x.json', 'real-.jsonl',
    'dir/real-x.jsonl', '../real-x.jsonl', 'real-../x.jsonl', 'real-a..b.jsonl', 'real-my run.jsonl',
    'real-x.jsonl/', 'REAL-x.jsonl', 'real\\x.jsonl', 'real-x.jsonl\n', '', null, undefined,
  ]) {
    assert.equal(validName(bad), false, String(bad));
  }
});

test('config: https host, /Volumes/ path, default volume, job id', () => {
  const c = loadConfig(env({ DATABRICKS_HOST: `${HOST}/`, DATABRICKS_JOB_ID: '42' }));
  assert.deepEqual(c, { host: HOST, token: TOKEN, volumePath: DEFAULT_VOLUME_PATH, jobId: '42' });
  assert.equal(loadConfig(env({ DATABRICKS_VOLUME_PATH: '/Volumes/a/b/c/logs/' })).volumePath, '/Volumes/a/b/c/logs');
  assert.throws(() => loadConfig(env({ DATABRICKS_HOST: 'http://dbc-test.cloud.databricks.com' })), /https/);
  assert.throws(() => loadConfig(env({ DATABRICKS_HOST: `${HOST}/api` })), /https/);
  assert.throws(() => loadConfig(env({ DATABRICKS_HOST: 'not a url' })), /not a URL/);
  assert.throws(() => loadConfig(env({ DATABRICKS_HOST: '' })), /DATABRICKS_HOST/);
  for (const v of ['/dbfs/x/y/z', 'Volumes/a/b/c', '/Volumes/a/b', '/Volumes/a/../c', '/Volumes/a/b/c d']) {
    assert.throws(() => loadConfig(env({ DATABRICKS_VOLUME_PATH: v })), /\/Volumes\//, v);
  }
  assert.throws(() => loadConfig(env({ DATABRICKS_TOKEN: '' })), /DATABRICKS_TOKEN/);
  assert.equal(loadConfig(env({ DATABRICKS_TOKEN: '' }), { needToken: false }).token, '');
  assert.throws(() => loadConfig(env({ DATABRICKS_JOB_ID: 'abc' })), /JOB_ID/);
  const err = (() => { try { loadConfig(env({ DATABRICKS_TOKEN: `${TOKEN} x` })); } catch (e) { return e; } })();
  assert.ok(err && !err.message.includes(TOKEN));
});

test('file URL: Files API path, segments encoded, bad names refused', () => {
  assert.equal(fileUrl(config(), 'real-2026-10-11-mug1.jsonl'),
    `${HOST}/api/2.0/fs/files/Volumes/workspace/default/echo_logs/real-2026-10-11-mug1.jsonl`);
  assert.throws(() => fileUrl(config(), '../real-x.jsonl'), /refusing/);
  assert.throws(() => fileUrl(config(), 'real-x%2F.jsonl'), /refusing/);
  assert.ok(!fileUrl(config(), 'real-x.jsonl').includes(TOKEN));
});

test('HEAD found -> exists; 404 -> missing; token only in the Authorization header', async () => {
  const fetchFn = stubFetch((url) => (url.endsWith('there.jsonl') ? 200 : 404));
  assert.equal(await existsInVolume(config(), 'real-there.jsonl', { ...fast(), fetchFn }), true);
  assert.equal(await existsInVolume(config(), 'real-gone.jsonl', { ...fast(), fetchFn }), false);
  for (const c of fetchFn.calls) {
    assert.equal(c.method, 'HEAD');
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!c.url.includes(TOKEN));
  }
});

test('PUT sends the raw file with overwrite=false; 409 counts as already there', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch(() => 204);
    assert.equal(await putFile(config(), join(dir, 'real-a.jsonl'), 'real-a.jsonl', { ...fast(), fetchFn }), 'uploaded');
    const c = fetchFn.calls[0];
    assert.equal(c.method, 'PUT');
    assert.equal(c.url, `${fileUrl(config(), 'real-a.jsonl')}?overwrite=false`);
    assert.equal(c.headers['Content-Type'], 'application/octet-stream');
    assert.equal(Buffer.from(c.body).toString('utf8'), LOG_TEXT);
    assert.equal(await putFile(config(), join(dir, 'real-a.jsonl'), 'real-a.jsonl', { ...fast(), fetchFn: stubFetch(() => 409) }), 'exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retry on 503 then success; no retry on 400', async () => {
  const flaky = stubFetch((_u, _i, n) => (n === 1 ? 503 : 200));
  const res = await request('x', `${HOST}/a`, { method: 'HEAD' }, { ...fast(), fetchFn: flaky });
  assert.equal(res.status, 200);
  assert.equal(flaky.calls.length, 2);

  const bad = stubFetch(() => 400);
  const res2 = await request('x', `${HOST}/a`, { method: 'HEAD' }, { ...fast(), fetchFn: bad });
  assert.equal(res2.status, 400);
  assert.equal(bad.calls.length, 1);

  const down = stubFetch(() => new TypeError('fetch failed'));
  await assert.rejects(request('x', `${HOST}/a`, {}, { ...fast(), fetchFn: down }), /gave up after 4 tries/);
  assert.equal(down.calls.length, 4);
});

test('401 stops the run with a clear message that never contains the token', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT, 'real-b.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch(() => 401);
    const deps = fast({ fetchFn, env: env() });
    const code = await main(['--dir', dir], deps);
    assert.equal(code, 1);
    assert.equal(fetchFn.calls.length, 1, 'no retry, no further files after a 401');
    const out = deps.log.lines.join('\n');
    assert.match(out, /token rejected or lacks permission on the Volume/);
    assert.ok(!out.includes(TOKEN));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dir: uploads missing real-* files, skips ones already there, leaves status-/spoiled-/sim- alone', async () => {
  const dir = tempDir({
    'real-new.jsonl': LOG_TEXT, 'real-old.jsonl': LOG_TEXT, 'real-bad name.jsonl': LOG_TEXT,
    'status-2026-10-10T18-00-00-1.jsonl': LOG_TEXT, 'spoiled-x.jsonl': LOG_TEXT, 'sim-x.jsonl': LOG_TEXT, 'notes.txt': 'x',
  });
  try {
    const fetchFn = stubFetch((url, init) => {
      if (init.method === 'HEAD') return url.endsWith('real-old.jsonl') ? 200 : 404;
      return 204;
    });
    const deps = fast({ fetchFn, env: env() });
    assert.equal(await main(['--dir', dir], deps), 0);
    const puts = fetchFn.calls.filter((c) => c.method === 'PUT').map((c) => c.url);
    assert.deepEqual(puts, [`${fileUrl(config(), 'real-new.jsonl')}?overwrite=false`]);
    assert.ok(fetchFn.calls.every((c) => !/status-|spoiled-|sim-/.test(c.url)));
    assert.match(deps.log.lines.at(-1), /uploaded 1, skipped 1 \(already there\), refused 1/);

    const withSim = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    assert.equal(await main(['--dir', dir, '--include-sim'], fast({ fetchFn: withSim, env: env() })), 0);
    assert.ok(withSim.calls.some((c) => c.method === 'PUT' && c.url.includes('sim-x.jsonl')));
    assert.ok(withSim.calls.every((c) => !/status-|spoiled-/.test(c.url)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planDir lists only valid real-* (and sim-* when asked)', () => {
  const dir = tempDir({ 'real-a.jsonl': '', 'sim-b.jsonl': '', 'status-c.jsonl': '', 'spoiled-d.jsonl': '', 'real-e f.jsonl': '' });
  try {
    assert.deepEqual(planDir(dir).uploads.map((u) => u.name), ['real-a.jsonl']);
    assert.deepEqual(planDir(dir).refused, ['real-e f.jsonl']);
    assert.deepEqual(planDir(dir, { includeSim: true }).uploads.map((u) => u.name), ['real-a.jsonl', 'sim-b.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed upload makes the exit code non-zero', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 400));
    assert.equal(await main(['--dir', dir], fast({ fetchFn, env: env() })), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run makes zero fetch calls and copies nothing', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT, 'status-1.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch(() => 200);
    const deps = fast({ fetchFn, env: env({ DATABRICKS_JOB_ID: '7' }) });
    assert.equal(await main(['--dir', dir, '--dry-run', '--run'], deps), 0);
    assert.equal(await main(['--dir', dir, '--latest', '--as', 'real-new.jsonl', '--dry-run'], deps), 0);
    assert.equal(await main(['--file', join(dir, 'real-a.jsonl'), '--as', 'real-z.jsonl', '--dry-run'],
      fast({ fetchFn, env: env({ DATABRICKS_TOKEN: '' }) })), 0);
    assert.equal(fetchFn.calls.length, 0);
    assert.equal(existsSync(join(dir, 'real-new.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--run calls run-now with the job id after a new upload; hint without a job id', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch((url, init) => {
      if (url.endsWith('/api/2.1/jobs/run-now')) return { status: 200, json: { run_id: 991, run_page_url: `${HOST}/jobs/7/runs/991` } };
      return init.method === 'HEAD' ? 404 : 204;
    });
    const deps = fast({ fetchFn, env: env({ DATABRICKS_JOB_ID: '7' }) });
    assert.equal(await main(['--file', join(dir, 'real-a.jsonl'), '--as', 'real-2026-10-11-mug1.jsonl', '--run'], deps), 0);
    const run = fetchFn.calls.find((c) => c.url === `${HOST}/api/2.1/jobs/run-now`);
    assert.ok(run);
    assert.equal(run.method, 'POST');
    assert.deepEqual(JSON.parse(run.body), { job_id: 7 });
    assert.equal(run.headers.Authorization, `Bearer ${TOKEN}`);
    const out = deps.log.lines.join('\n');
    assert.match(out, /run 991/);
    assert.match(out, /jobs\/7\/runs\/991/);

    // Already there: nothing new, so the job is not started.
    const there = stubFetch((url) => (url.includes('run-now') ? 200 : 200));
    assert.equal(await main(['--file', join(dir, 'real-a.jsonl'), '--as', 'real-x.jsonl', '--run'],
      fast({ fetchFn: there, env: env({ DATABRICKS_JOB_ID: '7' }) })), 0);
    assert.ok(!there.calls.some((c) => c.url.includes('run-now')));

    // No job id: a hint, no run-now call.
    const noJob = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    const d2 = fast({ fetchFn: noJob, env: env() });
    assert.equal(await main(['--file', join(dir, 'real-a.jsonl'), '--as', 'real-y.jsonl', '--run'], d2), 0);
    assert.ok(!noJob.calls.some((c) => c.url.includes('run-now')));
    assert.match(d2.log.lines.join('\n'), /Workflows > Create job > Notebook task > heat_test, Serverless/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--latest copies the newest status-* under the new name, then refuses to overwrite it', async () => {
  const dir = tempDir({ 'status-old.jsonl': 'old\n', 'status-new.jsonl': 'new\n', 'real-z.jsonl': 'z\n' });
  try {
    utimesSync(join(dir, 'status-old.jsonl'), new Date('2026-10-10T10:00:00Z'), new Date('2026-10-10T10:00:00Z'));
    utimesSync(join(dir, 'status-new.jsonl'), new Date('2026-10-10T12:00:00Z'), new Date('2026-10-10T12:00:00Z'));
    assert.equal(newestStatusLog(dir).name, 'status-new.jsonl');

    const fetchFn = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    const deps = fast({ fetchFn, env: env() });
    assert.equal(await main(['--dir', dir, '--latest', '--as', 'real-2026-10-11-mug1.jsonl'], deps), 0);
    assert.equal(readFileSync(join(dir, 'real-2026-10-11-mug1.jsonl'), 'utf8'), 'new\n');
    const puts = fetchFn.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 1, 'only the new copy is uploaded');
    assert.ok(puts[0].url.includes('real-2026-10-11-mug1.jsonl?overwrite=false'));

    // Same name again: refused, the existing file is untouched, nothing is sent.
    writeFileSync(join(dir, 'status-new.jsonl'), 'newer\n');
    const again = stubFetch(() => 204);
    assert.equal(await main(['--dir', dir, '--latest', '--as', 'real-2026-10-11-mug1.jsonl'], fast({ fetchFn: again, env: env() })), 2);
    assert.equal(readFileSync(join(dir, 'real-2026-10-11-mug1.jsonl'), 'utf8'), 'new\n');
    assert.equal(again.calls.length, 0);
    assert.throws(() => copyLatest(dir, 'real-z.jsonl'), /already exists/);
    assert.throws(() => copyLatest(dir, 'status-x.jsonl'), /refusing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arguments: --as is required and checked, modes do not mix', () => {
  assert.throws(() => parseArgs([]), /exactly one/);
  assert.throws(() => parseArgs(['--file', 'a.jsonl']), /--as/);
  assert.throws(() => parseArgs(['--dir', 'd', '--latest']), /--as/);
  assert.throws(() => parseArgs(['--file', 'a', '--dir', 'd', '--as', 'real-a.jsonl']), /exactly one/);
  assert.throws(() => parseArgs(['--file', 'a', '--as', 'status-a.jsonl']), /refusing/);
  assert.throws(() => parseArgs(['--file', 'a', '--as', '../real-a.jsonl']), /refusing/);
  assert.throws(() => parseArgs(['--dir', 'd', '--as', 'real-a.jsonl']), /--as goes with/);
  assert.throws(() => parseArgs(['--dir', 'd', '--watch', '--latest', '--as', 'real-a.jsonl']), /--watch/);
  assert.throws(() => parseArgs(['--dir', 'd', '--interval', '0']), /--interval/);
  assert.throws(() => parseArgs(['--dir', 'd', '--bogus']), /unexpected/);
  assert.equal(parseArgs(['--dir', 'd', '--watch']).interval, 30);
  assert.equal(parseArgs(['--dir', 'd', '--watch', '--interval', '5']).interval, 5);
});

test('--watch uploads files that appear between polls, once each is stable for one interval', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    let polls = 0;
    const putsAfterPoll = [];
    const putNames = () => fetchFn.calls.filter((c) => c.method === 'PUT').map((c) => c.url.match(/(real-\w)\.jsonl/)[1]);
    const deps = fast({
      fetchFn, env: env(),
      sleep: async () => {
        if (polls === 1) { writeFileSync(join(dir, 'real-b.jsonl'), LOG_TEXT); writeFileSync(join(dir, 'status-9.jsonl'), LOG_TEXT); }
      },
      keepWatching: () => { putsAfterPoll.push(putNames()); return ++polls < 3; },
    });
    assert.equal(await main(['--dir', dir, '--watch', '--interval', '1'], deps), 0);
    assert.deepEqual(putsAfterPoll, [[], ['real-a'], ['real-a', 'real-b']], 'each waits one interval');
    assert.deepEqual(putNames(), ['real-a', 'real-b'], 'each file once, no status-*');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--watch does not upload a file that is still growing', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    let polls = 0;
    const putsAfterPoll = [];
    const deps = fast({
      fetchFn, env: env(),
      // The file grows during the first two intervals, then stops.
      sleep: async () => { if (polls <= 2) appendFileSync(join(dir, 'real-a.jsonl'), LOG_TEXT); },
      keepWatching: () => { putsAfterPoll.push(fetchFn.calls.filter((c) => c.method === 'PUT').length); return ++polls < 5; },
    });
    assert.equal(await main(['--dir', dir, '--watch'], deps), 0);
    assert.deepEqual(putsAfterPoll, [0, 0, 0, 1, 1]);
    const put = fetchFn.calls.find((c) => c.method === 'PUT');
    assert.equal(Buffer.from(put.body).toString('utf8'), LOG_TEXT.repeat(3), 'the complete file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stableItems: ready only when size and mtime match the previous poll', () => {
  const dir = tempDir({ 'real-a.jsonl': 'a\n', 'real-b.jsonl': 'b\n' });
  try {
    const items = planDir(dir).uploads;
    const first = stableItems(items, new Map());
    assert.deepEqual(first.ready, []);
    const t = new Date('2026-10-10T12:00:00Z');
    utimesSync(join(dir, 'real-b.jsonl'), t, t);
    const second = stableItems(items, first.seen);
    assert.deepEqual(second.ready.map((i) => i.name), ['real-a.jsonl']);
    assert.deepEqual(stableItems(items, second.seen, new Set(['real-a.jsonl'])).ready.map((i) => i.name), ['real-b.jsonl']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--latest warns (but still copies) when the status log changed in the last few seconds', async () => {
  const dir = tempDir({ 'status-1.jsonl': LOG_TEXT });
  try {
    const fetchFn = stubFetch((_u, init) => (init.method === 'HEAD' ? 404 : 204));
    const deps = fast({ fetchFn, env: env() });
    assert.equal(await main(['--dir', dir, '--latest', '--as', 'real-fresh.jsonl'], deps), 0);
    assert.match(deps.log.lines.join('\n'), /server may still be writing; stop the server first for a complete log/);
    assert.equal(readFileSync(join(dir, 'real-fresh.jsonl'), 'utf8'), LOG_TEXT);

    const old = new Date(Date.now() - 60000);
    utimesSync(join(dir, 'status-1.jsonl'), old, old);
    const quiet = fast({ fetchFn, env: env() });
    assert.equal(await main(['--dir', dir, '--latest', '--as', 'real-old.jsonl'], quiet), 0);
    assert.doesNotMatch(quiet.log.lines.join('\n'), /may still be writing/);
    assert.equal(copyLatest(dir, 'real-x.jsonl', { dryRun: true, now: old.getTime() + FRESH_LOG_MS - 1 }).fresh, true);
    assert.equal(copyLatest(dir, 'real-x.jsonl', { dryRun: true, now: old.getTime() + FRESH_LOG_MS + 1 }).fresh, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run-now is never retried on a timeout or network error; retried on 429/503 only', async () => {
  const c = loadConfig(env({ DATABRICKS_JOB_ID: '7' }));
  const down = stubFetch(() => new TypeError('fetch failed'));
  await assert.rejects(runJob(c, { ...fast(), fetchFn: down }), /not retried/);
  assert.equal(down.calls.length, 1);

  const busy = stubFetch((_u, _i, n) => (n === 1 ? 429 : n === 2 ? 503 : { status: 200, json: { run_id: 5 } }));
  assert.deepEqual(await runJob(c, { ...fast(), fetchFn: busy }), { runId: 5, runPageUrl: null });
  assert.equal(busy.calls.length, 3);

  for (const status of [500, 502, 504]) {
    const err = stubFetch(() => status);
    await assert.rejects(runJob(c, { ...fast(), fetchFn: err }), new RegExp(`answered ${status}`));
    assert.equal(err.calls.length, 1, `no retry on ${status}`);
  }
});

test('auth wording: job vs Volume; PUT 404 names the Volume; redirects refused', async () => {
  const dir = tempDir({ 'real-a.jsonl': LOG_TEXT });
  try {
    const c = loadConfig(env({ DATABRICKS_JOB_ID: '7' }));
    await assert.rejects(runJob(c, { ...fast(), fetchFn: stubFetch(() => 403) }), (e) => {
      assert.match(e.message, /token rejected or lacks permission to run the job/);
      assert.ok(!e.message.includes(TOKEN));
      return true;
    });
    await assert.rejects(existsInVolume(c, 'real-a.jsonl', { ...fast(), fetchFn: stubFetch(() => 401) }),
      /token rejected or lacks permission on the Volume/);

    const deps = fast({ fetchFn: stubFetch(() => 404), env: env() });
    assert.equal(await main(['--dir', dir], deps), 1);
    assert.match(deps.log.lines.join('\n'), /Volume not found: check DATABRICKS_VOLUME_PATH and that the Volume exists/);

    const any = stubFetch(() => ({ status: 200, json: {} }));
    await existsInVolume(c, 'real-a.jsonl', { ...fast(), fetchFn: any });
    await putFile(c, join(dir, 'real-a.jsonl'), 'real-a.jsonl', { ...fast(), fetchFn: any });
    await runJob(c, { ...fast(), fetchFn: any });
    assert.deepEqual(any.calls.map((x) => [x.method, x.redirect]), [['HEAD', 'error'], ['PUT', 'error'], ['POST', 'error']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
