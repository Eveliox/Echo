import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { insightsFreshness, liveInsights, nextInsights } from '../src/client.js';

const bundled = JSON.parse(readFileSync(new URL('../assets/insights.json', import.meta.url), 'utf8'));
const forecast = {
  version: 1, source: 'databricks forecast', generatedAt: '2026-10-11T15:00:00Z', real: false, runs: 0, realRuns: 0,
  mae: null, evaluation: null, place: 'Miami, FL',
  headline: { tempF: 94, timeOfDay: 'afternoon', minutes: 6 },
  points: [{ minute: 0, tempF: 94 }, { minute: 3, tempF: 99 }, { minute: 6, tempF: 104 }],
  inputs: { warmRateFPerMin: 1.67 },
};
const answer = body => async () => ({ ok: true, status: 200, json: async () => body });

test('a valid server copy from GET /insights is used, with its fetch time', async () => {
  const urls = [];
  const result = await liveInsights('http://laptop:3000', bundled, { fetcher: async (url, options) => {
    urls.push([url, options.method]);
    return { ok: true, status: 200, json: async () => ({ ok: true, insights: forecast, fetchedAt: 1_760_000_000_000 }) };
  } });
  assert.deepEqual(urls, [['http://laptop:3000/insights', 'GET']]);
  assert.deepEqual(result, { data: forecast, fetchedAt: 1_760_000_000_000 });
});

test('ok false, an invalid file, a bad answer, a network error or no server URL all fall back to the bundled file', async () => {
  const fallbacks = [
    answer({ ok: false, reason: 'not configured' }),
    answer({ ok: false, reason: 'not fetched yet' }),
    answer({ ok: true, insights: { ...forecast, place: '' }, fetchedAt: 1 }),
    answer({ ok: true, insights: { ...forecast, version: 2 }, fetchedAt: 1 }),
    answer({ ok: true, insights: forecast }),
    answer({ ok: 'yes', insights: forecast, fetchedAt: 1 }),
    answer(null), answer([]),
    async () => ({ ok: false, status: 500, json: async () => ({}) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not JSON'); } }),
    async () => { throw new TypeError('Network request failed'); },
  ];
  for (const fetcher of fallbacks) {
    assert.deepEqual(await liveInsights('http://laptop:3000', bundled, { fetcher }), { data: bundled, fetchedAt: null });
  }
  let called = false;
  assert.deepEqual(await liveInsights('', bundled, { fetcher: async () => { called = true; } }), { data: bundled, fetchedAt: null });
  assert.equal(called, false);
});

test('a server that never answers times out to the bundled file', async () => {
  const fetcher = (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.deepEqual(await liveInsights('http://laptop:3000', bundled, { fetcher, timeoutMs: 5 }), { data: bundled, fetchedAt: null });
});

test('a failed poll keeps the live copy already shown; before any live copy it shows the bundled file', () => {
  const live = { data: forecast, fetchedAt: 5_000 };
  const failed = { data: bundled, fetchedAt: null };
  const newer = { data: { ...forecast, place: 'Tampa, FL' }, fetchedAt: 9_000 };
  assert.equal(nextInsights(live, failed), live);
  assert.equal(nextInsights(failed, failed), failed);
  assert.equal(nextInsights(undefined, failed), failed);
  assert.equal(nextInsights(failed, live), live);
  assert.equal(nextInsights(live, newer), newer);
});

test('the freshness line leads with when Databricks made the file, then when the server checked', () => {
  const format = ms => `<${ms}>`;
  const made = Date.parse(forecast.generatedAt);
  assert.equal(insightsFreshness({ data: forecast, fetchedAt: 7 }, format), `Forecast from Databricks · made <${made}> · checked <7>`);
  const notebook = { ...forecast, source: 'databricks notebook', generatedAt: 'not a date' };
  assert.equal(insightsFreshness({ data: notebook, fetchedAt: 7 }, format), 'Prediction from Databricks · checked <7>');
  assert.equal(insightsFreshness({ data: bundled, fetchedAt: null }, format), null);
});
