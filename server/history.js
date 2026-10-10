// Recent status history (in memory, served at GET /history) and the status
// log on disk (one file per server start). Both only see statuses that passed
// validateStatus. The log keeps the box's own bytes so a log file replays
// unchanged through simulator/replay.js:
//   # <ISO receive time>
//   <status JSON as received>

import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// How much history GET /history serves (a ticket choice, not a doc value).
export const HISTORY_WINDOW_MS = 10 * 60_000;
// Hard cap so memory stays bounded even if statuses arrive far faster than
// the box's period.
export const HISTORY_MAX_ENTRIES = 1000;

// Default log folder, git-ignored. ECHO_LOG_DIR overrides it.
export const DEFAULT_LOG_DIR = fileURLToPath(new URL('./logs/', import.meta.url));

export function logDir(env = process.env) {
  const raw = env.ECHO_LOG_DIR;
  return raw ? resolve(raw) : DEFAULT_LOG_DIR;
}

// Keeps accepted statuses with their receive time, newest last, dropping any
// at least `windowMs` old. `now` is injectable so tests don't have to wait.
export function createHistory({
  now = Date.now, windowMs = HISTORY_WINDOW_MS, maxEntries = HISTORY_MAX_ENTRIES,
} = {}) {
  const entries = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    let drop = 0;
    while (drop < entries.length && entries[drop].receivedAt <= cutoff) drop++;
    if (entries.length - drop > maxEntries) drop = entries.length - maxEntries;
    if (drop) entries.splice(0, drop);
  };
  return {
    // Call only with a status that passed validateStatus. Returns the entry.
    add(status) {
      const entry = { receivedAt: now(), status };
      entries.push(entry);
      prune();
      return entry;
    },
    entries() {
      prune();
      return entries.slice();
    },
  };
}

// The log line for an accepted status: the request body as received, trimmed.
// A body with a line break inside (the box never sends one) would break the
// one-status-per-line format, so it is logged as compact JSON instead.
export function logLine(text, status) {
  const line = text.trim();
  return /[\r\n]/.test(line) ? JSON.stringify(status) : line;
}

// Appends to `<dir>/status-<start time>-<pid>.jsonl`, creating `dir` if needed.
// write() never throws and never waits: appends run in order off the request
// path. A failed write is reported through `logError` once per failure burst.
export function createStatusLog({
  dir, now = Date.now, pid = process.pid, append = appendFile, makeDir = mkdir,
  logError = console.error,
} = {}) {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `status-${stamp}-${pid}.jsonl`);
  let queue = Promise.resolve();
  let dirReady = false;
  let failing = false;

  const appendOne = async (text) => {
    if (!dirReady) {
      await makeDir(dir, { recursive: true });
      dirReady = true;
    }
    await append(file, text);
    failing = false;
  };
  const report = (err) => {
    if (!failing) logError(`status log: write to ${file} failed:`, err?.message ?? err);
    failing = true;
  };

  return {
    file,
    write(receivedAt, line) {
      try {
        const text = `# ${new Date(receivedAt).toISOString()}\n${line}\n`;
        queue = queue.then(() => appendOne(text)).catch(report);
      } catch (err) {
        report(err);
      }
    },
    // Resolves once every write so far has finished (or failed). For tests.
    flush() {
      return queue;
    },
  };
}
