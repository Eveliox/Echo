import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clockTime, feedRows, formatValue, heatCurve, levelStyle, lostAlarmText, seatText, statusView, MISSING,
} from '../dashboard/view.js';

const status = (overrides = {}) => ({
  state: 'WARNING', tempF: 96.4, presence: true, distanceCm: 38,
  minsToDanger: 7.5, ...overrides,
});

test('values show exactly as sent, and "--" when null or missing', () => {
  assert.equal(formatValue(96.4), '96.4');
  assert.equal(formatValue(96.456789), '96.456789'); // never rounded
  assert.equal(formatValue(0.1 + 0.2), '0.30000000000000004');
  assert.equal(formatValue(0), '0');
  assert.equal(formatValue(-3.25), '-3.25');
  for (const v of [null, undefined, NaN, Infinity, '96.4', true, {}]) {
    assert.equal(formatValue(v), MISSING, String(v));
  }
  assert.equal(MISSING, '--');
});

test('level colors and blinking follow the firmware level table', () => {
  assert.deepEqual(levelStyle('IDLE'), { color: 'blue', blink: false });
  assert.deepEqual(levelStyle('ARMED'), { color: 'blue', blink: true });
  assert.deepEqual(levelStyle('OCCUPANT'), { color: 'yellow', blink: true });
  assert.deepEqual(levelStyle('WARNING'), { color: 'yellow', blink: false });
  assert.deepEqual(levelStyle('EMERGENCY'), { color: 'red', blink: true });
  for (const v of ['PANIC', '', null, undefined, 'toString', '__proto__']) {
    assert.deepEqual(levelStyle(v), { color: 'none', blink: false }, String(v));
  }
});

test('seat occupied comes straight from presence', () => {
  assert.equal(seatText(true), 'yes');
  assert.equal(seatText(false), 'no');
  assert.equal(seatText(null), MISSING);
  assert.equal(seatText('true'), MISSING);
});

test('clockTime shows local HH:MM:SS, "--" for nothing or garbage', () => {
  const local = new Date(2026, 9, 10, 14, 5, 9);
  assert.equal(clockTime(local.toISOString()), '14:05:09');
  assert.equal(clockTime(local.getTime()), '14:05:09');
  for (const v of [null, undefined, '', 'not a date']) assert.equal(clockTime(v), MISSING);
});

test('statusView passes the box values through and never computes its own', () => {
  const view = statusView({ online: true, lastSeen: null, status: status() });
  assert.equal(view.level, 'WARNING');
  assert.equal(view.color, 'yellow');
  assert.equal(view.blink, false);
  assert.equal(view.tempF, '96.4');
  assert.equal(view.minsToDanger, '7.5');
  assert.equal(view.seat, 'yes');
  assert.equal(view.connection, 'online');
  assert.equal(view.online, true);

  // minsToDanger null stays "--" even with a temperature to compute from.
  const noRate = statusView({ online: true, status: status({ tempF: 103.9, minsToDanger: null }) });
  assert.equal(noRate.tempF, '103.9');
  assert.equal(noRate.minsToDanger, MISSING);
  const zero = statusView({ online: true, status: status({ state: 'EMERGENCY', minsToDanger: 0 }) });
  assert.equal(zero.minsToDanger, '0');
});

test('statusView ignores unknown fields and renders nothing the box did not send', () => {
  const view = statusView({
    online: true,
    status: status({ extra: '<img src=x onerror=alert(1)>', note: 'injected', light: 812 }),
  });
  const text = JSON.stringify(view);
  for (const s of ['<img', 'injected', '812', 'extra']) assert.ok(!text.includes(s), s);
  // A state the server would reject still shows as unknown, not as its text.
  const odd = statusView({ online: true, status: status({ state: '<b>PANIC</b>' }) });
  assert.equal(odd.level, MISSING);
  assert.equal(odd.color, 'none');
});

test('statusView with no status, offline, or an unreachable server', () => {
  const none = statusView({ online: false, lastSeen: null, status: null });
  assert.deepEqual(
    [none.level, none.tempF, none.minsToDanger, none.seat, none.connection, none.lastSeen],
    [MISSING, MISSING, MISSING, MISSING, 'offline', MISSING],
  );
  const seen = new Date(2026, 9, 10, 9, 0, 1).getTime();
  const offline = statusView({ online: false, lastSeen: seen, status: status({ state: 'EMERGENCY' }) });
  assert.equal(offline.connection, 'offline');
  assert.equal(offline.online, false);
  assert.equal(offline.lastSeen, '09:00:01');
  assert.equal(offline.level, 'EMERGENCY'); // last level stays visible

  const down = statusView({ online: true, status: status() }, false);
  assert.equal(down.connection, 'server unreachable');
  assert.equal(down.online, false);
  assert.equal(statusView(null, false).connection, 'server unreachable');
  assert.equal(statusView(undefined).level, MISSING);
});

test('heatCurve maps tempF over receivedAt into the box, oldest left, hottest top', () => {
  const entries = [
    { receivedAt: 2000, status: status({ tempF: 100 }) },
    { receivedAt: 0, status: status({ tempF: 80 }) },
    { receivedAt: 1000, status: status({ tempF: 90 }) },
  ];
  const curve = heatCurve(entries, { width: 300, height: 120 });
  assert.equal(curve.points, '0,120 150,60 300,0');
  assert.equal(curve.minF, '80');
  assert.equal(curve.maxF, '100');
  assert.equal(curve.start, clockTime(0));
  assert.equal(curve.end, clockTime(2000));
});

test('heatCurve labels are temperatures the box sent, and bad entries are skipped', () => {
  const curve = heatCurve([
    { receivedAt: 0, status: status({ tempF: 80.4 }) },
    { receivedAt: 500, status: null },
    { receivedAt: 'x', status: status({ tempF: 120 }) },
    { receivedAt: 1000, status: status({ tempF: 104.5 }) },
    null,
  ], { width: 100, height: 50 });
  assert.equal(curve.points, '0,50 100,0');
  assert.equal(curve.minF, '80.4');
  assert.equal(curve.maxF, '104.5');
});

test('heatCurve with dangerF scales to include it and places its line', () => {
  const entries = [
    { receivedAt: 0, status: status({ tempF: 80 }) },
    { receivedAt: 1000, status: status({ tempF: 90 }) },
    { receivedAt: 2000, status: status({ tempF: 100 }) },
  ];
  // Scale 78..106 °F over 120 px.
  const curve = heatCurve(entries, { width: 300, height: 120, dangerF: 104 });
  assert.equal(curve.points, '0,111.4 150,68.6 300,25.7');
  assert.equal(curve.dangerY, '8.6');
  assert.equal(curve.minF, '80', 'labels stay the temperatures sent');
  assert.equal(curve.maxF, '100');
  // Above the threshold, the line sits below the hottest point.
  const hot = heatCurve([{ receivedAt: 0, status: status({ tempF: 110 }) }], { width: 300, height: 120, dangerF: 104 });
  assert.ok(Number(hot.dangerY) > Number(hot.points.split(',')[1]));
  assert.equal(heatCurve(entries).dangerY, undefined, 'no dangerF, no line');
});

test('lostAlarmText warns only when out of contact at WARNING or EMERGENCY', () => {
  assert.equal(lostAlarmText('EMERGENCY', false, '10:42:03'),
    'No updates since 10:42:03 · last alert EMERGENCY. The box alarms on its own without Wi-Fi. Go to the car now.');
  assert.match(lostAlarmText('WARNING', false, MISSING), /^No updates · last alert WARNING\./);
  for (const level of ['IDLE', 'ARMED', 'OCCUPANT', MISSING]) assert.equal(lostAlarmText(level, false, '10:42:03'), '', level);
  assert.equal(lostAlarmText('EMERGENCY', true, '10:42:03'), '', 'online');
});

test('heatCurve with one reading or none', () => {
  assert.equal(heatCurve([{ receivedAt: 5, status: status({ tempF: 81 }) }], { width: 300, height: 120 }).points, '300,60');
  for (const v of [[], undefined, null, 'nope']) {
    assert.deepEqual(heatCurve(v), { points: '', minF: MISSING, maxF: MISSING, start: MISSING, end: MISSING });
  }
});

test('feedRows lists actions newest first with only the four action-log fields', () => {
  const t1 = new Date(2026, 9, 10, 1, 2, 3).toISOString();
  const t2 = new Date(2026, 9, 10, 1, 4, 5).toISOString();
  const rows = feedRows([
    { time: t1, action: 'call', to: 'Mom', reason: 'EMERGENCY, step 2' },
    { time: t2, action: 'skip', to: 'Alex', reason: '<script>alert(1)</script>', number: '+15550000001' },
    null,
  ]);
  assert.deepEqual(rows, [
    { time: '01:04:05', action: 'skip', to: 'Alex', reason: '<script>alert(1)</script>' },
    { time: '01:02:03', action: 'call', to: 'Mom', reason: 'EMERGENCY, step 2' },
  ]);
  assert.deepEqual(feedRows([{ time: 7, action: 3, to: null }]), [
    { time: clockTime(7), action: '', to: '', reason: '' },
  ]);
  assert.deepEqual(feedRows(undefined), []);
});
