import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readLimits, validateScenario, toLine, prepare, parseJsonl, firmwareBehaviorSection, buildPrompt,
  scenariosFromAnswer, askGemini, parseArgs, LEVELS,
} from '../challenger.js';

// No network here: Gemini is always a stub fetch.

const limits = readLimits();
const good = () => ({ name: 'bag on the seat', presence: [true, 1, 0, false], tempF: [80, 80.5, 81, 81.25], expected: 'OCCUPANT' });

test('limits come from challenger.h', () => {
  assert.deepEqual(limits, { maxSteps: 600, minTempF: 0, maxTempF: 200 });
  assert.throws(() => readLimits('static const uint16_t CHALLENGER_MAX_STEPS = 10 * 60;'), /CHALLENGER_MAX_STEPS/);
});

test('a well-formed scenario is valid', () => {
  assert.equal(validateScenario(good(), limits), null);
  for (const level of LEVELS) assert.equal(validateScenario({ ...good(), expected: level }, limits), null);
});

test('invalid scenarios are named, not graded', () => {
  const cases = [
    [null, /object/],
    [[], /object/],
    [{ ...good(), name: '  ' }, /name/],
    [{ ...good(), name: 7 }, /name/],
    [{ ...good(), expected: 'occupant' }, /expected/],
    [{ ...good(), expected: 'DANGER' }, /expected/],
    [{ ...good(), presence: '1111' }, /arrays/],
    [{ ...good(), presence: [], tempF: [] }, /no steps/],
    [{ ...good(), presence: [1, 1, 1] }, /lengths/],
    [{ ...good(), presence: [1, 2, 0, 0] }, /presence/],
    [{ ...good(), presence: [1, '1', 0, 0] }, /presence/],
    [{ ...good(), tempF: [80, '80', 80, 80] }, /finite/],
    [{ ...good(), tempF: [80, NaN, 80, 80] }, /finite/],
    [{ ...good(), tempF: [80, Infinity, 80, 80] }, /finite/],
    [{ ...good(), tempF: [80, 80, 80, 201] }, /tempF entries must be/],
    [{ ...good(), tempF: [80, 80, -1, 80] }, /tempF entries must be/],
    [{ ...good(), presence: Array(601).fill(1), tempF: Array(601).fill(80) }, /more than 600/],
  ];
  for (const [s, reason] of cases) assert.match(validateScenario(s, limits) ?? 'valid', reason, JSON.stringify(s)?.slice(0, 80));
  assert.equal(validateScenario({ ...good(), presence: Array(600).fill(1), tempF: Array(600).fill(80) }, limits), null);
});

test('toLine writes the harness line format', () => {
  assert.equal(toLine(good()), 'bag on the seat\tOCCUPANT\t1100\t80,80.5,81,81.25');
  assert.equal(toLine({ ...good(), name: 'a\tb\nc' }).split('\t').length, 4);
  assert.match(toLine({ ...good(), name: 'a\tb\nc' }), /^a b c\t/);
});

test('prepare keeps valid lines and lists invalid ones', () => {
  const { lines, invalid } = prepare([good(), { name: 'short', presence: [1], tempF: [], expected: 'ARMED' }, 42], limits);
  assert.equal(lines.length, 1);
  assert.deepEqual(invalid.map((i) => i.name), ['short', '(no name)']);
});

test('parseJsonl skips comments and keeps unreadable lines as invalid', () => {
  const rows = parseJsonl(`# note\n\n${JSON.stringify(good())}\r\n{not json\n`);
  assert.equal(rows.length, 2);
  assert.equal(validateScenario(rows[0], limits), null);
  assert.notEqual(validateScenario(rows[1], limits), null);
});

test('the shipped example file has 3 valid scenarios and 1 invalid', () => {
  const rows = parseJsonl(readFileSync(new URL('../challenger/example.jsonl', import.meta.url), 'utf8'));
  const { lines, invalid } = prepare(rows, limits);
  assert.equal(lines.length, 3);
  assert.equal(invalid.length, 1);
});

test('the prompt carries the firmware doc section, not its own thresholds', () => {
  const md = readFileSync(new URL('../../docs/firmware.md', import.meta.url), 'utf8');
  const section = firmwareBehaviorSection(md);
  assert.match(section, /^## Firmware behavior/);
  assert.match(section, /\| EMERGENCY \|/);
  assert.match(section, /Minutes to danger/);
  assert.doesNotMatch(section, /\n## Data format/);
  assert.throws(() => firmwareBehaviorSection('# nothing'), /Firmware behavior/);

  const prompt = buildPrompt({ section: 'DOC-SECTION', count: 20, limits });
  assert.match(prompt, /DOC-SECTION/);
  assert.match(prompt, /Write 20 scenarios/);
  assert.match(prompt, /JSON only/);
  // Thresholds and timing come only from the doc section.
  assert.doesNotMatch(prompt, /95|104|30 s|2 s|0\.05/);
});

test('scenariosFromAnswer reads the JSON array from the text parts', () => {
  const answer = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });
  assert.deepEqual(scenariosFromAnswer(answer(JSON.stringify([good()]))), [good()]);
  assert.deepEqual(scenariosFromAnswer(answer('```json\n[]\n```')), []);
  assert.deepEqual(scenariosFromAnswer(answer(JSON.stringify({ scenarios: [good()] }))), [good()]);
  assert.throws(() => scenariosFromAnswer(answer('here you go')), /not a JSON array/);
  assert.throws(() => scenariosFromAnswer({}), /no text/);
});

const okAnswer = (scenarios) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(scenarios) }] } }] }));

test('askGemini retries 503 and timeouts, then succeeds; key only in the header', async () => {
  const calls = [];
  const replies = [
    () => new Response('busy', { status: 503 }),
    () => { throw new DOMException('timed out', 'TimeoutError'); },
    () => okAnswer([good()]),
  ];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return replies[calls.length - 1](); };
  const logs = [];
  const got = await askGemini({ apiKey: 'SECRET-KEY', model: 'm-1', prompt: 'p' }, { fetchFn, delays: [0, 0, 0], log: (l) => logs.push(l) });
  assert.deepEqual(got, [good()]);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /models\/m-1:generateContent$/);
  assert.doesNotMatch(calls[0].url, /SECRET-KEY/);
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'SECRET-KEY');
  assert.equal(logs.length, 2);
  assert.ok(logs.every((l) => !l.includes('SECRET-KEY')));
});

test('askGemini gives up after the retries and never leaks the key', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return new Response('busy', { status: 503 }); };
  await assert.rejects(
    askGemini({ apiKey: 'SECRET-KEY', model: 'm', prompt: 'p' }, { fetchFn, delays: [0, 0], log: () => {} }),
    (err) => /503; gave up after 3 tries/.test(err.message) && !err.message.includes('SECRET-KEY'),
  );
  assert.equal(n, 3);
});

test('askGemini does not retry a 400 or an unreadable answer', async () => {
  let n = 0;
  const bad = async () => { n++; return new Response('no', { status: 400 }); };
  await assert.rejects(askGemini({ apiKey: 'k', model: 'm', prompt: 'p' }, { fetchFn: bad, delays: [0, 0], log: () => {} }), /answered 400/);
  assert.equal(n, 1);
  const prose = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'sorry' }] } }] }));
  await assert.rejects(askGemini({ apiKey: 'k', model: 'm', prompt: 'p' }, { fetchFn: prose, delays: [0], log: () => {} }), /not a JSON array/);
});

test('parseArgs needs exactly one of --count and --from', () => {
  assert.deepEqual(parseArgs(['--count', '200']), { count: 200, from: null });
  assert.deepEqual(parseArgs(['--from', 'x.jsonl']), { count: null, from: 'x.jsonl' });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--count', '5', '--from', 'x']), /usage/);
  assert.throws(() => parseArgs(['--count', '0']), /positive/);
  assert.throws(() => parseArgs(['--count', 'ten']), /positive/);
  assert.throws(() => parseArgs(['--url', 'http://127.0.0.1:3000']), /unexpected/);
});
