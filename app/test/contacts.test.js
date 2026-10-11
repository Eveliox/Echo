import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contactDraftError, MAX_CONTACTS, normalizePhone } from '../src/model.js';
import { saveContacts } from '../src/client.js';

test('typed phone numbers become E.164; US numbers may skip +1', () => {
  for (const [typed, expected] of [['(305) 555-0100', '+13055550100'], ['305.555.0100', '+13055550100'], ['1 305 555 0100', '+13055550100'], ['+44 7700 900123', '+447700900123'], [' +13055550100 ', '+13055550100']]) {
    assert.equal(normalizePhone(typed), expected, typed);
  }
  for (const typed of ['', '555-0100', '305555010', 'call me', '+0305555010', null, 3055550100]) assert.equal(normalizePhone(typed), null, String(typed));
});
test('draft rows need a plain name and a number, with no repeats, 1 to MAX_CONTACTS', () => {
  const row = (name, number) => ({ name, number });
  assert.equal(contactDraftError([row('Mom', '(305) 555-0100'), row('Alex', '305 555 0101')]), null);
  assert.match(contactDraftError([]), /at least one/);
  assert.match(contactDraftError(Array.from({ length: MAX_CONTACTS + 1 }, (_, i) => row(`C${i}`, `305555010${i}`))), /up to 5/);
  assert.match(contactDraftError([row('', '3055550100')]), /Contact 1: add a name/);
  assert.match(contactDraftError([row('<b>Mom</b>', '3055550100')]), /add a name/);
  assert.match(contactDraftError([row('Mom', '555')]), /Contact 1: add a full phone number/);
  assert.match(contactDraftError([row('Mom', '3055550100'), row('mom', '3055550101')]), /Contact 2: mom is already/);
  assert.match(contactDraftError([row('Mom', '3055550100'), row('Alex', '+1 305 555 0100')]), /that number is already/);
});
test('saveContacts posts the PIN and list as JSON and returns the answer', async () => {
  const sent = [];
  const fetcher = async (url, options) => { sent.push({ url, options }); return { ok: true, json: async () => ({ ok: true, saved: 1, appliesAfterRestart: true }) }; };
  const result = await saveContacts('http://172.20.10.2:3000', '482916', [{ name: 'Mom', number: '+13055550100' }], { fetcher });
  assert.deepEqual(result, { ok: true, saved: 1, appliesAfterRestart: true });
  assert.equal(sent[0].url, 'http://172.20.10.2:3000/saved-contacts');
  assert.equal(sent[0].options.method, 'POST');
  assert.equal(sent[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[0].options.body), { pin: '482916', contacts: [{ name: 'Mom', number: '+13055550100' }] });
});
test('saveContacts shows the server\'s error, or a plain one when unreachable', async () => {
  const answer = (status, body) => async () => ({ ok: false, status, json: async () => body });
  await assert.rejects(saveContacts('http://h:3000', '1', [], { fetcher: answer(401, { error: 'That PIN is not right.' }) }), /That PIN is not right\./);
  await assert.rejects(saveContacts('http://h:3000', '1', [], { fetcher: answer(500, null) }), /Could not reach the server\./);
  await assert.rejects(saveContacts('http://h:3000', '1', [], { fetcher: async () => { throw new Error('ECONNREFUSED 10.0.0.1'); } }), /^Error: Could not reach the server\.$/);
});
test('demo save sends nothing to the server and needs no PIN', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: true, json: async () => ({}) }; };
  const result = await saveContacts('', '', [{ name: 'Mom', number: '+13055550100' }, { name: 'Alex', number: '+13055550101' }], { fetcher, demo: true });
  assert.equal(calls, 0);
  assert.deepEqual(result, { ok: true, saved: 2, appliesAfterRestart: true, demo: true });
});
test('an accented name typed in NFD passes', () => {
  assert.equal(contactDraftError([{ name: 'Jose\u0301', number: '3055550100' }]), null);
});
