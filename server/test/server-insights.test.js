// GET /insights on the main server, and that it stays apart from status and
// the backup ladder. Every fetch is a stub: no network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, attachLadder } from '../server.js';
import { createTracker } from '../status.js';
import { readConfig } from '../calls.js';
import { createInsights, readInsightsConfig } from '../insights.js';
import { validInsights } from '../../app/src/insights.js';

const forecast = {
  version: 1, source: 'databricks forecast', generatedAt: '2026-10-11T13:00:00Z', real: false, runs: 0, realRuns: 0,
  mae: null, evaluation: null, place: 'Orlando, FL',
  headline: { tempF: 91, timeOfDay: 'afternoon', minutes: 7 },
  points: [{ minute: 0, tempF: 91 }, { minute: 3.4, tempF: 97.5 }, { minute: 6.8, tempF: 104 }],
  inputs: { warmRateFPerMin: 1.91 },
};
const configured = readInsightsConfig({ DATABRICKS_HOST: 'https://dbc-test.cloud.databricks.com', DATABRICKS_TOKEN: 'dapiTEST' });
const quiet = { log: () => {}, logError: () => {} };

const servers = [];
async function serve(options) {
  const server = createServer(options);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => Promise.all(servers.map((s) => new Promise((resolve) => { s.close(resolve); s.closeAllConnections(); }))));

const getJson = async (url) => {
  const res = await fetch(url);
  return { code: res.status, type: res.headers.get('content-type'), body: await res.json() };
};

test('configured and fetched: 200 with the file and when it was fetched', async () => {
  const insights = createInsights({
    config: configured, validate: validInsights, now: () => 42, ...quiet,
    fetchFn: async () => new Response(JSON.stringify(forecast)),
  });
  await insights.refresh();
  const base = await serve({ insights });
  assert.deepEqual(await getJson(`${base}/insights`),
    { code: 200, type: 'application/json', body: { ok: true, insights: forecast, fetchedAt: 42 } });
  assert.deepEqual((await getJson(`${base}/insights?x=1`)).body.ok, true);
});

test('configured but not fetched yet, or fetch failing: 200 with ok false', async () => {
  const insights = createInsights({
    config: configured, validate: validInsights, ...quiet, fetchFn: async () => new Response('', { status: 500 }),
  });
  const base = await serve({ insights });
  assert.deepEqual((await getJson(`${base}/insights`)).body, { ok: false, reason: 'not fetched yet' });
  await insights.refresh();
  assert.deepEqual((await getJson(`${base}/insights`)).body, { ok: false, reason: 'not fetched yet' });
});

test('not configured (no store, or Databricks unset): 200 with ok false', async () => {
  for (const options of [{}, { insights: createInsights({ config: readInsightsConfig({}) }) }]) {
    const base = await serve(options);
    assert.deepEqual(await getJson(`${base}/insights`),
      { code: 200, type: 'application/json', body: { ok: false, reason: 'not configured' } });
  }
});

test('anything but GET is 405, like the other read-only routes', async () => {
  const base = await serve({});
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetch(`${base}/insights`, { method, body: method === 'DELETE' ? undefined : '{"ok":true}' });
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: 'method not allowed' });
  }
});

test('insights and status/ladder stay apart: a status never reaches insights, insights never reach status or calls', async () => {
  const tracker = createTracker();
  const logs = [];
  attachLadder(tracker, {
    config: readConfig({ CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001' }),
    log: (m) => logs.push(m), logError: (m) => logs.push(m),
  });
  let fetches = 0;
  const insights = createInsights({
    config: configured, validate: validInsights, now: () => 7, ...quiet,
    fetchFn: async () => { fetches++; return new Response(JSON.stringify(forecast)); },
  });
  await insights.refresh();
  const base = await serve({ tracker, insights });
  const before = await getJson(`${base}/insights`);
  assert.deepEqual((await getJson(`${base}/status`)).body, { online: false, lastSeen: null, status: null });
  for (const state of ['OCCUPANT', 'WARNING', 'EMERGENCY']) {
    const res = await fetch(`${base}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, tempF: 104.5, presence: true, distanceCm: 30, minsToDanger: 0 }),
    });
    assert.equal(res.status, 200);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await getJson(`${base}/status`)).body.status.state, 'EMERGENCY');
  assert.equal(logs.filter((m) => /ladder step 1/.test(m)).length, 1, 'the ladder ran its step 1 as usual');
  assert.deepEqual(await getJson(`${base}/insights`), before);
  assert.equal(fetches, 1, 'statuses never trigger a Databricks download');
  // Posting the insights JSON as a status is refused like any bad status.
  const res = await fetch(`${base}/status`, { method: 'POST', body: JSON.stringify(forecast) });
  assert.equal(res.status, 400);
  assert.equal((await getJson(`${base}/status`)).body.status.state, 'EMERGENCY');
});

// The real server with Databricks blanked prints the insights-off line.
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
let child = null;
let dir = null;
before(() => { dir = mkdtempSync(join(tmpdir(), 'echo-insights-startup-')); });
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the real server without DATABRICKS_HOST/TOKEN prints "insights: off" and answers not configured', { timeout: 12_000 }, async () => {
  const port = await freePort();
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ECHO_CALLS: 'off', ECHO_PORT: String(port), ECHO_LOG_DIR: dir, ECHO_BOX_TOKEN: '',
      ECHO_CONTACTS_FILE: join(dir, 'no-saved-contacts.json'), GEMINI_API_KEY: '', ELEVENLABS_API_KEY: '',
      ECHO_VOICE_SECRET: '', DATABRICKS_HOST: '', DATABRICKS_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no insights line:\n${output}`)), 10_000);
    const check = (chunk) => {
      output += chunk;
      if (/^insights: off \(no DATABRICKS_HOST\/TOKEN\)$/m.test(output)) { clearTimeout(timer); resolve(); }
    };
    child.stdout.setEncoding('utf8').on('data', check);
    child.stderr.setEncoding('utf8').on('data', check);
  });
  assert.deepEqual((await getJson(`http://127.0.0.1:${port}/insights`)).body, { ok: false, reason: 'not configured' });
});
