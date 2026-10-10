// Box token auth for POST /status. With ECHO_BOX_TOKEN set (server/.env), a
// status post must carry the same value in the X-Echo-Token header, or it is
// answered 401 before its body is read. Unset (or blank) leaves auth off.
// The token is never logged or served: only "on"/"off" and rejection counts.

import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_HEADER = 'x-echo-token'; // Node lowercases header names
export const REJECT_LOG_INTERVAL_MS = 10_000;

// The configured token, or '' (auth off). Blank or whitespace-only is unset.
export function readBoxToken(env = process.env) {
  return (env.ECHO_BOX_TOKEN || '').trim();
}

const digest = (s) => createHash('sha256').update(s, 'utf8').digest();

// True only if `received` is exactly `expected`. Compares fixed-length SHA-256
// digests, so a different length neither throws nor returns early.
export function tokenMatches(expected, received) {
  if (!expected || typeof received !== 'string') return false;
  return timingSafeEqual(digest(expected), digest(received));
}

// What the server prints at startup about token auth. Never includes the token.
export function boxTokenStartupMessage(token) {
  if (token) {
    return {
      level: 'info',
      text: 'box token auth: on (the box must send X-Echo-Token, ticket #17; until then every box status gets 401)',
    };
  }
  return {
    level: 'warn',
    text: 'WARNING: box token auth is OFF: ECHO_BOX_TOKEN is not set in server/.env, '
      + 'so anything on the network can post a status (and end an incident).',
  };
}

// Counts rejected posts and logs at most one line per `intervalMs`, carrying
// the count since the last line. The first rejection after a quiet spell logs
// at once; later ones are flushed when the interval ends.
// `now` and `timers` are for tests (see test/fake-clock.js).
export function createRejectionLog({
  log = console.error, now = Date.now, timers = globalThis, intervalMs = REJECT_LOG_INTERVAL_MS,
} = {}) {
  let pending = 0;
  let total = 0;
  let lastAt = null;
  let timer = null;
  const flush = () => {
    timer = null;
    if (pending === 0) return;
    log(`rejected ${pending} status posts: bad or missing token`);
    pending = 0;
    lastAt = now();
  };
  return {
    reject() {
      pending++;
      total++;
      if (timer !== null) return;
      const wait = lastAt === null ? 0 : lastAt + intervalMs - now();
      if (wait <= 0) return flush();
      timer = timers.setTimeout(flush, wait);
      timer?.unref?.(); // never keeps the process alive on its own
    },
    total: () => total,
  };
}
