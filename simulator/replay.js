// Replays a recorded box session to the server, one status per POST, the way
// the ESP8266 forwards the Mega's lines. Run from the repo root:
//   node simulator/replay.js <recording.jsonl> --url URL [--interval-ms N] [--token T]
// --token T sends `X-Echo-Token: T`, for a server with ECHO_BOX_TOKEN set.
// --url is required, with no default, so a replay never lands on a live
// server by accident.
// A recording is the Mega's Serial output: one status JSON object per line.
// Lines that don't start with `{` (the Mega's `#` notes, blanks) are skipped,
// as the ESP does. Each line is posted as-is; the server validates it.
// Default pace is the box's status period; --interval-ms makes it faster.
// Any non-2xx answer or network error stops the replay with an error.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node simulator/replay.js <recording.jsonl> --url URL [--interval-ms N] [--token T]\n'
  + '  --url is required, e.g. http://127.0.0.1:3000/status';
// The box's status period, docs/firmware.md "Data format and Wi-Fi".
export const BOX_INTERVAL_MS = 2000;

// The status lines of a recording, in order, trimmed (Serial lines end in \r\n).
export function statusLines(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Posts each line to `url`, the first at once and the rest every `intervalMs`
// from the start (no drift). Resolves to the number of lines posted; rejects
// on the first non-2xx answer or network error. `onPost(index, line, res)` is
// called after each successful post. `url` is required. With `token`, each
// post carries it in the X-Echo-Token header (the JSON is unchanged).
export async function replay(lines, {
  url, intervalMs = BOX_INTERVAL_MS, fetchFn = fetch, onPost = () => {}, token,
} = {}) {
  if (!url) throw new Error('replay needs a url');
  const start = Date.now();
  for (let i = 0; i < lines.length; i++) {
    const wait = start + i * intervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Echo-Token': token } : {}) },
      body: lines[i],
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`line ${i + 1} of ${lines.length}: server answered ${res.status} ${text.slice(0, 200)}`);
    }
    onPost(i, lines[i], res);
  }
  return lines.length;
}

// Parses CLI args into { file, url, intervalMs }, plus `token` if --token is
// given. Throws on anything unknown.
export function parseArgs(argv) {
  const opts = { file: null, url: null, intervalMs: BOX_INTERVAL_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') {
      opts.url = argv[++i];
      if (!opts.url) throw new Error('--url needs a value');
    } else if (arg === '--interval-ms') {
      const raw = argv[++i];
      if (!/^\d+$/.test(raw ?? '')) throw new Error('--interval-ms needs a whole number of milliseconds');
      opts.intervalMs = Number(raw);
    } else if (arg === '--token') {
      opts.token = argv[++i];
      if (!opts.token) throw new Error('--token needs a value');
    } else if (arg.startsWith('-') || opts.file) {
      throw new Error(`unexpected argument: ${arg}`);
    } else {
      opts.file = arg;
    }
  }
  if (!opts.file || !opts.url) throw new Error(USAGE);
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { file, url, intervalMs, token } = parseArgs(process.argv.slice(2));
    const lines = statusLines(readFileSync(file, 'utf8'));
    console.log(`replay: ${lines.length} statuses from ${file} to ${url}, every ${intervalMs} ms`);
    await replay(lines, {
      url,
      intervalMs,
      token,
      onPost: (i, line) => {
        let state = '?';
        try { state = JSON.parse(line).state; } catch { /* the server already accepted it */ }
        console.log(`replay: ${i + 1}/${lines.length} ${state}`);
      },
    });
    console.log('replay: done');
  } catch (err) {
    console.error(`replay: ${err.message}`);
    process.exitCode = 1;
  }
}
