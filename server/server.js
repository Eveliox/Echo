// HTTP server for the box. Run from the repo root: node server/server.js
//   POST /status  the box's status JSON (see docs/firmware.md); keeps the latest
//   GET  /status  { online, lastSeen, status } for the dashboard and app
// Each new status also feeds the backup ladder (ladder.js). Calls only dial
// with ECHO_CALLS=live; Twilio and contacts load from server/.env.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTracker, validateStatus } from './status.js';
import { callsStartupMessage, createCaller, loadEnv, readConfig } from './calls.js';
import { createLadder } from './ladder.js';

export const PORT = 3000;
const MAX_BODY_BYTES = 4096;

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer({ tracker = createTracker() } = {}) {
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
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
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'body is not JSON' });
      }
      const error = validateStatus(body);
      if (error) return send(res, 400, { error });
      tracker.update(body);
      send(res, 200, { ok: true });
    });
  });
}

// Feeds every new status from `tracker` into the backup ladder.
export function attachLadder(tracker, { config, dial, log, logError } = {}) {
  const call = createCaller({ config, dial, log, logError });
  const ladder = createLadder({ contacts: config.contacts, call });
  tracker.onStatus(ladder.onStatus);
  return ladder;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const config = readConfig();
  const tracker = createTracker();
  attachLadder(tracker, { config });
  createServer({ tracker }).listen(PORT, () => {
    console.log(`Echo server listening on port ${PORT}`);
    // Missing settings are loud but don't stop the server: status tracking still matters.
    const calls = callsStartupMessage(config);
    (calls.level === 'error' ? console.error : console.log)(calls.text);
  });
}
