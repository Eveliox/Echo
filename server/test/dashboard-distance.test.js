// The seat distance reading on the dashboard: the box's distanceCm exactly as
// sent, or "--" when it is missing or not a number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MISSING, statusView } from '../dashboard/view.js';

const snapshot = (distanceCm) => ({
  online: true,
  lastSeen: 1_700_000_000_000,
  status: { state: 'ARMED', tempF: 76, presence: false, distanceCm },
});

test('seat distance shows distanceCm exactly as sent', () => {
  assert.equal(statusView(snapshot(38)).distanceCm, '38');
  assert.equal(statusView(snapshot(0)).distanceCm, '0');
  assert.equal(statusView(snapshot(12.5)).distanceCm, '12.5');
});

test('seat distance is "--" when missing or not a number', () => {
  assert.equal(statusView(snapshot(null)).distanceCm, MISSING);
  assert.equal(statusView(snapshot(undefined)).distanceCm, MISSING);
  assert.equal(statusView(snapshot('38')).distanceCm, MISSING);
  assert.equal(statusView(snapshot(Number.NaN)).distanceCm, MISSING);
  assert.equal(statusView(null).distanceCm, MISSING);
});

test('the page has a distanceCm reading and the script fills it', () => {
  const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  assert.match(html, /id="distanceCm"/);
  assert.match(app, /\$\('distanceCm'\)\.textContent = view\.distanceCm;/);
});
