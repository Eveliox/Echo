// Smoke check (CLAUDE.md Checks, `smoke`): replays a recording through a real
// server end to end and exits non-zero unless the backup ladder made exactly
// one call, and only a logged one. Run from the repo root:
//   ECHO_CALLS=off node simulator/smoke.js [recording.jsonl]
//
// Safety: it never posts to a server it didn't start. It starts its own
// `node server/server.js` on a free port with ECHO_CALLS=off forced in that
// server's environment and its Twilio and contact settings blanked, refuses to
// run at all if ECHO_CALLS=live is set here,
// and always stops the server, also on failure, timeout, or Ctrl-C.
// The server's status log goes to a temp folder (ECHO_LOG_DIR), never the
// repo; smoke checks that log replays the recording's lines, then deletes it.
// The child server gets a fresh random ECHO_BOX_TOKEN each run, which the
// replay sends; smoke also checks that a post without it gets 401 and changes
// nothing, and that the token never shows up in the server's output.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replay, statusLines } from './replay.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = fileURLToPath(new URL('../server/server.js', import.meta.url));
export const DEFAULT_RECORDING = fileURLToPath(
  new URL('./recordings/synthetic-ignition-off-to-emergency.jsonl', import.meta.url),
);

const REPLAY_INTERVAL_MS = 20;
const STARTUP_TIMEOUT_MS = 10_000;
const OUTPUT_QUIET_MS = 500;
const OUTPUT_SETTLE_MAX_MS = 3_000;
const OVERALL_TIMEOUT_MS = 60_000;

// The server's call log lines (server/calls.js, createCaller).
export const LADDER_LINE = /^calls: \[not live\b[^\]]*\] would call /;
export const CALLED_LINE = /^calls: called /;

// Returns the list of reasons the run failed; empty means pass.
// `output` is the server's log lines, `snapshot` its GET /status answer after
// the replay, `lastStatus` the recording's last status object.
export function judge({ output, snapshot, lastStatus }) {
  const failures = [];
  const ladder = output.filter((line) => LADDER_LINE.test(line)).length;
  const called = output.filter((line) => CALLED_LINE.test(line)).length;
  if (ladder !== 1) failures.push(`expected exactly 1 ladder call log line, got ${ladder}`);
  if (called !== 0) failures.push(`expected 0 dialed calls, got ${called}`);
  if (snapshot?.online !== true) failures.push('GET /status does not report the box online');
  if (snapshot?.status?.state !== 'EMERGENCY') {
    failures.push(`GET /status state is ${snapshot?.status?.state}, expected EMERGENCY`);
  }
  if (!isDeepStrictEqual(snapshot?.status, lastStatus)) {
    failures.push('GET /status does not hold the recording\'s last status');
  }
  return failures;
}

// The server's token auth lines (server/auth.js). The "on" line is matched on
// its stable prefix.
export const AUTH_ON_LINE = /^box token auth: on\b/;
export const REJECTED_ONE_LINE = 'rejected 1 status posts: bad or missing token';

// Returns the list of reasons the server's output doesn't prove token auth ran
// end to end; empty means pass. Smoke makes exactly one unauthenticated post,
// so the server must say auth is on and log exactly one rejection of one post.
export function judgeAuth({ output }) {
  const failures = [];
  if (!output.some((line) => AUTH_ON_LINE.test(line))) failures.push('the server did not print "box token auth: on"');
  const rejected = output.filter((line) => /^rejected \d+ status posts\b/.test(line));
  if (rejected.length !== 1 || rejected[0] !== REJECTED_ONE_LINE) {
    failures.push(`expected exactly one "${REJECTED_ONE_LINE}" line, got ${JSON.stringify(rejected)}`);
  }
  return failures;
}

// Why smoke must not run in this environment, or null. Smoke never dials, but
// with ECHO_CALLS=live set someone expects real calls; refuse rather than guess.
export function refuseReason(env) {
  if (/^\s*live\s*$/i.test(env.ECHO_CALLS ?? '')) {
    return 'refusing to run with ECHO_CALLS=live; run it as: ECHO_CALLS=off node simulator/smoke.js';
  }
  return null;
}

// Call settings blanked for the child server. An empty variable already set in
// the environment is not overridden by server/.env (process.loadEnvFile), so
// even if the live gate broke, missingCallSettings would block any dial, and
// the real contact never reaches smoke's output.
export const BLANKED_CALL_KEYS = [
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'CONTACT1_NAME', 'CONTACT1_NUMBER',
  'CONTACT2_NAME', 'CONTACT2_NUMBER',
];

// Where the child server logs statuses when no folder is given: outside the repo.
export const DEFAULT_SMOKE_LOG_DIR = join(tmpdir(), 'echo-smoke-logs');

// The child server's environment: the parent's, with ECHO_CALLS=off, the call
// settings blanked, the port set, the status log in `logDir` (a temp folder),
// and ECHO_BOX_TOKEN set to `boxToken`: never the parent's or server/.env's
// (set, even to '', it wins over server/.env), so smoke knows the token.
export function childEnv(parentEnv, port, logDir = DEFAULT_SMOKE_LOG_DIR, boxToken = '') {
  const env = {
    ...parentEnv, ECHO_CALLS: 'off', ECHO_PORT: String(port), ECHO_LOG_DIR: logDir, ECHO_BOX_TOKEN: boxToken,
  };
  for (const key of BLANKED_CALL_KEYS) env[key] = '';
  return env;
}

// Returns the list of reasons the status log is wrong; empty means pass.
// `logs` is the text of each file in the log folder, `lines` the recording's
// status lines: one file whose status lines are exactly the recording's.
export function judgeLog({ logs, lines }) {
  if (logs.length !== 1) return [`expected 1 status log file, got ${logs.length}`];
  if (!isDeepStrictEqual(statusLines(logs[0]), lines)) {
    return ['the status log does not replay the recording\'s status lines unchanged'];
  }
  return [];
}

const readLogs = (dir) => {
  try {
    return readdirSync(dir).map((name) => readFileSync(join(dir, name), 'utf8'));
  } catch {
    return [];
  }
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getStatus(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`GET /status answered ${res.status}`);
  return res.json();
}

let child = null;
let logDir = null;

function startServer(port, boxToken) {
  const output = [];
  let lastOutputAt = Date.now();
  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv(process.env, port, logDir, boxToken),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) {
    let partial = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      lastOutputAt = Date.now();
      const parts = (partial + chunk).split('\n');
      partial = parts.pop();
      for (const line of parts) {
        output.push(line);
        console.log(`server| ${line}`);
      }
    });
  }
  return { output, exited, lastOutputAt: () => lastOutputAt };
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await gone;
  clearTimeout(timer);
}

// One post of `line` without a token must get 401 and leave GET /status as it was.
async function checkRejectsUnauthenticated(url, line) {
  const before = await getStatus(url);
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: line, signal: AbortSignal.timeout(5000),
  });
  await res.body?.cancel();
  if (res.status !== 401) return [`a post without the box token got ${res.status}, expected 401`];
  if (!isDeepStrictEqual(await getStatus(url), before)) return ['a post without the box token changed GET /status'];
  return [];
}

async function run(recording) {
  const refused = refuseReason(process.env);
  if (refused) throw new Error(refused);
  const lines = statusLines(readFileSync(recording, 'utf8'));
  if (lines.length === 0) throw new Error(`no status lines in ${recording}`);
  const lastStatus = JSON.parse(lines.at(-1));

  logDir = mkdtempSync(join(tmpdir(), 'echo-smoke-logs-'));
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const server = startServer(port, token);
  const ready = `Echo server listening on port ${port}`;
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let early = null;
  server.exited.then((e) => { early = e; });
  while (!server.output.includes(ready)) {
    if (early) throw new Error(`server exited before listening (code ${early.code}, signal ${early.signal})`);
    if (Date.now() > deadline) throw new Error(`server did not start within ${STARTUP_TIMEOUT_MS} ms`);
    await sleep(25);
  }

  const url = `http://127.0.0.1:${port}/status`;
  const fresh = await getStatus(url);
  if (fresh.status !== null) throw new Error(`the server on port ${port} already has a status; not the one smoke started`);

  const authFailures = await checkRejectsUnauthenticated(url, lines.at(-1));
  if (authFailures.length) return authFailures;

  console.log(`smoke: replaying ${lines.length} statuses from ${recording} every ${REPLAY_INTERVAL_MS} ms`);
  await replay(lines, { url, intervalMs: REPLAY_INTERVAL_MS, token });

  // Let the server's last log lines arrive: wait for its output to go quiet.
  const settleBy = Date.now() + OUTPUT_SETTLE_MAX_MS;
  while (Date.now() - server.lastOutputAt() < OUTPUT_QUIET_MS && Date.now() < settleBy) await sleep(50);

  const snapshot = await getStatus(url);
  if (early) throw new Error(`server exited during the replay (code ${early.code}, signal ${early.signal})`);

  // The log is appended off the request path; give its last writes a moment.
  let logFailures = judgeLog({ logs: readLogs(logDir), lines });
  for (const until = Date.now() + OUTPUT_SETTLE_MAX_MS; logFailures.length && Date.now() < until;) {
    await sleep(50);
    logFailures = judgeLog({ logs: readLogs(logDir), lines });
  }
  const leaked = server.output.some((line) => line.includes(token)) ? ['the server printed the box token'] : [];
  return [
    ...judge({ output: server.output, snapshot, lastStatus }), ...judgeAuth({ output: server.output }),
    ...logFailures, ...leaked,
  ];
}

function removeLogDir() {
  if (logDir) rmSync(logDir, { recursive: true, force: true });
  logDir = null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bail = (code) => () => {
    child?.kill('SIGKILL');
    process.exit(code);
  };
  process.on('SIGINT', bail(130));
  process.on('SIGTERM', bail(143));
  process.on('exit', () => {
    child?.kill('SIGKILL');
    try { removeLogDir(); } catch { /* best effort on the way out */ }
  });
  setTimeout(() => {
    console.error(`smoke: FAIL: timed out after ${OVERALL_TIMEOUT_MS} ms`);
    bail(1)();
  }, OVERALL_TIMEOUT_MS).unref();

  let failures;
  try {
    failures = await run(process.argv[2] ?? DEFAULT_RECORDING);
  } catch (err) {
    failures = [err.message];
  } finally {
    await stopServer();
    try {
      removeLogDir();
    } catch (err) {
      failures.push(`could not remove the temp log folder: ${err.message}`);
    }
  }
  if (failures.length === 0) {
    console.log('smoke: PASS (one ladder call, logged only; server holds the last status; the log replays; '
      + 'a post without the box token was refused)');
  } else {
    for (const f of failures) console.error(`smoke: FAIL: ${f}`);
    process.exitCode = 1;
  }
}
