import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewModel as makeView, sensorReadings, emergencyCopy, lostAlarmCopy, heatCurve, DANGER_F, emergencyPhone, phoneUrl, serverUrl } from '../src/model.js';
import { poll, request } from '../src/client.js';
const viewModel = (snapshot, connected, now) => makeView(snapshot, connected, now, 1000);
const status = { state: 'EMERGENCY', tempF: 101.23, presence: true, battery: null, minsToDanger: 3.75 };
const snapshot = { online: true, lastSeen: 1000, status };
test('live numbers preserve box decimals, zero and null without a countdown', () => {
  assert.equal(viewModel(snapshot, true, 2000).minutes, '3.75');
  assert.equal(viewModel(snapshot, true, 7000).minutes, '3.75');
  assert.equal(viewModel(snapshot, true, 2000).temperature, '101.23°');
  for (const [value, expected] of [[0, '0'], [null, '—']]) assert.equal(viewModel({ ...snapshot, status: { ...status, minsToDanger: value } }, true, 2000).minutes, expected);
});
test('offline server, stale receipt, network failure and initial load never appear live', () => {
  for (const vm of [viewModel(snapshot, false, 2000), viewModel(snapshot, true, 11000), viewModel({ ...snapshot, online: false }, true, 2000), viewModel(null, false, 2000)]) {
    assert.equal(vm.online, false); assert.equal(vm.emergency, false); assert.equal(vm.rising, false); assert.equal(vm.color, '#6E6468');
  }
  assert.equal(viewModel(snapshot, false, 6000).heard, 'Last heard 5 s ago');
});
test('every firmware state is displayed as sent; only online emergency uses Live alert', () => {
  for (const state of ['IDLE', 'ARMED', 'OCCUPANT', 'WARNING', 'EMERGENCY']) {
    const vm = viewModel({ ...snapshot, status: { ...status, state } }, true, 2000);
    assert.equal(vm.status.state, state); assert.equal(vm.emergency, state === 'EMERGENCY');
  }
});
test('curve uses reported minutes and danger constant, no forecast for null, zero, offline or unmatched history', () => {
  const entries = [{ receivedAt: 0, status: { tempF: 90 } }, { receivedAt: 60000, status }];
  const curve = heatCurve(entries, status, true);
  assert.equal(DANGER_F, 104); assert.equal(curve.forecast.label, '+3.75 min'); assert.equal(curve.forecast.to.y, curve.dangerY);
  assert.equal(curve.points[1].x, 300 / 4.75);
  for (const minsToDanger of [null, 0, -1, Infinity, NaN, '3.75']) assert.equal(heatCurve(entries, { ...status, minsToDanger }, true).forecast, null);
  assert.equal(heatCurve(entries, status, false).forecast, null);
  assert.equal(heatCurve(entries, { ...status, tempF: 99 }, true).forecast, null);
});
test('forecast endpoint follows only the box estimate even when recorded temperatures fall', () => {
  const entries = [{ receivedAt: 0, status: { tempF: 103 } }, { receivedAt: 15000, status: { tempF: 102 } }, { receivedAt: 60000, status }];
  for (const minutes of [0.25, 3.75, 12]) {
    const curve = heatCurve(entries, { ...status, minsToDanger: minutes }, true, 288, 112);
    assert.equal(curve.forecast.label, `+${minutes} min`);
    assert.equal(curve.forecast.to.x, 288);
    assert.equal(curve.forecast.to.y, curve.dangerY);
    assert.equal(curve.points.at(-1).x, 288 / (1 + minutes));
    assert.equal(curve.points[1].x, curve.points.at(-1).x / 4);
  }
  assert.equal(heatCurve([], status, true).forecast, null);
});
test('phone actions only return tel URLs, and a missing demo number never falls back to 911', () => {
  assert.equal(emergencyPhone({ demoCalls: false }), 'tel:911');
  assert.equal(emergencyPhone({ demoCalls: true, demoNumber: '+15550000001' }), 'tel:+15550000001');
  assert.throws(() => emergencyPhone({ demoCalls: true, demoNumber: '' }));
  assert.throws(() => phoneUrl('911;123')); assert.throws(() => serverUrl('file:///secret'));
  assert.equal(serverUrl('http://172.20.10.2:3000/'), 'http://172.20.10.2:3000');
});
test('poll fetches both read-only routes and propagates any failed response', async () => {
  const paths = [];
  const result = await poll('http://laptop:3000', { fetcher: async (url, options) => {
    paths.push([new URL(url).pathname, options.method]);
    return { ok: true, json: async () => url.endsWith('/status') ? snapshot : { entries: [] } };
  } });
  assert.deepEqual(paths.sort(), [['/history', 'GET'], ['/status', 'GET']]); assert.deepEqual(result.snapshot, snapshot);
  await assert.rejects(poll('http://laptop:3000', { fetcher: async () => ({ ok: false, status: 500 }) }));
});
test('hung requests abort and acknowledgement sends no body', async () => {
  await assert.rejects(request('http://laptop:3000', '/status', { timeoutMs: 5, fetcher: (_, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /aborted/);
  await request('http://laptop:3000', '/on-my-way', { method: 'POST', fetcher: async (_, options) => {
    assert.equal(options.method, 'POST'); assert.equal(options.body, undefined); return { ok: true, json: async () => ({ ok: true }) };
  } });
});

test('laptop clock skew never suppresses a fresh emergency; local receipt expiry does', () => {
  for (const lastSeen of [-900000, 900000]) {
    assert.equal(makeView({ ...snapshot, lastSeen }, true, 2000, 1000).emergency, true);
    assert.equal(makeView({ ...snapshot, lastSeen }, true, 11000, 1000).online, false);
  }
});
test('latched emergency with an empty seat does not claim occupancy', () => {
  assert.match(emergencyCopy(status), /occupied seat/);
  assert.doesNotMatch(emergencyCopy({ ...status, presence: false }), /occupied/);
});

test('sensor row preserves zero and decimals and distinguishes unknown motion from no movement', () => {
  assert.deepEqual(sensorReadings({ presence: true, motion: null, battery: 0 }), [
    { label: 'Seat', value: 'Yes' }, { label: 'Movement', value: '—' }, { label: 'Battery', value: '0%' },
  ]);
  assert.deepEqual(sensorReadings({ presence: false, motion: false, battery: null }).map(r => r.value), ['No', 'None', '—']);
  // An old-firmware status still carrying humidity shows no humidity reading.
  assert.deepEqual(sensorReadings({ presence: true, motion: null, humidity: 41, battery: 88 }).map(r => r.label), ['Seat', 'Movement', 'Battery']);
  assert.equal(sensorReadings({ motion: true })[1].value, 'Seen');
});
test('losing the box at WARNING or EMERGENCY stays an alarm; lower levels do not', () => {
  for (const state of ['WARNING', 'EMERGENCY']) {
    const s2 = { ...status, state };
    for (const vm of [viewModel({ ...snapshot, status: s2 }, false, 2000), viewModel({ ...snapshot, status: s2 }, true, 11000), viewModel({ ...snapshot, online: false, status: s2 }, true, 2000)]) {
      assert.equal(vm.lostAlarm, true, state); assert.equal(vm.online, false); assert.equal(vm.emergency, false);
    }
    assert.equal(viewModel({ ...snapshot, status: s2 }, true, 2000).lostAlarm, false, 'online');
  }
  for (const state of ['IDLE', 'ARMED', 'OCCUPANT']) assert.equal(viewModel({ ...snapshot, status: { ...status, state } }, false, 2000).lostAlarm, false, state);
  assert.equal(viewModel(null, false, 2000).lostAlarm, false, 'no reading yet');
});
test('lost-alarm copy names the last alert and when the box was last heard', () => {
  assert.deepEqual(lostAlarmCopy({ state: 'EMERGENCY' }, '10:42:03 AM'), { title: 'No updates since 10:42:03 AM · last alert EMERGENCY', body: 'The box alarms on its own without Wi-Fi. Go to the car now.' });
  assert.equal(lostAlarmCopy({ state: 'WARNING' }, null).title, 'No updates · last alert WARNING');
});
