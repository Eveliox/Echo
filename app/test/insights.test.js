import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arcPoint, insightsView, NO_INSIGHTS, NOT_REAL_LABEL, validInsights } from '../src/insights.js';

const committed = JSON.parse(readFileSync(new URL('../assets/insights.json', import.meta.url), 'utf8'));
const exported = {
  version: 1, source: 'databricks notebook', generatedAt: '2026-10-11T20:00:00Z', real: true, runs: 2, realRuns: 2,
  mae: 1.24, evaluation: 'held out by run',
  headline: { tempF: 88, timeOfDay: 'evening', minutes: 21 },
  points: [{ minute: 0, tempF: 88.2 }, { minute: 5, tempF: 92 }, { minute: 9.5, tempF: 96.4 }, { minute: 15, tempF: 100.1 }, { minute: 19.6, tempF: 104 }],
  inputs: { humidity: 55, warmRateFPerMin: 0.7 },
};
const copy = (patch = {}) => ({ ...structuredClone(exported), ...patch });

test('a real notebook export becomes plain-words view values from the JSON, with no honesty label', () => {
  const view = insightsView(exported);
  assert.equal(view.ok, true);
  assert.equal(view.minutes, '21');
  assert.equal(view.sentence, 'On a 88°F evening, your car hits danger in 21 minutes.');
  assert.equal(view.minutesLabel, 'Predicted time to 104°F');
  assert.equal(view.label, null); assert.equal(view.note, null); assert.equal(view.badge, 'PREDICTION');
  assert.equal(view.subtitle, 'An evening, predicted.');
  assert.deepEqual(view.moments.map(m => [m.minute, m.temperature, m.label]), [['0', 88, 'Starting cabin'], ['9.5', 96, 'Heat building'], ['19.6', 104, 'Danger threshold']]);
  assert.equal(view.ticks.length, 5);
  assert.equal(view.warming, '+0.70'); assert.equal(view.humidity, '55'); assert.equal(view.humidityShare, 0.55);
  assert.equal(view.basis, 'Fit on 2 real heat tests. Typical error 1.2 min (held out by run).');
});

test('anything not from a real heat test carries the label', () => {
  const view = insightsView(copy({ real: false, realRuns: 1 }));
  assert.equal(view.ok, true);
  assert.equal(view.label, NOT_REAL_LABEL);
  assert.equal(view.label, '(not from a real heat test)');
  assert.match(view.basis, /2 logged runs, 1 of them real/);
});

// Holds for any valid export pasted into the file, not only the starter.
test('the committed app/assets/insights.json validates and its label matches its data', () => {
  assert.equal(validInsights(committed), true);
  const view = insightsView(committed);
  assert.equal(view.ok, true);
  assert.equal(view.label, committed.real === false ? NOT_REAL_LABEL : null);
  assert.equal(view.note !== null, committed.source === 'design example');
});

const starter = {
  version: 1, source: 'design example', generatedAt: null, real: false, runs: 0, realRuns: 0, mae: null, evaluation: null,
  headline: { tempF: 92, timeOfDay: 'afternoon', minutes: 14 },
  points: [{ minute: 0, tempF: 92 }, { minute: 7, tempF: 98 }, { minute: 14, tempF: 104 }],
  inputs: { humidity: 41, warmRateFPerMin: 0.86 },
};
test('the design-example starter shows the label, the note, and the original arc points', () => {
  assert.equal(validInsights(starter), true);
  assert.equal(starter.mae, null);
  const view = insightsView(starter);
  assert.equal(view.label, NOT_REAL_LABEL);
  assert.equal(view.example, true); assert.equal(view.badge, 'DESIGN EXAMPLE');
  assert.match(view.note, /design example/i);
  assert.equal(view.minutesLabel, 'Example time to 104°F');
  assert.deepEqual(view.moments.map(m => [m.x, m.y]), [[35, 142], [170, 42.3], [305, 142]]);
});

test('malformed, incomplete, out-of-range or oversized files fall back without throwing', () => {
  const bad = [
    null, undefined, 'insights', 42, [], {},
    copy({ version: 2 }), copy({ version: '1' }), copy({ source: 'gemini' }), copy({ real: 'yes' }),
    copy({ real: true, realRuns: 1 }), copy({ real: true, source: 'design example' }), copy({ realRuns: 3 }),
    copy({ runs: -1 }), copy({ runs: 1.5 }), copy({ mae: -1 }), copy({ mae: 'low' }), copy({ evaluation: 'vibes' }),
    copy({ generatedAt: null }), copy({ runs: 0, realRuns: 0, real: false }),
    copy({ headline: null }), copy({ headline: { tempF: 92, timeOfDay: 'afternoon' } }),
    copy({ headline: { tempF: 92, timeOfDay: 'noon', minutes: 14 } }), copy({ headline: { tempF: 92, timeOfDay: 'afternoon', minutes: -1 } }),
    copy({ headline: { tempF: 92, timeOfDay: 'afternoon', minutes: Infinity } }), copy({ headline: { tempF: 900, timeOfDay: 'afternoon', minutes: 14 } }),
    copy({ headline: { tempF: '92', timeOfDay: 'afternoon', minutes: 14 } }),
    copy({ points: [] }), copy({ points: [{ minute: 0, tempF: 92 }] }), copy({ points: 'curve' }),
    copy({ points: Array.from({ length: 9 }, (_, i) => ({ minute: i, tempF: 90 + i })) }),
    copy({ points: Array.from({ length: 100_000 }, (_, i) => ({ minute: i / 1000, tempF: 90 })) }),
    copy({ points: [{ minute: 0, tempF: 92 }, { minute: 0, tempF: 104 }] }),
    copy({ points: [{ minute: 1, tempF: 92 }, { minute: 14, tempF: 104 }] }),
    copy({ points: [{ minute: 0, tempF: 92 }, { minute: 10, tempF: 98 }, { minute: 7, tempF: 104 }] }),
    copy({ points: [{ minute: 0, tempF: 92 }, null] }), copy({ points: [{ minute: 0, tempF: 92 }, { minute: 14, tempF: NaN }] }),
    copy({ inputs: null }), copy({ inputs: { humidity: 140, warmRateFPerMin: 1 } }), copy({ inputs: { humidity: 40 } }),
  ];
  for (const data of bad) {
    assert.equal(validInsights(data), false, JSON.stringify(data)?.slice(0, 120));
    assert.deepEqual(insightsView(data), { ok: false, message: NO_INSIGHTS });
  }
  assert.equal(NO_INSIGHTS, 'No heat-test predictions yet');
});

test('null inputs and a run that stops short of danger stay literal', () => {
  const view = insightsView(copy({ inputs: { humidity: null, warmRateFPerMin: null }, points: [{ minute: 0, tempF: 88 }, { minute: 3, tempF: 91 }] }));
  assert.equal(view.warming, '—'); assert.equal(view.humidity, '—'); assert.equal(view.humidityShare, 0);
  assert.deepEqual(view.moments.map(m => m.label), ['Starting cabin', 'Last reading']);
  assert.equal(insightsView(copy({ headline: { tempF: 95, timeOfDay: 'morning', minutes: 1 } })).sentence, 'On a 95°F morning, your car hits danger in 1 minute.');
});

test('the arc runs along elapsed time between its fixed ends', () => {
  assert.deepEqual(arcPoint(0), { x: 35, y: 142 });
  assert.deepEqual(arcPoint(1), { x: 305, y: 142 });
});
