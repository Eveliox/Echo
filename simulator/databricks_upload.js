// Databricks log uploader: copies heat-test logs from this laptop into a Unity
// Catalog Volume so notebooks/heat_test.py (#14) can read them, and can start
// the notebook's job. Development only: never in a Checks row, never talks to
// the Echo server, and nothing here reaches the box, alarms, the ladder, or
// calls (the notebook is insights only). Run from the repo root:
//   node simulator/databricks_upload.js --file <log> --as real-<date>-<desc>.jsonl
//   node simulator/databricks_upload.js --dir <folder> [--include-sim]
//   node simulator/databricks_upload.js --dir <folder> --latest --as real-<date>-<desc>.jsonl
//   node simulator/databricks_upload.js --dir <folder> --watch [--interval 30]
// Add --run to start the notebook job after a new upload, --dry-run to only
// show what would happen (no network, no local copies).
//
// Upload names follow the notebook's rule (see its header): `real-...` for a
// real heat test, `sim-...` for anything else. The server's own `status-*`
// files and `spoiled-*` files are never uploaded. Files already in the Volume
// are skipped, so re-running is safe.
//
// Config comes from server/.env (variables already set win): DATABRICKS_HOST,
// DATABRICKS_TOKEN, DATABRICKS_VOLUME_PATH, DATABRICKS_JOB_ID (see
// server/env.example). The token only goes in the Authorization header; it is
// never printed or put in a URL or error.

import { readFileSync, readdirSync, statSync, copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ENV_FILE = join(REPO, 'server/.env');

export const DEFAULT_VOLUME_PATH = '/Volumes/workspace/default/echo_logs';
export const DEFAULT_INTERVAL_S = 30;
const REQUEST_TIMEOUT_MS = 60000;
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
// run-now is not idempotent: retried only on answers that show it was not
// accepted, never on a timeout or network error (that could start it twice).
const RUN_RETRY_STATUSES = new Set([429, 503]);
// --latest warns if the status log changed this recently (the server may still be writing).
export const FRESH_LOG_MS = 10000;

export const NAME_RE = /^(real|sim)-[A-Za-z0-9._-]+\.jsonl$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const AUTH_MESSAGE = 'token rejected or lacks permission on the Volume';
const RUN_AUTH_MESSAGE = 'token rejected or lacks permission to run the job';
const VOLUME_MISSING = 'Volume not found: check DATABRICKS_VOLUME_PATH and that the Volume exists';
const JOB_HINT = 'no DATABRICKS_JOB_ID set, skipping --run. To create one: Workflows > Create job > '
  + 'Notebook task > heat_test, Serverless; if your Volume differs from the default, set task parameters '
  + 'log_dir / timezone / export_path. Then put its job ID in server/.env as DATABRICKS_JOB_ID.';

const USAGE = [
  'usage: node simulator/databricks_upload.js',
  '  --file <path> --as <real|sim>-<desc>.jsonl',
  '  --dir <folder> [--include-sim] [--watch [--interval N]]',
  '  --dir <folder> --latest --as <real|sim>-<desc>.jsonl',
  '  plus optional --run, --dry-run',
].join('\n');

// An upload name: real-/sim- prefix, plain characters, .jsonl, no separators.
export function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');
}

// Reads and checks the four settings. Throws with a clear message; the token
// itself never appears in one. `needToken` is false for --dry-run.
export function loadConfig(env, { needToken = true } = {}) {
  const rawHost = (env.DATABRICKS_HOST || '').trim();
  if (!rawHost) throw new Error('no DATABRICKS_HOST in server/.env (your workspace URL, https://...)');
  let url;
  try {
    url = new URL(rawHost);
  } catch {
    throw new Error('DATABRICKS_HOST is not a URL; use your workspace URL, https://...');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('DATABRICKS_HOST must be a plain https:// workspace URL with no path, e.g. https://dbc-1234.cloud.databricks.com');
  }

  const volumePath = ((env.DATABRICKS_VOLUME_PATH || '').trim() || DEFAULT_VOLUME_PATH).replace(/\/+$/, '');
  const segments = volumePath.split('/').slice(1);
  if (!volumePath.startsWith('/Volumes/') || segments.length < 4
      || !segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) {
    throw new Error('DATABRICKS_VOLUME_PATH must look like /Volumes/<catalog>/<schema>/<volume>[/<folder>]');
  }

  const token = (env.DATABRICKS_TOKEN || '').trim();
  if (needToken && !token) throw new Error('no DATABRICKS_TOKEN in server/.env (a Databricks personal access token)');
  // A header value with spaces or control characters makes fetch throw an
  // error that can quote it, so refuse it here with fixed text.
  if (token && !/^[\x21-\x7e]+$/.test(token)) throw new Error('DATABRICKS_TOKEN has spaces or unusual characters; paste it again');

  const jobId = (env.DATABRICKS_JOB_ID || '').trim();
  if (jobId && !/^[1-9]\d*$/.test(jobId)) throw new Error('DATABRICKS_JOB_ID must be the job\'s number');

  return { host: url.origin, token, volumePath, jobId: jobId || null };
}

// Files API URL for one name in the Volume, each path segment encoded.
export function fileUrl(config, name) {
  if (!validName(name)) throw new Error(`refusing name "${name}"`);
  const path = [...config.volumePath.split('/').slice(1), name].map(encodeURIComponent).join('/');
  return `${config.host}/api/2.0/fs/files/${path}`;
}

class AuthError extends Error {}
class HttpError extends Error {
  constructor(what, status, detail) {
    super(`${what}: ${detail ?? `Databricks answered ${status}`}`);
    this.status = status;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request, retried on timeouts, network errors, 429 and 5xx (or only on
// `retryStatuses` and never on network errors when `retryNetwork` is false).
// Returns the response for any other status; 401/403 throw AuthError with
// `authMessage`. Redirects are refused. Errors are fixed text plus a status
// code, never the token.
export async function request(what, url, init, {
  fetchFn = fetch, delays = RETRY_DELAYS_MS, log = console.log, timeoutMs = REQUEST_TIMEOUT_MS, sleep = realSleep,
} = {}, { retryStatuses = RETRY_STATUSES, retryNetwork = true, authMessage = AUTH_MESSAGE } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      // Network error, timeout, or a redirect: fixed text, the error itself may quote the request.
    }
    let problem;
    if (!res) {
      if (!retryNetwork) throw new Error(`${what}: the request failed or timed out; not retried`);
      problem = `${what}: the request failed or timed out`;
    } else {
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new AuthError(`${what}: ${authMessage} (${res.status})`);
      }
      if (!retryStatuses.has(res.status)) return res;
      await res.body?.cancel().catch(() => {});
      problem = `${what}: Databricks answered ${res.status}`;
    }
    if (attempt >= delays.length) throw new Error(`${problem}; gave up after ${attempt + 1} tries`);
    log(`databricks: ${problem}; retrying in ${delays[attempt] / 1000} s`);
    await sleep(delays[attempt]);
  }
}

const authHeader = (config) => ({ Authorization: `Bearer ${config.token}` });

// True if `name` is already in the Volume.
export async function existsInVolume(config, name, deps) {
  const res = await request(`checking ${name}`, fileUrl(config, name), { method: 'HEAD', headers: authHeader(config) }, deps);
  await res.body?.cancel().catch(() => {});
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new HttpError(`checking ${name}`, res.status);
}

// Uploads `localPath` as `name`. Returns 'uploaded' or 'exists' (409: it
// appeared in the meantime, or an earlier try of this request got through).
export async function putFile(config, localPath, name, deps) {
  const body = readFileSync(localPath);
  const res = await request(`uploading ${name}`, `${fileUrl(config, name)}?overwrite=false`, {
    method: 'PUT',
    headers: { ...authHeader(config), 'Content-Type': 'application/octet-stream' },
    body,
  }, deps);
  await res.body?.cancel().catch(() => {});
  if (res.status === 409) return 'exists';
  if (res.ok) return 'uploaded';
  throw new HttpError(`uploading ${name}`, res.status, res.status === 404 ? VOLUME_MISSING : undefined);
}

// Starts the notebook job. Returns { runId, runPageUrl } (either may be null).
export async function runJob(config, deps) {
  const res = await request('starting the job', `${config.host}/api/2.1/jobs/run-now`, {
    method: 'POST',
    headers: { ...authHeader(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: Number(config.jobId) }),
  }, deps, { retryStatuses: RUN_RETRY_STATUSES, retryNetwork: false, authMessage: RUN_AUTH_MESSAGE });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError('starting the job', res.status);
  }
  const data = await res.json().catch(() => ({}));
  return { runId: data?.run_id ?? null, runPageUrl: typeof data?.run_page_url === 'string' ? data.run_page_url : null };
}

// What --dir would upload: valid real-* (and sim-* with includeSim) .jsonl
// files. `refused` lists real/sim-looking names that fail the name check.
// status-*, spoiled-* and anything else are left alone.
export function planDir(dir, { includeSim = false } = {}) {
  const uploads = [];
  const refused = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const kind = /^real[-_.]/.test(name) ? 'real' : /^sim[-_.]/.test(name) ? 'sim' : null;
    if (!kind) continue;
    if (kind === 'sim' && !includeSim) continue;
    if (validName(name)) uploads.push({ path: join(dir, name), name });
    else refused.push(name);
  }
  return { uploads, refused };
}

// Newest status-*.jsonl in `dir` by modification time (name breaks ties), or null.
export function newestStatusLog(dir) {
  let best = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/^status-.*\.jsonl$/.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime || (mtime === best.mtime && entry.name > best.name)) {
      best = { path, name: entry.name, mtime };
    }
  }
  return best;
}

// Copies the newest status log to `<dir>/<name>`, never over an existing file.
// `fresh` is true if the source changed in the last FRESH_LOG_MS.
export function copyLatest(dir, name, { dryRun = false, now = Date.now() } = {}) {
  if (!validName(name)) throw new Error(`refusing --as "${name}": use real-<date>-<desc>.jsonl or sim-<date>-<desc>.jsonl`);
  const src = newestStatusLog(dir);
  if (!src) throw new Error(`no status-*.jsonl in ${dir}`);
  const dst = join(dir, name);
  if (existsSync(dst)) {
    throw new Error(`${dst} already exists; not overwriting it (upload it with --dir, or pick another --as name)`);
  }
  if (!dryRun) copyFileSync(src.path, dst, fsConstants.COPYFILE_EXCL);
  return { from: src.path, path: dst, name, fresh: now - src.mtime < FRESH_LOG_MS };
}

export function parseArgs(argv) {
  const opts = {
    file: null, dir: null, as: null, latest: false, watch: false, interval: DEFAULT_INTERVAL_S,
    includeSim: false, run: false, dryRun: false,
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file') opts.file = value(++i, arg);
    else if (arg === '--dir') opts.dir = value(++i, arg);
    else if (arg === '--as') opts.as = value(++i, arg);
    else if (arg === '--latest') opts.latest = true;
    else if (arg === '--watch') opts.watch = true;
    else if (arg === '--include-sim') opts.includeSim = true;
    else if (arg === '--run') opts.run = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--interval') {
      const raw = value(++i, arg);
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('--interval needs a positive whole number of seconds');
      opts.interval = Number(raw);
    } else throw new Error(`unexpected argument: ${arg}\n${USAGE}`);
  }
  if ((opts.file === null) === (opts.dir === null)) throw new Error(`use exactly one of --file or --dir\n${USAGE}`);
  if (opts.file !== null && opts.as === null) throw new Error('--file needs --as <real|sim>-<date>-<desc>.jsonl (the name is never guessed)');
  if (opts.latest && opts.dir === null) throw new Error('--latest needs --dir');
  if (opts.latest && opts.as === null) throw new Error('--latest needs --as <real|sim>-<date>-<desc>.jsonl (the name is never guessed)');
  if (opts.dir !== null && !opts.latest && opts.as !== null) throw new Error('--as goes with --file or --latest');
  if (opts.watch && (opts.dir === null || opts.latest)) throw new Error('--watch needs --dir and no --latest');
  if (opts.includeSim && (opts.dir === null || opts.latest)) throw new Error('--include-sim goes with --dir');
  if (opts.as !== null && !validName(opts.as)) {
    throw new Error(`refusing --as "${opts.as}": use real-<date>-<desc>.jsonl or sim-<date>-<desc>.jsonl (letters, digits, . _ - only)`);
  }
  return opts;
}

// Uploads each { path, name } not already in the Volume. Counts go into
// `tally`; `known` (a Set) remembers names seen in the Volume (for --watch).
async function uploadAll(config, items, tally, deps, { dryRun, known = new Set() }) {
  const log = deps.log;
  for (const { path, name } of items) {
    if (known.has(name)) continue;
    if (dryRun) {
      log(`databricks: would upload ${path} -> ${config.volumePath}/${name} (skipped if already there)`);
      tally.wouldUpload++;
      continue;
    }
    try {
      if (await existsInVolume(config, name, deps)) {
        known.add(name);
        tally.skipped++;
        log(`databricks: ${name} already in the Volume, skipped`);
        continue;
      }
      const result = await putFile(config, path, name, deps);
      known.add(name);
      if (result === 'exists') {
        tally.skipped++;
        log(`databricks: ${name} already in the Volume, skipped`);
      } else {
        tally.uploaded++;
        log(`databricks: uploaded ${name} to ${config.volumePath}`);
      }
    } catch (err) {
      tally.failed++;
      log(`databricks: ${err.message}`);
      if (err instanceof AuthError) throw err;
    }
  }
}

// For --watch: `ready` are the items whose size and mtime match `lastSeen`
// (from the previous poll); `seen` is this poll's map for the next one.
export function stableItems(items, lastSeen, known = new Set()) {
  const ready = [];
  const seen = new Map();
  for (const it of items) {
    if (known.has(it.name)) continue;
    let st;
    try {
      st = statSync(it.path);
    } catch {
      continue;  // gone since the folder was listed
    }
    const sig = `${st.size}:${st.mtimeMs}`;
    seen.set(it.name, sig);
    if (lastSeen.get(it.name) === sig) ready.push(it);
  }
  return { ready, seen };
}

async function maybeRun(config, opts, uploadedNow, deps) {
  if (!opts.run) return true;
  if (!config.jobId) {
    deps.log(`databricks: ${JOB_HINT}`);
    return true;
  }
  if (opts.dryRun) {
    deps.log(`databricks: would start job ${config.jobId} if anything new was uploaded`);
    return true;
  }
  if (uploadedNow === 0) {
    deps.log('databricks: nothing new uploaded, job not started');
    return true;
  }
  try {
    const { runId, runPageUrl } = await runJob(config, deps);
    deps.log(`databricks: started job ${config.jobId}, run ${runId ?? '(no id returned)'}`);
    if (runPageUrl) deps.log(`databricks: run page ${runPageUrl}`);
    return true;
  } catch (err) {
    deps.log(`databricks: ${err.message}`);
    return false;
  }
}

function summary(tally, dryRun, log) {
  if (dryRun) log(`databricks: dry run: would upload ${tally.wouldUpload}, refused ${tally.refused} (no network calls made)`);
  else log(`databricks: uploaded ${tally.uploaded}, skipped ${tally.skipped} (already there), refused ${tally.refused}`
    + (tally.failed ? `, failed ${tally.failed}` : ''));
}

// Runs one invocation. Returns the exit code: 0 ok, 1 an upload or run
// failed, 2 bad arguments or config. `deps` lets tests stub fetch and sleep.
export async function main(argv, {
  env = process.env, fetchFn = fetch, log = console.log, delays = RETRY_DELAYS_MS, sleep = realSleep,
  timeoutMs = REQUEST_TIMEOUT_MS, keepWatching = () => true,
} = {}) {
  let opts;
  let config;
  try {
    opts = parseArgs(argv);
    config = loadConfig(env, { needToken: !opts.dryRun });
  } catch (err) {
    log(`databricks: ${err.message}`);
    return 2;
  }
  const deps = { fetchFn, log, delays, sleep, timeoutMs };
  const tally = { uploaded: 0, skipped: 0, refused: 0, failed: 0, wouldUpload: 0 };

  let items;
  let plan;
  try {
    if (opts.file !== null) {
      if (!statSync(opts.file).isFile()) throw new Error(`${opts.file} is not a file`);
      items = [{ path: opts.file, name: opts.as }];
    } else if (opts.latest) {
      const copy = copyLatest(opts.dir, opts.as, { dryRun: opts.dryRun });
      if (copy.fresh) {
        log(`databricks: warning: ${copy.from} changed in the last ${FRESH_LOG_MS / 1000} s; `
          + 'server may still be writing; stop the server first for a complete log');
      }
      log(`databricks: ${opts.dryRun ? 'would copy' : 'copied'} ${copy.from} -> ${copy.path}`);
      items = [{ path: copy.path, name: copy.name }];
    } else {
      plan = planDir(opts.dir, { includeSim: opts.includeSim });
      for (const name of plan.refused) log(`databricks: refused ${name} (names must match ${NAME_RE})`);
      tally.refused = plan.refused.length;
      items = plan.uploads;
    }
  } catch (err) {
    log(`databricks: ${err.message}`);
    return 2;
  }

  try {
    if (!opts.watch) {
      await uploadAll(config, items, tally, deps, { dryRun: opts.dryRun });
      const ran = await maybeRun(config, opts, tally.uploaded, deps);
      summary(tally, opts.dryRun, log);
      return tally.failed === 0 && ran ? 0 : 1;
    }

    // --watch: poll the folder and upload a file only once its size and
    // modification time are unchanged since the previous poll (stable for one
    // interval, so a log still being written waits). Start the job per new batch.
    const known = new Set();
    const refusedSeen = new Set(plan.refused);
    let lastSeen = new Map();
    log(`databricks: watching ${opts.dir} every ${opts.interval} s (Ctrl-C to stop); `
      + 'a file is uploaded once it is unchanged for one interval');
    if (opts.run && !config.jobId) log(`databricks: ${JOB_HINT}`);
    let ok = true;
    for (;;) {
      const stable = stableItems(items, lastSeen, known);
      lastSeen = stable.seen;
      const before = tally.uploaded;
      await uploadAll(config, stable.ready, tally, deps, { dryRun: opts.dryRun, known });
      if (opts.dryRun) stable.ready.forEach((it) => known.add(it.name));
      if (tally.uploaded > before && config.jobId) {
        ok = (await maybeRun(config, opts, tally.uploaded - before, deps)) && ok;
      }
      if (!keepWatching()) break;
      await sleep(opts.interval * 1000);
      plan = planDir(opts.dir, { includeSim: opts.includeSim });
      for (const name of plan.refused) {
        if (refusedSeen.has(name)) continue;
        refusedSeen.add(name);
        tally.refused++;
        log(`databricks: refused ${name} (names must match ${NAME_RE})`);
      }
      items = plan.uploads;
    }
    summary(tally, opts.dryRun, log);
    return tally.failed === 0 && ok ? 0 : 1;
  } catch (err) {
    // AuthError (already printed): every later request would fail the same way.
    if (!(err instanceof AuthError)) log(`databricks: ${err.message}`);
    summary(tally, opts.dryRun, log);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.loadEnvFile(ENV_FILE);  // variables already set win
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('databricks: could not read server/.env');
      process.exit(2);
    }
  }
  process.exitCode = await main(process.argv.slice(2));
}
