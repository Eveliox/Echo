import { DANGER_F } from './model.js';

// Reads app/assets/insights.json, exported by notebooks/heat_test.py ("Export for the app",
// where the shape is documented). Predictions from past heat tests only: nothing here
// reaches the server, alerts, the backup ladder, or calls.
export const NOT_REAL_LABEL = '(not from a real heat test)';
export const NO_INSIGHTS = 'No heat-test predictions yet';
const MAX_POINTS = 8;
const MAX_MINUTES = 600;
const TIMES = ['morning', 'afternoon', 'evening', 'night'];
const EVALUATIONS = ['held out by run', 'in-sample'];
const SOURCES = ['databricks notebook', 'design example'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const inRange = (value, low, high) => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const nullOr = (value, low, high) => value === null || inRange(value, low, high);
const isCount = value => Number.isInteger(value) && value >= 0 && value <= 10_000;
const isTemp = value => inRange(value, -40, 200);

export function validInsights(data) {
  if (!isObject(data) || data.version !== 1 || !SOURCES.includes(data.source) || typeof data.real !== 'boolean') return false;
  if (!(data.generatedAt === null || (typeof data.generatedAt === 'string' && data.generatedAt.length <= 40))) return false;
  if (!isCount(data.runs) || !isCount(data.realRuns) || data.realRuns > data.runs) return false;
  if (data.source === 'databricks notebook' && (data.runs < 1 || typeof data.generatedAt !== 'string' || !EVALUATIONS.includes(data.evaluation))) return false;
  if (data.real && (data.source !== 'databricks notebook' || data.realRuns !== data.runs)) return false;
  if (!nullOr(data.mae, 0, MAX_MINUTES) || !(data.evaluation === null || EVALUATIONS.includes(data.evaluation))) return false;
  const { headline, points, inputs } = data;
  if (!isObject(headline) || !isTemp(headline.tempF) || !inRange(headline.minutes, 0, MAX_MINUTES) || !TIMES.includes(headline.timeOfDay)) return false;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_POINTS) return false;
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!isObject(point) || !inRange(point.minute, 0, MAX_MINUTES) || !isTemp(point.tempF)) return false;
    if (i > 0 && point.minute < points[i - 1].minute) return false;
  }
  if (points[0].minute !== 0 || points.at(-1).minute <= 0) return false;
  return isObject(inputs) && nullOr(inputs.humidity, 0, 100) && nullOr(inputs.warmRateFPerMin, -60, 60);
}

// The screen's arc: elapsed time along the curve, not a temperature scale.
export function arcPoint(t) {
  const u = 1 - t;
  const x = u ** 3 * 35 + 3 * u * u * t * 94 + 3 * u * t * t * 246 + t ** 3 * 305;
  const y = u ** 3 * 142 + 3 * u * u * t * 9 + 3 * u * t * t * 9 + t ** 3 * 142;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const oneDecimal = value => String(Math.round(value * 10) / 10);

export function insightsView(data) {
  if (!validInsights(data)) return { ok: false, message: NO_INSIGHTS };
  const example = data.source === 'design example';
  const { timeOfDay } = data.headline;
  const temp = Math.round(data.headline.tempF);
  const minutes = Math.round(data.headline.minutes);
  const points = data.points;
  const end = points.at(-1).minute;
  let middle = null;
  for (let i = 1; i < points.length - 1; i++) {
    if (middle === null || Math.abs(points[i].minute - end / 2) < Math.abs(points[middle].minute - end / 2)) middle = i;
  }
  const picks = [0, middle, points.length - 1].filter(i => i !== null);
  const moments = picks.map((index, n) => {
    const point = points[index];
    const last = n === picks.length - 1;
    return { minute: oneDecimal(point.minute), temperature: Math.round(point.tempF), ...arcPoint(point.minute / end),
      label: n === 0 ? 'Starting cabin' : !last ? 'Heat building' : point.tempF >= DANGER_F ? 'Danger threshold' : 'Last reading' };
  });
  const { humidity, warmRateFPerMin: rate } = data.inputs;
  const error = data.mae === null ? '' : ` Typical error ${oneDecimal(data.mae)} min (${data.evaluation ?? 'unevaluated'}).`;
  return {
    ok: true,
    example,
    real: data.real,
    badge: example ? 'DESIGN EXAMPLE' : 'PREDICTION',
    subtitle: `${timeOfDay === 'afternoon' || timeOfDay === 'evening' ? 'An' : 'A'} ${timeOfDay}, ${example ? 'imagined' : 'predicted'}.`,
    minutes: String(minutes),
    minutesLabel: `${example ? 'Example' : 'Predicted'} time to ${DANGER_F}°F`,
    sentence: `On a ${temp}°F ${timeOfDay}, your car hits danger in ${plural(minutes, 'minute')}.`,
    label: data.real ? null : NOT_REAL_LABEL,
    note: example ? 'Design example: no Databricks run yet.' : null,
    moments,
    ticks: points.map(point => arcPoint(point.minute / end).x),
    timeline: example ? 'into the example' : 'into the logged heat test',
    warming: rate === null ? '—' : `${rate > 0 ? '+' : ''}${rate.toFixed(2)}`,
    humidity: humidity === null ? '—' : String(Math.round(humidity)),
    humidityShare: humidity === null ? 0 : humidity / 100,
    inputsCaption: example ? 'Example' : 'At the start',
    timeOfDay: timeOfDay[0].toUpperCase() + timeOfDay.slice(1),
    startCaption: `${temp}°F starting cabin · ${example ? 'example inputs' : 'heat-test inputs'}`,
    basis: example ? 'No Databricks run yet. These are design example values, not model results.'
      : data.real ? `Fit on ${plural(data.runs, 'real heat test')}.${error}`
        : `Fit on ${plural(data.runs, 'logged run')}, ${data.realRuns} of them real heat tests.${error}`,
  };
}
