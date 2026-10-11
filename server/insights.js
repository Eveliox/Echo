// Live Heat insights: the server, not the app, downloads the Florida forecast
// file the notebook writes to a Databricks Volume, so the token stays on this
// laptop and the app never calls Databricks (#23). Insights only: this module
// shares no state with status, history, the ladder, the Responder, calls, or
// voice, and nothing here can change an alert. It never throws into the server.
//
// Config from server/.env (variables already set win): DATABRICKS_HOST and
// DATABRICKS_TOKEN turn it on; ECHO_INSIGHTS_PATH and ECHO_INSIGHTS_REFRESH_MIN
// are optional (see server/env.example). The token only goes in the
// Authorization header; logs and errors are fixed text, never the token.

export const DEFAULT_INSIGHTS_PATH = '/Volumes/workspace/default/echo_logs/florida_insights.json';
export const DEFAULT_REFRESH_MIN = 5;
const MAX_REFRESH_MIN = 1440;
// First download shortly after startup, so it never holds up listening.
export const FIRST_FETCH_MS = 2000;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_INSIGHTS_BYTES = 64 * 1024;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// Reads and checks the settings. Never throws; `on` is false with a `reason`
// (fixed text, never a value) when the feature is off.
export function readInsightsConfig(env = process.env) {
  const rawHost = (env.DATABRICKS_HOST || '').trim();
  const token = (env.DATABRICKS_TOKEN || '').trim();
  if (!rawHost || !token) return { on: false, reason: 'no DATABRICKS_HOST/TOKEN' };
  let url;
  try {
    url = new URL(rawHost);
  } catch {
    return { on: false, reason: 'DATABRICKS_HOST is not a URL' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) {
    return { on: false, reason: 'DATABRICKS_HOST must be a plain https:// workspace URL with no path' };
  }
  // fetch can quote a bad header value in its error, so refuse it here.
  if (!/^[\x21-\x7e]+$/.test(token)) return { on: false, reason: 'DATABRICKS_TOKEN has spaces or unusual characters' };
  const path = (env.ECHO_INSIGHTS_PATH || '').trim() || DEFAULT_INSIGHTS_PATH;
  const segments = path.split('/').slice(1);
  if (!path.startsWith('/Volumes/') || segments.length < 5 || !path.endsWith('.json')
      || !segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')) {
    return { on: false, reason: 'ECHO_INSIGHTS_PATH must look like /Volumes/<catalog>/<schema>/<volume>/<file>.json' };
  }
  const rawMinutes = (env.ECHO_INSIGHTS_REFRESH_MIN || '').trim();
  const minutes = rawMinutes === '' ? DEFAULT_REFRESH_MIN : Number(rawMinutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_REFRESH_MIN) {
    return { on: false, reason: `ECHO_INSIGHTS_REFRESH_MIN must be minutes, 1-${MAX_REFRESH_MIN}` };
  }
  return {
    on: true, host: url.origin, token, path, refreshMin: minutes,
    url: `${url.origin}/api/2.0/fs/files/${segments.map(encodeURIComponent).join('/')}`,
  };
}

// What the server prints at startup. Never the token.
export function insightsStartupMessage(config) {
  return config.on
    ? `insights: on (Databricks, every ${config.refreshMin} min)`
    : `insights: off (${config.reason})`;
}

// The app's own validator (app/src/insights.js, plain JS), loaded lazily so a
// problem there only turns insights off and never stops the server. Null on failure.
export async function loadValidator(load = () => import('../app/src/insights.js')) {
  try {
    const { validInsights } = await load();
    return typeof validInsights === 'function' ? validInsights : null;
  } catch {
    return null;
  }
}

class Problem extends Error {}

// The body as text, refused past `max` bytes without reading the rest.
async function readCapped(res, max) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Problem('the file is too large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Problem('the file is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Keeps the last good copy of the insights file. `validate` defaults to the
// app's validInsights (loaded on start). `timers` and `now` are for tests.
// snapshot() is what GET /insights answers.
export function createInsights({
  config, fetchFn = fetch, validate = null, timers = globalThis, now = Date.now,
  log = console.log, logError = console.error, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_INSIGHTS_BYTES,
  loadValidatorFn = loadValidator,
} = {}) {
  let good = null; // { insights, fetchedAt }
  let timer = null;
  let stopped = false;
  let busy = false;
  let lastOk = null; // logs only changes: first success, failures, recovery
  let check = validate;
  let unavailable = false; // the validator could not be loaded

  async function download() {
    let res;
    try {
      res = await fetchFn(config.url, {
        headers: { Authorization: `Bearer ${config.token}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // The error itself may quote the request: fixed text only.
      throw new Problem('the request failed or timed out');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Problem(res.status === 401 || res.status === 403 ? `token rejected or lacks permission (${res.status})`
        : res.status === 404 ? 'file not found (404); check ECHO_INSIGHTS_PATH and that the notebook ran'
          : `Databricks answered ${res.status}`);
    }
    let text;
    try {
      text = await readCapped(res, maxBytes);
    } catch (err) {
      throw err instanceof Problem ? err : new Problem('the download failed or timed out');
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Problem('the file is not JSON');
    }
    if (!check(data)) throw new Problem('the file does not have the insights shape');
    return data;
  }

  // One download. Resolves either way; on failure the last good copy stays.
  async function refresh() {
    if (!config?.on || busy || !check) return;
    busy = true;
    try {
      const insights = await download();
      good = { insights, fetchedAt: now() };
      if (lastOk !== true) log(`insights: updated from Databricks (${config.path})`);
      lastOk = true;
    } catch (err) {
      const reason = err instanceof Problem ? err.message : 'unexpected error';
      logError(`insights: could not refresh from Databricks (${reason}); ${good ? 'keeping the last good copy' : 'none yet'}`);
      lastOk = false;
    } finally {
      busy = false;
    }
  }

  function schedule(ms) {
    if (stopped) return;
    timer = timers.setTimeout(() => {
      timer = null;
      refresh().catch(() => {}).finally(() => schedule(config.refreshMin * 60_000));
    }, ms);
    timer?.unref?.();
  }

  return {
    async start() {
      if (!config?.on) return;
      if (!check) check = await loadValidatorFn();
      if (!check) {
        unavailable = true;
        logError("insights: off (could not load the app's insights validator)");
        return;
      }
      schedule(FIRST_FETCH_MS);
    },
    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    refresh,
    snapshot() {
      if (!config?.on) return { ok: false, reason: 'not configured' };
      if (unavailable) return { ok: false, reason: 'validator unavailable' };
      if (!good) return { ok: false, reason: 'not fetched yet' };
      return { ok: true, insights: good.insights, fetchedAt: good.fetchedAt };
    },
  };
}
