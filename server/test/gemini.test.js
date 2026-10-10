import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  geminiModel, readGeminiConfig, responderStartupMessage, DEFAULT_GEMINI_MODEL,
} from '../gemini.js';
import { createResponder, SYSTEM_PROMPT, TOOLS } from '../responder.js';
import { createActionLog } from '../actions.js';

const KEY = 'fake-gemini-key-123';
const input = { system: SYSTEM_PROMPT, prompt: 'Car: {}', tools: TOOLS };

// A fetch that records each request and answers with `answer()`.
function fakeFetch(answer) {
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return answer(url, init);
  };
  return { requests, fetchFn };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const functionCall = (name, args) => json({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });

test('sends one generateContent POST with the key in the header only and the three tools', async () => {
  const { requests, fetchFn } = fakeFetch(() => functionCall('log_action', { note: 'hi' }));
  const ask = geminiModel({ apiKey: KEY, model: 'gemini-test' }, { fetchFn });
  assert.deepEqual(await ask(input), { name: 'log_action', args: { note: 'hi' } });
  assert.equal(requests.length, 1);
  const [{ url, init, body }] = requests;
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
  assert.ok(!url.includes(KEY), 'the key is never in the URL');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body.tools[0].functionDeclarations.map((t) => t.name),
    ['get_car_status', 'place_call', 'log_action']);
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY' } });
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  assert.equal(body.contents[0].parts[0].text, 'Car: {}');
  assert.ok(!init.body.includes(KEY));
});

test('a function call without args gives {}; an answer without one gives null', async () => {
  const noArgs = geminiModel({ apiKey: KEY, model: 'm' }, {
    fetchFn: async () => json({ candidates: [{ content: { parts: [{ text: 'hm' }, { functionCall: { name: 'get_car_status' } }] } }] }),
  });
  assert.deepEqual(await noArgs(input), { name: 'get_car_status', args: {} });
  for (const answer of [{}, { candidates: [] }, { candidates: [{ content: { parts: [{ text: 'just words' }] } }] }]) {
    const ask = geminiModel({ apiKey: KEY, model: 'm' }, { fetchFn: async () => json(answer) });
    assert.equal(await ask(input), null);
  }
});

test('errors are fixed text and a status code, never the key or Gemini\'s answer', async () => {
  const cases = [
    [async () => json({ error: { message: `bad key ${KEY}` } }, 403), /^Gemini answered 403$/],
    [async () => { throw new Error(`connect failed for ${KEY}`); }, /^the Gemini request failed or timed out$/],
    [async () => new Response(`not json ${KEY}`, { status: 200 }), /^the Gemini answer was not readable JSON$/],
  ];
  for (const [fetchFn, expected] of cases) {
    const ask = geminiModel({ apiKey: KEY, model: 'm' }, { fetchFn });
    await assert.rejects(ask(input), (err) => {
      assert.match(err.message, expected);
      assert.ok(!err.message.includes(KEY));
      return true;
    });
  }
});

test('the Responder\'s abort reaches the request', async () => {
  let seen;
  const ask = geminiModel({ apiKey: KEY, model: 'm' }, {
    fetchFn: (url, init) => new Promise((_, reject) => {
      seen = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
  });
  const abort = new AbortController();
  const pending = ask({ ...input, signal: abort.signal });
  abort.abort();
  await assert.rejects(pending, /^Error: the Gemini request failed or timed out$/);
  assert.equal(seen.aborted, true);
});

test('the request body a real turn sends holds contact names but never a phone number', async () => {
  const contacts = [{ name: 'Mom', number: '+15550000001' }, { name: 'Alex', number: '+15550000002' }];
  const { requests, fetchFn } = fakeFetch(() => functionCall('log_action', { note: 'ok' }));
  const actions = createActionLog();
  actions.record({ action: 'call', to: 'Mom', reason: 'ladder step 1: tempF 104.5, minsToDanger 2' });
  const status = {
    state: 'EMERGENCY', tempF: 104.5, humidity: 40, presence: true, distanceCm: 30, motion: null, minsToDanger: 2, battery: null,
  };
  const responder = createResponder({
    contacts,
    call: async () => ({ ok: true, dialed: false }),
    actions,
    getStatus: () => ({ online: true, lastSeen: 1, status }),
    model: geminiModel({ apiKey: KEY, model: 'm' }, { fetchFn }),
    log: () => {},
    logError: () => {},
  });
  await responder.onStatus(status);
  assert.equal(requests.length, 1);
  const sent = requests[0].init.body;
  assert.match(sent, /\\"Mom\\",\\"Alex\\"/);
  for (const { number } of contacts) assert.ok(!sent.includes(number.slice(2)), number);
});

test('config: blank or missing key means off; GEMINI_MODEL overrides the default', () => {
  assert.deepEqual(readGeminiConfig({}), { apiKey: '', model: DEFAULT_GEMINI_MODEL });
  assert.deepEqual(readGeminiConfig({ GEMINI_API_KEY: '  ', GEMINI_MODEL: ' ' }), { apiKey: '', model: DEFAULT_GEMINI_MODEL });
  assert.deepEqual(readGeminiConfig({ GEMINI_API_KEY: ` ${KEY} `, GEMINI_MODEL: 'gemini-x' }), { apiKey: KEY, model: 'gemini-x' });
});

test('startup line: off without a key, on with one, never the key', () => {
  assert.equal(responderStartupMessage(readGeminiConfig({})), 'responder: off (no GEMINI_API_KEY)');
  const on = responderStartupMessage(readGeminiConfig({ GEMINI_API_KEY: KEY }));
  assert.match(on, /^responder: on \(Gemini /);
  assert.ok(!on.includes(KEY));
});

test('defaults to 3.8 Flash and asks for low thinking (2.5 Flash answers 404 for new accounts)', async () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.8-flash');
  const { requests, fetchFn } = fakeFetch(() => functionCall('log_action', { note: 'hi' }));
  await geminiModel({ apiKey: KEY, model: DEFAULT_GEMINI_MODEL }, { fetchFn })(input);
  assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.deepEqual(requests[0].body.generationConfig, { thinkingConfig: { thinkingLevel: 'low' } });
});
