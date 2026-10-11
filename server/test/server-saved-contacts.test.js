// POST /saved-contacts: the app saves a contact list for the next server
// start. PIN-gated, locked during an incident, and never changes the running
// server's contacts (GET /contacts stays the startup list).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, MAX_PIN_FAILURES } from '../server.js';
import { createActionLog } from '../actions.js';

const PIN = '482916';
const startup = [{ name: 'Mom', number: '+15550000001' }];
const list = [{ name: 'Grandma', number: '+13055550100' }, { name: 'Alex', number: '+13055550101' }];

async function setup(t, options = {}) {
  const saves = [];
  const actions = createActionLog();
  let clock = 1_000_000;
  const server = createServer({
    contacts: startup, contactsPin: PIN, saveContactList: (l) => saves.push(l), actions,
    now: () => clock, ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, raw) => {
    const res = await fetch(`${base}/saved-contacts`, { method: 'POST', body: raw ?? JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { base, post, saves, actions, tick: (ms) => { clock += ms; } };
}

test('the right PIN and a valid list are saved and noted; the running contacts do not change', async (t) => {
  const { base, post, saves, actions } = await setup(t);
  const res = await post({ pin: PIN, contacts: list });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, saved: 2, appliesAfterRestart: true });
  assert.deepEqual(saves, [list]);
  const [entry] = actions.entries();
  assert.equal(entry.action, 'note');
  assert.match(entry.reason, /Saved 2 emergency contacts from the app; they take effect when the server restarts/);
  assert.ok(!JSON.stringify(actions.entries()).includes('+1305'), 'no numbers in the action log');
  assert.deepEqual(await (await fetch(`${base}/contacts`)).json(), [{ order: 1, name: 'Mom' }]);
});

test('off without a PIN or a saver: 403, nothing saved', async (t) => {
  for (const options of [{ contactsPin: '' }, { saveContactList: null }]) {
    const { post, saves } = await setup(t, options);
    assert.equal((await post({ pin: PIN, contacts: list })).status, 403);
    assert.equal(saves.length, 0);
  }
});

test('a wrong or missing PIN is 401; after MAX_PIN_FAILURES every attempt waits a minute', async (t) => {
  const { post, saves, tick } = await setup(t);
  for (const pin of [undefined, 482916, '', '000000']) {
    assert.equal((await post({ pin, contacts: list })).status, 401, String(pin));
  }
  for (let i = 4; i < MAX_PIN_FAILURES; i += 1) assert.equal((await post({ pin: 'nope', contacts: list })).status, 401);
  const locked = await post({ pin: PIN, contacts: list });
  assert.equal(locked.status, 429, 'even the right PIN waits');
  assert.match(locked.body.error, /Wait a minute/);
  tick(60_000);
  assert.equal((await post({ pin: PIN, contacts: list })).status, 200);
  assert.equal(saves.length, 1);
});

test('during an incident the list is refused with 409', async (t) => {
  let incident = true;
  const { post, saves } = await setup(t, { contactsLocked: () => incident });
  const res = await post({ pin: PIN, contacts: list });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /emergency is in progress/);
  incident = false;
  assert.equal((await post({ pin: PIN, contacts: list })).status, 200);
  assert.equal(saves.length, 1);
});

test('a bad list, bad JSON, or a big body is refused and nothing is saved', async (t) => {
  const { post, saves, actions } = await setup(t);
  for (const contacts of [[], [{ name: 'Mom', number: '3055550100' }], undefined]) {
    const res = await post({ pin: PIN, contacts });
    assert.equal(res.status, 400);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal((await post(null, 'not json')).status, 400);
  assert.equal((await post(null, JSON.stringify({ pin: PIN, contacts: list, pad: 'x'.repeat(5000) }))).status, 413);
  assert.equal(saves.length, 0);
  assert.equal(actions.entries().length, 0);
});

test('only POST', async (t) => {
  const { base } = await setup(t);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await fetch(`${base}/saved-contacts`, { method });
    assert.equal(res.status, 405, method);
    await res.arrayBuffer();
  }
});
