import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityRows } from '../src/activity.js';
import { poll, readResource } from '../src/client.js';

const action = (time, overrides = {}) => ({ time: new Date(time).toISOString(), action: 'call', to: 'Mom', reason: 'ladder step 1: not live; not dialed', ...overrides });
const sample = (receivedAt, state) => ({ receivedAt, status: { state } });
test('activity merges actions and actual level changes newest first and preserves exact reasons', () => {
  const rows = activityRows([action(1500), action(3500, { action: 'note', to: 'App', reason: "I'm on my way; alarm and backup calls continue." })], [sample(1000, 'ARMED'), sample(2000, 'WARNING'), sample(2500, 'WARNING'), sample(3000, 'EMERGENCY')]);
  assert.deepEqual(rows.map(row => row.title), ['Note logged · App', 'Emergency', 'Getting hot', 'Call logged · Mom']);
  assert.equal(rows[0].reason, "I'm on my way; alarm and backup calls continue.");
  assert.equal(rows.at(-1).reason, 'ladder step 1: not live; not dialed');
  assert.doesNotMatch(JSON.stringify(rows), /Calling now|answered|transcript/);
});
test('repeated levels produce one change; initial window sample does not invent a start event', () => {
  assert.deepEqual(activityRows([], [sample(1000, 'EMERGENCY'), sample(2000, 'EMERGENCY')]), []);
  const history = [sample(1000, 'ARMED'), sample(2000, 'WARNING'), sample(3000, 'WARNING')];
  assert.equal(activityRows([], history).length, 1);
  assert.deepEqual(activityRows([], history), activityRows([], history));
  assert.equal(activityRows([], [...history, sample(4000, 'ARMED'), sample(5000, 'WARNING')]).filter(row => row.title === 'Getting hot').length, 2);
});
test('ties have deterministic distinct keys which survive older unrelated record eviction', () => {
  const actions = [action(1000), action(2000), action(2000), action(2000, { to: 'Alex' })];
  const rows = activityRows(actions);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  assert.deepEqual(rows.slice(0, 3), activityRows(actions.slice(1)));
  assert.deepEqual(rows, activityRows(actions));
});
test('all log action types stay records and malformed entries are skipped', () => {
  for (const kind of ['call', 'call_failed', 'skip', 'message', 'note', 'rejected', 'unknown']) {
    assert.equal(activityRows([action(1000, { action: kind })]).length, 1);
  }
  assert.deepEqual(activityRows([{ time: 'bad' }, action(1000, { reason: null })]), []);
});
test('actions and contacts use separate GETs, project contact names, and validate responses', async () => {
  const paths = [];
  const options = { fetcher: async (url, init) => {
    paths.push([new URL(url).pathname, init.method]);
    return { ok: true, json: async () => url.endsWith('/actions') ? { entries: [action(1000)] } : [{ order: 1, name: 'Mom', number: 'not for display' }] };
  } };
  assert.equal((await readResource('http://laptop', '/actions', options)).length, 1);
  assert.deepEqual(await readResource('http://laptop', '/contacts', options), [{ order: 1, name: 'Mom' }]);
  assert.deepEqual(paths, [['/actions', 'GET'], ['/contacts', 'GET']]);
  await assert.rejects(readResource('http://laptop', '/contacts', { fetcher: async () => ({ ok: true, json: async () => ({ contacts: [] }) }) }));
});
test('failed auxiliary endpoints do not stop a fresh car poll; next action poll includes new records', async () => {
  let entries = [];
  const options = { fetcher: async url => ({ ok: !url.endsWith('/contacts'), status: 500, json: async () => url.endsWith('/status') ? { online: true, lastSeen: 1000, status: { state: 'EMERGENCY' } } : { entries } }) };
  const [car, contacts] = await Promise.allSettled([poll('http://laptop', options), readResource('http://laptop', '/contacts', options)]);
  assert.equal(car.status, 'fulfilled'); assert.equal(car.value.snapshot.online, true); assert.equal(contacts.status, 'rejected');
  assert.deepEqual(await readResource('http://laptop', '/actions', options), []);
  entries = [action(2000)];
  assert.equal(activityRows(await readResource('http://laptop', '/actions', options))[0].time, 2000);
});

test('multiple transitions at the same receipt millisecond still have unique stable IDs', () => {
  const history = ['ARMED', 'WARNING', 'ARMED', 'WARNING'].map(state => sample(1000, state));
  const rows = activityRows([], history);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.id)).size, 3);
  assert.deepEqual(rows, activityRows([], history));
});
