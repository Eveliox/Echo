// The dashboard's level-to-look map (#25): pageTheme() in view.js picks a
// theme, style.css paints it with the app's exact colors (app/src/ui.js,
// app/src/model.js, app/App.js), and red appears only at EMERGENCY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageTheme, statusView } from '../dashboard/view.js';

const css = readFileSync(new URL('../dashboard/style.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../app/src/ui.js', import.meta.url), 'utf8');

// The body of the CSS rule whose selector is exactly `selector`.
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*{([^}]*)}`));
  assert.ok(m, `style.css has a ${selector} rule`);
  return m[1];
}
// The value of a custom property declared in :root.
function rootVar(name) {
  const m = rule(':root').match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(m, `:root declares ${name}`);
  return m[1].trim();
}

test('each level maps to its theme while the box is online', () => {
  assert.equal(pageTheme('IDLE', true), 'calm');
  assert.equal(pageTheme('ARMED', true), 'calm');
  assert.equal(pageTheme('OCCUPANT', true), 'caution');
  assert.equal(pageTheme('WARNING', true), 'caution');
  assert.equal(pageTheme('EMERGENCY', true), 'emergency');
});

// Changed on purpose (Eve, 2026-10-11): a last-known WARNING or EMERGENCY
// keeps its alarm look when the box or server goes quiet; see docs/notes.md.
test('offline or unreachable is muted below WARNING; WARNING and EMERGENCY keep their look', () => {
  for (const state of ['IDLE', 'ARMED', 'OCCUPANT']) {
    assert.equal(pageTheme(state, false), 'muted', state);
    assert.equal(pageTheme(state, undefined), 'muted', state);
  }
  for (const online of [false, undefined]) {
    assert.equal(pageTheme('WARNING', online), 'caution');
    assert.equal(pageTheme('EMERGENCY', online), 'emergency');
  }
  for (const v of ['--', 'PANIC', '', null, undefined, 'toString', '__proto__']) {
    assert.equal(pageTheme(v, true), 'muted', String(v));
  }
});

test('statusView carries the theme from the level and the connection', () => {
  const snap = (state, online = true) => ({ online, lastSeen: 1, status: { state, tempF: 104.5, minsToDanger: 0, presence: true } });
  assert.equal(statusView(snap('EMERGENCY')).theme, 'emergency');
  assert.equal(statusView(snap('WARNING')).theme, 'caution');
  assert.equal(statusView(snap('EMERGENCY', false)).theme, 'emergency', 'box offline');
  assert.equal(statusView(snap('EMERGENCY'), false).theme, 'emergency', 'server unreachable');
  assert.equal(statusView(snap('WARNING', false)).theme, 'caution', 'box offline');
  assert.equal(statusView(snap('OCCUPANT', false)).theme, 'muted', 'box offline');
  assert.equal(statusView(null, true).theme, 'muted');
  // Values still show exactly as sent at EMERGENCY.
  assert.equal(statusView(snap('EMERGENCY')).tempF, '104.5');
  assert.equal(statusView(snap('EMERGENCY')).minsToDanger, '0');
});

test('every theme pageTheme can return has a style.css rule', () => {
  for (const t of ['calm', 'caution', 'emergency', 'muted']) rule(`.theme-${t}`);
});

test('the palette and warm background are the app\'s exact values', () => {
  const palette = Object.fromEntries([...ui.match(/export const palette = {([^}]*)}/)[1]
    .matchAll(/(\w+):\s*'(#[0-9A-Fa-f]+)'/g)].map((m) => [m[1], m[2]]));
  assert.equal(palette.text, '#352315');
  assert.equal(palette.muted, '#715037');
  for (const [name, value] of Object.entries(palette)) assert.equal(rootVar(`--palette-${name}`), value, name);

  const stops = (id) => [...ui.match(new RegExp(`id="${id}"[^]*?</(?:Linear|Radial)Gradient>`))[0]
    .matchAll(/stopColor="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
  for (const [id, prop] of [['heatSky', '--heat-sky'], ['heatSun', '--heat-sun'], ['heatEmber', '--heat-ember']]) {
    const value = rootVar(prop);
    for (const color of stops(id)) assert.ok(value.includes(color), `${prop} has ${id} stop ${color}`);
  }
  assert.match(rule('body'), /background-image:\s*var\(--heat-ember\),\s*var\(--heat-sun\),\s*var\(--heat-sky\)/);
});

test('EMERGENCY is the app\'s deep red with cream text; muted uses the muted brown', () => {
  assert.equal(rootVar('--emergency-ground'), '#B62432');
  assert.equal(rootVar('--emergency-on-red'), '#FFF5E9');
  const emergency = rule('.theme-emergency');
  assert.match(emergency, /background:\s*var\(--emergency-ground\)/);
  assert.match(emergency, /--fg:\s*var\(--emergency-on-red\)/);
  assert.match(emergency, /--accent:\s*var\(--emergency-on-red\)/);
  const muted = rule('.theme-muted');
  assert.match(muted, /--accent:\s*var\(--palette-muted\)/);
  assert.match(muted, /--halo:\s*var\(--colors-offline\)/);
  assert.equal(rootVar('--colors-offline'), '#6E6468');
});

test('the red is used only by the EMERGENCY theme', () => {
  const uses = [...css.matchAll(/var\(--emergency-[\w-]+\)/g)];
  const emergency = rule('.theme-emergency');
  const outside = css.replace(emergency, '').replace(/\.theme-emergency \.connection\s*{[^}]*}/, '');
  assert.ok(uses.length > 0);
  assert.ok(!/var\(--emergency-/.test(outside), 'no --emergency-* outside .theme-emergency');
  assert.ok(!/#B62432/i.test(css.replace(rule(':root'), '')), 'deep red only defined in :root');
});
