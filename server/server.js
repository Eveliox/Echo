// HTTP server for the box. Run from the repo root: node server/server.js
//   POST /status  the box's status JSON (see docs/firmware.md); keeps the latest
//   GET  /status  { online, lastSeen, status } for the dashboard and app
//   GET  /history { entries: [{ receivedAt, status }] }, the last 10 minutes, oldest first
//   GET  /actions { entries: [{ time, action, to, reason }] }, the ladder's action log, oldest first
// Each new status also feeds the backup ladder (ladder.js). Calls only dial
// with ECHO_CALLS=live; Twilio and contacts load from server/.env.
// ECHO_PORT overrides the port (the smoke check runs its own server on a free one).
// Each accepted status is also logged to a file in server/logs/, or ECHO_LOG_DIR.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTracker, validateStatus } from './status.js';
import {
  callsStartupMessage, callsStartupWarnings, createCaller, loadEnv, readConfig,
} from './calls.js';
import { createLadder } from './ladder.js';
import { createActionLog } from './actions.js';
import { createHistory, createStatusLog, logDir, logLine } from './history.js';

export const PORT = 3000;
const MAX_BODY_BYTES = 4096;

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// `statusLog` (createStatusLog) is optional: without one nothing is written to disk.
// `actions` should be the action log given to attachLadder.
export function createServer({
  tracker = createTracker(), history = createHistory(), statusLog = null, actions = createActionLog(),
} = {}) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/actions') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { entries: actions.entries() });
    }
    if (path === '/history') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { entries: history.entries() });
    }
    if (path !== '/status') return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, tracker.snapshot());
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return send(res, 413, { error: 'body too large' });
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }
      const error = validateStatus(body);
      if (error) return send(res, 400, { error });
      tracker.update(body);
      const { receivedAt } = history.add(body);
      statusLog?.write(receivedAt, logLine(text, body)); // queued, never awaited
      send(res, 200, { ok: true });
    });
  });
}

// The port to listen on: ECHO_PORT if set, else PORT. A bad value throws
// rather than silently falling back to the box's port.
export function listenPort(env = process.env) {
  const raw = env.ECHO_PORT;
  if (raw === undefined || raw === '') return PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(`ECHO_PORT must be a port number 1-65535, got "${raw}"`);
  }
  return port;
}

// Feeds every new status from `tracker` into the backup ladder, which records
// its actions in `actions`. `timers` and `now` are for tests (see createLadder).
export function attachLadder(tracker, {
  config, dial, log, logError, actions, timers, now,
} = {}) {
  const call = createCaller({ config, dial, log, logError });
  const ladder = createLadder({
    contacts: config.contacts, call, actions, timers, log, logError, now,
  });
  tracker.onStatus(ladder.onStatus);
  return ladder;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const port = listenPort();
  const config = readConfig();
  const tracker = createTracker();
  const actions = createActionLog();
  attachLadder(tracker, { config, actions });
  const statusLog = createStatusLog({ dir: logDir() });
  createServer({ tracker, statusLog, actions }).listen(port, () => {
    console.log(`Echo server listening on port ${port}`);
    console.log(`Echo server logging statuses to ${statusLog.file}`);
    // Missing settings are loud but don't stop the server: status tracking still matters.
    const calls = callsStartupMessage(config);
    (calls.level === 'error' ? console.error : console.log)(calls.text);
    for (const warning of callsStartupWarnings(config)) console.error(warning);
  });
}
