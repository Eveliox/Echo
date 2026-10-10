// The ElevenLabs outbound-call request (ticket #19), on fake fetches only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVENLABS_OUTBOUND_URL, elevenLabsDialer, missingElevenLabsSettings, readElevenLabsConfig,
} from '../elevenlabs.js';

const config = { apiKey: 'fake-eleven-key', agentId: 'agent_fake', phoneNumberId: 'phnum_fake' };
const TO = '+15550000002';
const variables = { temp_f: '104.5', mins_to_danger: '3' };

// A fetch that records its request and answers `status` with `body`.
function fakeFetch(status, body) {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { seen, fetchFn };
}

test('reads the three ElevenLabs keys; blank or whitespace is unset, and only names are reported missing', () => {
  const env = { ELEVENLABS_API_KEY: ' k ', ELEVENLABS_AGENT_ID: 'a', ELEVENLABS_PHONE_NUMBER_ID: 'p' };
  assert.deepEqual(readElevenLabsConfig(env), { apiKey: 'k', agentId: 'a', phoneNumberId: 'p' });
  assert.deepEqual(missingElevenLabsSettings(readElevenLabsConfig(env)), []);
  assert.deepEqual(missingElevenLabsSettings(readElevenLabsConfig({ ...env, ELEVENLABS_AGENT_ID: '  ' })), ['ELEVENLABS_AGENT_ID']);
  assert.deepEqual(missingElevenLabsSettings(readElevenLabsConfig({})),
    ['ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID']);
  assert.equal(missingElevenLabsSettings(undefined).length, 3);
});

test('the outbound call is one POST with the key in xi-api-key, the agent, number, first message and variables', async () => {
  const f = fakeFetch(200, { success: true, message: 'ok', conversation_id: 'conv_1', callSid: 'CA1' });
  const result = await elevenLabsDialer(config, { fetchFn: f.fetchFn })({ to: TO, firstMessage: 'This is Echo.', variables });
  assert.deepEqual(result, { conversationId: 'conv_1', callSid: 'CA1' });
  assert.equal(f.seen.length, 1);
  const { url, init } = f.seen[0];
  assert.equal(url, ELEVENLABS_OUTBOUND_URL);
  assert.equal(url, 'https://api.elevenlabs.io/v1/convai/twilio/outbound-call');
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, { 'Content-Type': 'application/json', 'xi-api-key': 'fake-eleven-key' });
  assert.ok(!url.includes('fake-eleven-key'), 'the key never goes in the URL');
  assert.deepEqual(JSON.parse(init.body), {
    agent_id: 'agent_fake',
    agent_phone_number_id: 'phnum_fake',
    to_number: TO,
    conversation_initiation_client_data: {
      dynamic_variables: variables,
      conversation_config_override: { agent: { first_message: 'This is Echo.' } },
    },
  });
  assert.ok(init.signal instanceof AbortSignal, 'always bounded in time');
});

test('an abort from the caller reaches the request', async () => {
  const abort = new AbortController();
  let signal;
  const fetchFn = (url, init) => {
    ({ signal } = init);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  const started = elevenLabsDialer(config, { fetchFn })({ to: TO, firstMessage: 'x', variables, signal: abort.signal });
  abort.abort(new Error('caller gave up'));
  await assert.rejects(started, /the ElevenLabs request failed or timed out/);
  assert.equal(signal.aborted, true);
});

test('a refused or unreadable answer throws fixed text: never the key, the number, or ElevenLabs\' answer', async () => {
  const leaky = `bad number ${TO} for key fake-eleven-key`;
  const cases = [
    [400, { detail: leaky }, /^ElevenLabs answered 400$/],
    [401, leaky, /^ElevenLabs answered 401$/],
    [422, { detail: [{ msg: leaky }] }, /^ElevenLabs answered 422$/],
    [500, leaky, /^ElevenLabs answered 500$/],
    [200, { success: false, message: leaky, conversation_id: null, callSid: null }, /^ElevenLabs did not accept the call$/],
    [200, { message: leaky }, /^ElevenLabs did not accept the call$/],
    [200, `not json ${leaky}`, /^the ElevenLabs answer was not readable JSON$/],
  ];
  for (const [status, body, expected] of cases) {
    const f = fakeFetch(status, body);
    await assert.rejects(elevenLabsDialer(config, { fetchFn: f.fetchFn })({ to: TO, firstMessage: 'x', variables }), (err) => {
      assert.match(err.message, expected);
      assert.ok(!err.message.includes(TO) && !err.message.includes('fake-eleven-key'), err.message);
      return true;
    });
  }
  const thrown = elevenLabsDialer(config, { fetchFn: () => { throw new Error(`down ${TO}`); } });
  await assert.rejects(thrown({ to: TO, firstMessage: 'x', variables }), /^Error: the ElevenLabs request failed or timed out$/);
});
