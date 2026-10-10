import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';
import { readConfig } from '../calls.js';

async function setup(t, contacts) {
  const server = createServer({ contacts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}/contacts`;
}
test('GET contacts exposes only configured names and fixed ladder order, never numbers or extra fields', async t => {
  const config = readConfig({ CONTACT1_NAME: 'Mom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: 'Alex', CONTACT2_NUMBER: '+15550000002' });
  config.contacts[0].secret = 'private metadata';
  const url = await setup(t, config.contacts);
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), [{ order: 1, name: 'Mom' }, { order: 2, name: 'Alex' }]);
  for (const hidden of ['+15550000001', '+15550000002', 'number', 'private metadata', 'secret']) assert.ok(!text.includes(hidden));
});
test('contacts with missing numbers retain their original ladder slots and names', async t => {
  const config = readConfig({ CONTACT1_NAME: 'Parent', CONTACT2_NAME: 'Neighbor', CONTACT2_NUMBER: '+15550000002' });
  const url = await setup(t, config.contacts);
  assert.deepEqual(await (await fetch(url)).json(), [{ order: 1, name: 'Parent' }, { order: 2, name: 'Neighbor' }]);
});
test('contacts endpoint rejects writes and cannot reorder or replace the configuration', async t => {
  const url = await setup(t, [{ name: 'Mom', number: '+15550000001' }]);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(url, { method, body: JSON.stringify([{ order: 1, name: 'Intruder' }]) });
    assert.equal(response.status, 405); await response.arrayBuffer();
  }
  assert.deepEqual(await (await fetch(url)).json(), [{ order: 1, name: 'Mom' }]);
});
