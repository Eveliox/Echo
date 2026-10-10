// Challenger agent (#22, docs/brief.md): Gemini invents tricky scenarios, the
// real box logic grades them. Development only: never in a Checks row, never
// talks to the Echo server. Run from the repo root:
//   node simulator/challenger.js --count 200      ask Gemini, then grade
//   node simulator/challenger.js --from <file>    re-grade a saved file, offline
// --from takes the .jsonl this script saves (one scenario object per line).
//
// Scenarios use the brief's format { name, presence: [...], tempF: [...],
// expected }. This file only parses and validates JSON; pass/fail comes from
// firmware/mega/test/challenger_run.cpp (built with g++ into a temp folder),
// which runs each scenario through firmware/mega/logic.h. Mapping and limits:
// firmware/mega/test/challenger.h.
//
// The Gemini key comes from server/.env (GEMINI_API_KEY, GEMINI_MODEL), the
// same file and names as the server. Generated files go to
// simulator/challenger/*.generated.* (git-ignored).
//
// A FAIL means the AI's `expected` and the box disagree. Sort each by hand
// against docs/firmware.md; never change logic.h to match an AI `expected`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHALLENGER_H = join(REPO, 'firmware/mega/test/challenger.h');
const HARNESS_CPP = join(REPO, 'firmware/mega/test/challenger_run.cpp');
const FIRMWARE_DOC = join(REPO, 'docs/firmware.md');
const ENV_FILE = join(REPO, 'server/.env');
export const OUT_DIR = join(REPO, 'simulator/challenger');

// Same default as server/gemini.js (see docs/notes.md on pinned model names).
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 120000;  // a batch of long arrays takes a while
const RETRY_DELAYS_MS = [3000, 10000, 30000];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const NAME_MAX = 80;

export const LEVELS = ['IDLE', 'ARMED', 'OCCUPANT', 'WARNING', 'EMERGENCY'];

const USAGE = 'usage: node simulator/challenger.js --count N | --from <file.jsonl>';

// Plain numeric literal constants from challenger.h, so the limits match the
// C++ harness (same approach as simulator/test/recording.test.js).
export function readLimits(source = readFileSync(CHALLENGER_H, 'utf8')) {
  const get = (name) => {
    const m = source.match(new RegExp(`\\b${name}\\s*=\\s*(-?[0-9]+(?:\\.[0-9]+)?)[fFuUlL]*\\s*;`));
    if (!m) throw new Error(`${name}: no plain numeric literal in challenger.h`);
    return Number(m[1]);
  };
  return {
    maxSteps: get('CHALLENGER_MAX_STEPS'),
    minTempF: get('CHALLENGER_MIN_TEMP_F'),
    maxTempF: get('CHALLENGER_MAX_TEMP_F'),
  };
}

// Returns null if `s` is a usable scenario, else a short reason. `presence`
// entries are booleans or 0/1; `tempF` entries finite numbers in range.
export function validateScenario(s, limits) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (typeof s.name !== 'string' || !s.name.trim()) return 'name must be a non-empty string';
  if (!LEVELS.includes(s.expected)) return `expected must be one of ${LEVELS.join(', ')}`;
  if (!Array.isArray(s.presence) || !Array.isArray(s.tempF)) return 'presence and tempF must be arrays';
  if (s.presence.length === 0) return 'no steps';
  if (s.presence.length !== s.tempF.length) return 'presence and tempF lengths differ';
  if (s.presence.length > limits.maxSteps) return `more than ${limits.maxSteps} steps`;
  if (!s.presence.every((p) => p === true || p === false || p === 0 || p === 1)) {
    return 'presence entries must be true/false or 0/1';
  }
  if (!s.tempF.every((t) => typeof t === 'number' && Number.isFinite(t))) return 'tempF entries must be finite numbers';
  if (!s.tempF.every((t) => t >= limits.minTempF && t <= limits.maxTempF)) {
    return `tempF entries must be ${limits.minTempF} to ${limits.maxTempF}`;
  }
  return null;
}

// One line of the harness's format: name<TAB>EXPECTED<TAB>0/1s<TAB>temps.
// Only for validated scenarios. Tabs and newlines in the name become spaces.
export function toLine(s) {
  const name = s.name.replace(/[\t\r\n]+/g, ' ').trim().slice(0, NAME_MAX);
  const presence = s.presence.map((p) => (p === true || p === 1 ? '1' : '0')).join('');
  return `${name}\t${s.expected}\t${presence}\t${s.tempF.map((t) => String(t)).join(',')}`;
}

// Splits scenarios into harness lines and invalid ones ({ name, reason }).
export function prepare(scenarios, limits) {
  const lines = [];
  const invalid = [];
  for (const s of scenarios) {
    const reason = validateScenario(s, limits);
    if (reason) {
      invalid.push({ name: typeof s?.name === 'string' ? s.name : '(no name)', reason });
    } else {
      lines.push(toLine(s));
    }
  }
  return { lines, invalid };
}

// A saved file: one JSON scenario per line. A line that isn't JSON is kept as
// an invalid entry so it still shows in the totals.
export function parseJsonl(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ name: `(unreadable line: ${line.slice(0, 40)})` });
    }
  }
  return out;
}

// The "## Firmware behavior" section of docs/firmware.md: level table,
// leaving a level, seat detection, minutes to danger. Sent to Gemini as-is so
// the prompt never carries its own copy of the thresholds.
export function firmwareBehaviorSection(md) {
  const start = md.indexOf('\n## Firmware behavior');
  if (start < 0) throw new Error('docs/firmware.md has no "## Firmware behavior" section');
  const next = md.indexOf('\n## ', start + 1);
  return md.slice(start + 1, next < 0 ? undefined : next).trim();
}

export function buildPrompt({ section, count, limits }) {
  return [
    'You are the Challenger for Echo, a car-seat heat alarm box. Invent test scenarios that try to break its alert-level logic.',
    'The rules are in this excerpt from the firmware doc. Every "expected" value must follow these rules exactly, not your own idea of what is safe:',
    '<firmware_doc>',
    section,
    '</firmware_doc>',
    'How a scenario runs:',
    '- Each array element is one status period, in order (the doc gives the period length). Element 0 is the first period after the ignition was pulled out.',
    '- The ignition stays out and the cancel button is never pressed for the whole scenario.',
    '- presence[i] is the seat-detection result for that period (already filtered: true means the seat counts as occupied).',
    '- tempF[i] is the LM35 cabin reading for that period, in degrees F. Minutes to danger is computed from these readings exactly as the doc describes.',
    '- "expected" is the alert level after the LAST element, one of IDLE, ARMED, OCCUPANT, WARNING, EMERGENCY.',
    `- presence and tempF have the same length, 1 to ${limits.maxSteps} elements; tempF values between ${limits.minTempF} and ${limits.maxTempF}.`,
    `Write ${count} scenarios. Favor adversarial and edge cases: values right at and just past each threshold, the seat dwell one period short and exactly met,`,
    'seat flicker, cooling or an emptied seat after an alarm, fast and slow warming (minutes to danger needs a full window of readings), heat before the seat counts,',
    'sensor-like noise, long and short scenarios. Give each a short unique descriptive name.',
    'Answer with JSON only: an array of objects { "name": string, "presence": [booleans], "tempF": [numbers], "expected": string }. No prose, no code fences.',
  ].join('\n');
}

// Pulls the scenario array out of a generateContent answer. Throws if absent.
export function scenariosFromAnswer(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  if (!text.trim()) throw new Error('the Gemini answer had no text');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('the Gemini answer was not a JSON array');
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.scenarios)) return parsed.scenarios;
  throw new Error('the Gemini answer was not a JSON array');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One generateContent request for `count` scenarios, retried on timeouts,
// network errors, 429 and 5xx (Gemini's 503 "high demand"). Errors are fixed
// text plus a status code: never the key.
export async function askGemini({ apiKey, model, prompt }, {
  fetchFn = fetch, delays = RETRY_DELAYS_MS, log = console.log, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } },
  };
  for (let attempt = 0; ; attempt++) {
    let problem;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return scenariosFromAnswer(await res.json());
      await res.body?.cancel().catch(() => {});
      if (!RETRY_STATUSES.has(res.status)) throw new Error(`Gemini answered ${res.status}`);
      problem = `Gemini answered ${res.status}`;
    } catch (err) {
      if (/^Gemini answered|^the Gemini answer/.test(err.message)) throw err;
      problem = 'the Gemini request failed or timed out';
    }
    if (attempt >= delays.length) throw new Error(`${problem}; gave up after ${attempt + 1} tries`);
    log(`challenger: ${problem}; retrying in ${delays[attempt] / 1000} s`);
    await sleep(delays[attempt]);
  }
}

export function parseArgs(argv) {
  const opts = { count: null, from: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--count') {
      const raw = argv[++i];
      if (!/^[1-9]\d*$/.test(raw ?? '')) throw new Error('--count needs a positive whole number');
      opts.count = Number(raw);
    } else if (arg === '--from') {
      opts.from = argv[++i];
      if (!opts.from) throw new Error('--from needs a file');
    } else {
      throw new Error(`unexpected argument: ${arg}\n${USAGE}`);
    }
  }
  if ((opts.count === null) === (opts.from === null)) throw new Error(USAGE);
  return opts;
}

// Builds the harness into the temp folder and runs it on `tsvPath`.
function grade(tsvPath) {
  const bin = join(process.env.TMPDIR || tmpdir(), 'echo_challenger_run');
  const build = spawnSync('g++', ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', join(REPO, 'firmware/mega'),
    HARNESS_CPP, '-o', bin], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`building the harness failed:\n${build.stderr || build.error?.message}`);
  const run = spawnSync(bin, [tsvPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status === 2 || run.status === null) throw new Error(`the harness could not run: ${run.stderr || run.error?.message}`);
  const m = run.stdout.match(/challenger: (\d+) scenarios, (\d+) pass, (\d+) fail, (\d+) invalid/);
  if (!m) throw new Error('the harness printed no summary');
  return { output: run.stdout.slice(0, m.index), pass: +m[2], fail: +m[3], invalid: +m[4] };
}

async function generate(count, limits) {
  try {
    process.loadEnvFile(ENV_FILE);  // variables already set win
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const model = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;
  if (!apiKey) throw new Error('no GEMINI_API_KEY in server/.env; use --from <file> to grade a saved file');
  const section = firmwareBehaviorSection(readFileSync(FIRMWARE_DOC, 'utf8'));
  console.log(`challenger: asking Gemini ${model} for ${count} scenarios, ${BATCH_SIZE} per request`);
  const all = [];
  for (let done = 0; done < count; done += BATCH_SIZE) {
    const n = Math.min(BATCH_SIZE, count - done);
    try {
      const got = await askGemini({ apiKey, model, prompt: buildPrompt({ section, count: n, limits }) });
      all.push(...got);
      console.log(`challenger: batch ${done / BATCH_SIZE + 1}: ${got.length} scenarios`);
    } catch (err) {
      console.log(`challenger: batch ${done / BATCH_SIZE + 1} failed: ${err.message}`);
    }
  }
  return { scenarios: all, model };
}

async function main() {
  const { count, from } = parseArgs(process.argv.slice(2));
  const limits = readLimits();
  let scenarios;
  let base;
  if (from) {
    scenarios = parseJsonl(readFileSync(from, 'utf8'));
    base = join(tmpdir(), `echo-challenger-${process.pid}`);
    console.log(`challenger: grading ${scenarios.length} scenarios from ${from} (no Gemini)`);
  } else {
    const gen = await generate(count, limits);
    scenarios = gen.scenarios;
    mkdirSync(OUT_DIR, { recursive: true });
    base = join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.generated`);
    writeFileSync(`${base}.jsonl`, scenarios.map((s) => JSON.stringify(s)).join('\n') + '\n');
    console.log(`challenger: saved ${scenarios.length} scenarios (${gen.model}) to ${base}.jsonl`);
  }
  const { lines, invalid } = prepare(scenarios, limits);
  for (const { name, reason } of invalid) console.log(`INVALID "${name}": ${reason}`);
  writeFileSync(`${base}.tsv`, lines.join('\n') + '\n');
  const result = grade(`${base}.tsv`);
  if (result.output) process.stdout.write(result.output);
  const bad = invalid.length + result.invalid;
  console.log(`challenger: ${scenarios.length} scenarios: ${result.pass} pass, ${result.fail} fail, ${bad} invalid`);
  if (result.fail > 0) console.log('challenger: sort each FAIL against docs/firmware.md by hand; never change logic.h to match an AI expected');
  return result.fail === 0 && bad === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`challenger: ${err.message}`);
    process.exitCode = 2;
  }
}
