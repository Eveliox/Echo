// server/insights.js: config, download, validation, and keeping the last good
// copy. Every fetch is a stub: no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createInsights, DEFAULT_INSIGHTS_PATH, FIRST_FETCH_MS, insightsStartupMessage, loadValidator,
  MAX_INSIGHTS_BYTES, readInsightsConfig,
} from '../insights.js';
import { validInsights } from '../../app/src/insights.js';
import { createFakeClock } from './fake-clock.js';

const TOKEN = 'dapiSECRETTOKEN0123456789';
const HOST = 'https://dbc-test.cloud.databricks.com';
const config = readInsightsConfig({ DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: TOKEN });

const forecast = {
  version: 1, source: 'databricks forecast', generatedAt: '2026-10-11T13:00:00Z', real: false, runs: 0, realRuns: 0,
  mae: null, evaluation: null, place: 'Orlando, FL',
  headline: { tempF: 91, timeOfDay: 'afternoon', minutes: 7 },
  points: [{ minute: 0, tempF: 91 }, { minute: 3.4, tempF: 97.5 }, { minute: 6.8, tempF: 104 }],
  inputs: { warmRateFPerMin: 1.91 },
};
const later = { ...structuredClone(forecast), generatedAt: '2026-10-11T14:00:00Z', headline: { tempF: 93, timeOfDay: 'afternoon', minutes: 6 } };
const committed = JSON.parse(readFileSync(new URL('../../app/assets/insights.json', import.meta.url), 'utf8'));

const json = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

// A fresh store with captured logs and a scripted fetch (one answer per call).
function setup(answers, options = {}) {
  const logs = [];
  const calls = [];
  const queue = [...answers];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;
    return next;
  };
  const store = createInsights({
    config, fetchFn, validate: validInsights, log: (m) => logs.push(m), logError: (m) => logs.push(m),
    now: () => 1_000, ...options,
  });
  return { store, logs, calls };
}

test('config: off without host or token, on with both and the defaults', () => {
  for (const env of [{}, { DATABRICKS_HOST: HOST }, { DATABRICKS_TOKEN: TOKEN }, { DATABRICKS_HOST: ' ', DATABRICKS_TOKEN: TOKEN }]) {
    const c = readInsightsConfig(env);
    assert.equal(c.on, false);
    assert.equal(insightsStartupMessage(c), 'insights: off (no DATABRICKS_HOST/TOKEN)');
  }
  assert.equal(config.on, true);
  assert.equal(config.path, DEFAULT_INSIGHTS_PATH);
  assert.equal(config.refreshMin, 5);
  assert.equal(config.url, `${HOST}/api/2.0/fs/files${DEFAULT_INSIGHTS_PATH}`);
  assert.equal(insightsStartupMessage(config), 'insights: on (Databricks, every 5 min)');
  const custom = readInsightsConfig({
    DATABRICKS_HOST: `${HOST}/`, DATABRICKS_TOKEN: TOKEN,
    ECHO_INSIGHTS_PATH: '/Volumes/main/echo/logs/out.json', ECHO_INSIGHTS_REFRESH_MIN: '2',
  });
  assert.equal(custom.url, `${HOST}/api/2.0/fs/files/Volumes/main/echo/logs/out.json`);
  assert.equal(insightsStartupMessage(custom), 'insights: on (Databricks, every 2 min)');
});

test('config: bad host, path, token or refresh turns it off with fixed text that never shows the token', () => {
  const bad = [
    { DATABRICKS_HOST: 'http://dbc.example.com' }, { DATABRICKS_HOST: 'not a url' },
    { DATABRICKS_HOST: `${HOST}/path` }, { DATABRICKS_HOST: `${HOST}/?x=1` },
    { DATABRICKS_TOKEN: 'has space' },
    { ECHO_INSIGHTS_PATH: '/tmp/file.json' }, { ECHO_INSIGHTS_PATH: '/Volumes/a/b/c/../x.json' },
    { ECHO_INSIGHTS_PATH: '/Volumes/a/b/c/file.txt' }, { ECHO_INSIGHTS_PATH: '/Volumes/a/b/file.json' },
    { ECHO_INSIGHTS_REFRESH_MIN: '0' }, { ECHO_INSIGHTS_REFRESH_MIN: 'soon' }, { ECHO_INSIGHTS_REFRESH_MIN: '9999' },
  ];
  for (const patch of bad) {
    const c = readInsightsConfig({ DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: TOKEN, ...patch });
    assert.equal(c.on, false, JSON.stringify(patch));
    const line = insightsStartupMessage(c);
    assert.match(line, /^insights: off \(/);
    assert.ok(!line.includes(TOKEN));
  }
});

test('the server uses the app\'s own validator, so both accept and refuse the same files', async () => {
  assert.equal(await loadValidator(), validInsights);
  assert.equal(await loadValidator(async () => { throw new Error('broken app file'); }), null);
  const validate = await loadValidator();
  assert.equal(validate(forecast), true);
  assert.equal(validate(committed), true);
  assert.equal(validate({ ...forecast, place: '' }), false);
  assert.equal(validate({ ...forecast, real: true }), false);
});

test('success: GET with the bearer token, no redirects, then snapshot has the file and its time', async () => {
  const { store, calls, logs } = setup([json(forecast)]);
  assert.deepEqual(store.snapshot(), { ok: false, reason: 'not fetched yet' });
  await store.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.url);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.deepEqual(store.snapshot(), { ok: true, insights: forecast, fetchedAt: 1_000 });
  assert.deepEqual(logs, [`insights: updated from Databricks (${DEFAULT_INSIGHTS_PATH})`]);
});

test('non-200, network error, timeout, not JSON, wrong shape and oversize all fail without throwing', async () => {
  const big = JSON.stringify({ ...forecast, pad: 'x'.repeat(MAX_INSIGHTS_BYTES) });
  const cases = [
    [new Response('no', { status: 500 }), /Databricks answered 500/],
    [new Response('no', { status: 403 }), /token rejected or lacks permission \(403\)/],
    [new Response('no', { status: 404 }), /file not found/],
    [new Error(`connect failed for Bearer ${TOKEN}`), /the request failed or timed out/],
    [(url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
      /the request failed or timed out/],
    [json('{"version": 1,'), /not JSON/],
    [json({ ...forecast, version: 2 }), /does not have the insights shape/],
    [json([forecast]), /does not have the insights shape/],
    [json(big), /too large/],
    [json('{}', { headers: { 'content-length': String(MAX_INSIGHTS_BYTES + 1) } }), /too large/],
  ];
  for (const [answer, reason] of cases) {
    const { store, logs } = setup([answer], { timeoutMs: 20 });
    await store.refresh();
    assert.deepEqual(store.snapshot(), { ok: false, reason: 'not fetched yet' });
    assert.equal(logs.length, 1);
    assert.match(logs[0], reason);
    assert.match(logs[0], /^insights: could not refresh from Databricks \(.*\); none yet$/);
  }
});

test('a later failure keeps the last good copy; a later success replaces it', async () => {
  let t = 1_000;
  const { store, logs } = setup([json(forecast), new Response('', { status: 503 }), json('nope'), json(later)], { now: () => t });
  await store.refresh();
  t = 2_000;
  await store.refresh();
  await store.refresh();
  assert.deepEqual(store.snapshot(), { ok: true, insights: forecast, fetchedAt: 1_000 });
  assert.match(logs[1], /keeping the last good copy$/);
  t = 3_000;
  await store.refresh();
  assert.deepEqual(store.snapshot(), { ok: true, insights: later, fetchedAt: 3_000 });
  assert.equal(logs.at(-1), `insights: updated from Databricks (${DEFAULT_INSIGHTS_PATH})`);
});

test('the token never appears in any log line, even when fetch errors quote it', async () => {
  const { store, logs } = setup([
    new Error(`Authorization: Bearer ${TOKEN}`), json(forecast), new Response(TOKEN, { status: 401 }), json(TOKEN),
  ]);
  for (let i = 0; i < 4; i++) await store.refresh();
  assert.equal(logs.length, 4);
  for (const line of logs) assert.ok(!line.includes(TOKEN), line);
  assert.equal(store.snapshot().ok, true);
});

test('off: never fetches, snapshot says not configured', async () => {
  let fetched = 0;
  const store = createInsights({ config: readInsightsConfig({}), fetchFn: async () => { fetched++; }, validate: validInsights });
  await store.start();
  await store.refresh();
  assert.equal(fetched, 0);
  assert.deepEqual(store.snapshot(), { ok: false, reason: 'not configured' });
});

test('start: first download shortly after startup, then every refresh interval; stop ends it', async () => {
  const clock = createFakeClock();
  const { store, calls } = setup([json(forecast), json(later), json(later)], { timers: clock.timers, now: clock.now });
  await store.start();
  assert.equal(calls.length, 0, 'never downloads before the server is listening');
  await clock.advance(FIRST_FETCH_MS);
  assert.equal(calls.length, 1);
  assert.deepEqual(store.snapshot().insights, forecast);
  await clock.advance(5 * 60_000 - 1);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.deepEqual(store.snapshot().insights, later);
  store.stop();
  await clock.advance(60 * 60_000);
  assert.equal(calls.length, 2);
  assert.equal(clock.pending(), 0);
});

test('start: an app validator that will not load leaves insights off and never fetches', async () => {
  const clock = createFakeClock();
  const logs = [];
  const { store, calls } = setup([json(forecast)], {
    validate: null, loadValidatorFn: async () => null, timers: clock.timers, logError: (m) => logs.push(m),
  });
  await store.start();
  await clock.advance(10 * 60_000);
  assert.equal(calls.length, 0);
  assert.deepEqual(store.snapshot(), { ok: false, reason: 'validator unavailable' });
  assert.deepEqual(logs, ["insights: off (could not load the app's insights validator)"]);
});
