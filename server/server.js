// HTTP server for the box. Run from the repo root: node server/server.js
//   POST /status  the box's status JSON (see docs/firmware.md); keeps the latest
//   GET  /status  { online, lastSeen, status } for the dashboard and app
//   GET  /history { entries: [{ receivedAt, status }] }, the last 10 minutes, oldest first
//   GET  /actions { entries: [{ time, action, to, reason }] }, the ladder's action log, oldest first
//   GET  /contacts [{ order, name }], fixed ladder order, never phone numbers
//   POST /on-my-way  fixed app note only; 4 KiB cap, one note per minute globally
//   POST /saved-contacts { pin, contacts: [{ name, number }] } from the app: needs
//        ECHO_CONTACTS_PIN, refused during an incident, saved to a git-ignored
//        file that only takes effect when the server restarts (contacts.js)
//   GET  /        the read-only dashboard page (dashboard.js, files in server/dashboard/)
// Each new status also feeds the backup ladder (ladder.js). Calls only dial
// with ECHO_CALLS=live; Twilio and contacts load from server/.env.
// With GEMINI_API_KEY in server/.env, the Responder (responder.js) also gets
// each status as its own listener; it can only add calls and notes.
// ECHO_PORT overrides the port (the smoke check runs its own server on a free one).
// Each accepted status is also logged to a file in server/logs/, or ECHO_LOG_DIR.
// With ECHO_BOX_TOKEN set in server/.env, POST /status needs it in the
// X-Echo-Token header or gets 401 before its body is read (auth.js).
// With ElevenLabs set in server/.env, the Responder's calls (never the
// ladder's) start voice conversations, and with ECHO_VOICE_SECRET too, a
// second server on ECHO_VOICE_PORT (127.0.0.1 only) takes the voice agent's
// tool webhooks (voice.js). The routes above are never served there.

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createTracker, validateStatus } from './status.js';
import {
  callsStartupMessage, callsStartupWarnings, createCaller, loadEnv, readConfig,
} from './calls.js';
import { createLadder } from './ladder.js';
import { createResponder } from './responder.js';
import { geminiModel, readGeminiConfig, responderStartupMessage } from './gemini.js';
import { readElevenLabsConfig } from './elevenlabs.js';
import {
  createVoiceCaller, createVoiceServer, readVoiceSecret, VOICE_HOST, voicePort, voiceStartup,
} from './voice.js';
import { createActionLog } from './actions.js';
import { createHistory, createStatusLog, logDir, logLine } from './history.js';
import { isDashboardPath, serveDashboard } from './dashboard.js';
import {
  boxTokenStartupMessage, createRejectionLog, readBoxToken, TOKEN_HEADER, tokenMatches,
} from './auth.js';
import {
  contactsFile, contactsPinStartupMessage, loadSavedContacts, readContactsPin, saveContacts, validateContacts,
} from './contacts.js';

export const PORT = 3000;
const MAX_BODY_BYTES = 4096;
// Wrong contact PINs allowed before every attempt is refused for a minute.
export const MAX_PIN_FAILURES = 5;
const PIN_LOCKOUT_MS = 60_000;

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Answers 500 for an unexpected error so one bad request never takes the
// server (and the backup ladder) down.
function fail(res, err, logError) {
  logError('request failed:', err?.stack ?? err);
  if (!res.headersSent) send(res, 500, { error: 'internal error' });
  else res.destroy();
}

// The request target's path, or null if it can't be parsed (e.g. "//[").
function requestPath(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

// `statusLog` (createStatusLog) is optional: without one nothing is written to disk.
// `actions` should be the action log given to attachLadder.
// `boxToken` ('' = auth off) gates POST /status; `rejections` counts and logs
// the posts it turns away (createRejectionLog).
// `contactsPin` ('' = off) gates POST /saved-contacts; `saveContactList`
// writes a validated list; `contactsLocked` is true during an incident.
export function createServer({
  tracker = createTracker(), history = createHistory(), statusLog = null, actions = createActionLog(),
  logError = console.error, boxToken = '', rejections = createRejectionLog({ log: logError }),
  now = Date.now, contacts = [], contactsPin = '', saveContactList = null, contactsLocked = () => false,
} = {}) {
  const publicContacts = contacts.map((contact, index) => ({ order: index + 1, name: contact.name }));
  // Global cooldown needs constant memory and cannot be bypassed with invented client IDs.
  let lastAcknowledged = -Infinity;
  // Global, like the cooldown above: recent wrong PINs, the last one's time,
  // and the lockout's end.
  let pinFailures = 0;
  let lastPinFailure = -Infinity;
  let pinLockedUntil = -Infinity;
  const guard = (res, fn) => {
    try {
      fn();
    } catch (err) {
      fail(res, err, logError);
    }
  };
  return http.createServer((req, res) => guard(res, () => {
    const path = requestPath(req.url);
    if (path === null) return send(res, 400, { error: 'bad request target' });
    if (isDashboardPath(path)) {
      serveDashboard(req, res, path).catch((err) => fail(res, err, logError));
      return;
    }
    if (path === '/actions') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { entries: actions.entries() });
    }
    if (path === '/contacts') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, publicContacts);
    }
    if (path === '/on-my-way') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      let size = 0;
      req.on('data', (chunk) => { size = Math.min(MAX_BODY_BYTES + 1, size + chunk.length); });
      req.on('error', () => { res.destroy(); }); // aborted uploads never log a note
      req.on('end', () => guard(res, () => {
        if (size > MAX_BODY_BYTES) return send(res, 413, { error: 'body too large' });
        if (now() - lastAcknowledged < 60_000) {
          return send(res, 429, { error: 'please wait before sending again' });
        }
        actions.record({ action: 'note', to: 'App', reason: "I'm on my way; alarm and backup calls continue." });
        lastAcknowledged = now();
        return send(res, 200, { ok: true });
      }));
      return;
    }
    if (path === '/saved-contacts') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      if (!contactsPin || !saveContactList) {
        req.resume();
        return send(res, 403, { error: 'Saving contacts is turned off on the Echo server.' });
      }
      if (now() < pinLockedUntil) {
        req.resume();
        return send(res, 429, { error: 'Too many wrong PINs. Wait a minute and try again.' });
      }
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      });
      req.on('error', () => { res.destroy(); });
      req.on('end', () => guard(res, () => {
        if (size > MAX_BODY_BYTES) return send(res, 413, { error: 'body too large' });
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, { error: 'body is not JSON' });
        }
        // Checked again here: requests opened before a lockout must not
        // get their PIN compared after it starts.
        if (now() < pinLockedUntil) return send(res, 429, { error: 'Too many wrong PINs. Wait a minute and try again.' });
        if (!tokenMatches(contactsPin, body?.pin)) {
          if (now() - lastPinFailure >= PIN_LOCKOUT_MS) pinFailures = 0; // old typos expire
          lastPinFailure = now();
          pinFailures += 1;
          if (pinFailures >= MAX_PIN_FAILURES) {
            pinFailures = 0;
            pinLockedUntil = now() + PIN_LOCKOUT_MS;
          }
          return send(res, 401, { error: 'That PIN is not right.' });
        }
        pinFailures = 0;
        if (contactsLocked()) {
          return send(res, 409, { error: 'An emergency is in progress. Contacts can change after it ends.' });
        }
        const checked = validateContacts(body.contacts);
        if (checked.error) return send(res, 400, { error: checked.error });
        saveContactList(checked.contacts);
        const n = checked.contacts.length;
        actions.record({
          action: 'note', to: 'App',
          reason: `Saved ${n} emergency contact${n === 1 ? '' : 's'} from the app; they take effect when the server restarts.`,
        });
        return send(res, 200, { ok: true, saved: n, appliesAfterRestart: true });
      }));
      return;
    }
    if (path === '/history') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return send(res, 200, { entries: history.entries() });
    }
    if (path !== '/status') return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, tracker.snapshot());
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    if (boxToken && !tokenMatches(boxToken, req.headers[TOKEN_HEADER])) {
      rejections.reject();
      req.resume(); // drain and discard the body unread
      return send(res, 401, { error: 'unauthorized' });
    }

    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => guard(res, () => {
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
    }));
  }));
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

// Feeds every new status from `tracker` into the Responder as its own
// listener, never through the ladder, so it can't hold up or change a ladder
// step. Its calls go through the same createCaller and ECHO_CALLS gate,
// wrapped by createVoiceCaller: with `elevenLabs` configured (and live) they
// start voice calls, falling back to the Twilio spoken alert. `startVoice`
// replaces the ElevenLabs request (tests). `connectVoice` gets the
// Responder's { requestCall, inIncident } for the voice tools.
// Without a `model` it is off: no listener, returns null.
export function attachResponder(tracker, {
  config, model, dial, log, logError, actions, timers, now, elevenLabs, startVoice, connectVoice,
} = {}) {
  if (!model) return null;
  const call = createVoiceCaller({
    live: config.live, elevenLabs, start: startVoice, say: createCaller({ config, dial, log, logError }),
    names: config.contacts.map((c) => c.name), timers, log, logError,
  });
  const responder = createResponder({
    contacts: config.contacts, call, actions, getStatus: () => tracker.snapshot(), model, timers, now, log, logError,
    connectVoice,
  });
  tracker.onStatus(responder.onStatus);
  return responder;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const port = listenPort();
  const config = readConfig();
  const savedFile = contactsFile();
  const saved = loadSavedContacts(savedFile);
  if (saved) config.contacts = saved;
  const tracker = createTracker();
  const actions = createActionLog();
  const ladder = attachLadder(tracker, { config, actions });
  const gemini = readGeminiConfig();
  const elevenLabs = readElevenLabsConfig();
  let voiceLink = null; // { requestCall, inIncident }, set when the Responder is on
  const responder = attachResponder(tracker, {
    config, actions, model: gemini.apiKey ? geminiModel(gemini) : null, elevenLabs,
    connectVoice: (link) => { voiceLink = link; },
  });
  const voiceSecret = readVoiceSecret();
  const voicePortSetting = voicePort(process.env, port);
  const voice = voiceStartup({
    elevenLabs, secret: voiceSecret, responderOn: responder !== null, port: voicePortSetting,
  });
  const statusLog = createStatusLog({ dir: logDir() });
  const boxToken = readBoxToken();
  createServer({
    tracker, statusLog, actions, boxToken, contacts: config.contacts,
    contactsPin: readContactsPin(), saveContactList: (list) => saveContacts(list, savedFile),
    contactsLocked: () => ladder.inIncident(),
  }).listen(port, () => {
    console.log(`Echo server listening on port ${port}`);
    console.log(`Echo server logging statuses to ${statusLog.file}`);
    // Missing settings are loud but don't stop the server: status tracking still matters.
    const calls = callsStartupMessage(config);
    (calls.level === 'error' ? console.error : console.log)(calls.text);
    for (const warning of callsStartupWarnings(config)) console.error(warning);
    const auth = boxTokenStartupMessage(boxToken);
    (auth.level === 'warn' ? console.error : console.log)(auth.text);
    console.log(saved
      ? `contacts: ${saved.length} saved from the app (${savedFile}); server/.env contacts are not used`
      + (config.live ? '. On a Twilio trial, only verified numbers ring' : '')
      : 'contacts: from server/.env');
    const pinMessage = contactsPinStartupMessage();
    (pinMessage.level === 'warn' ? console.error : console.log)(pinMessage.text);
    console.log(responderStartupMessage(gemini));
    for (const { level, text } of voice.lines) (level === 'info' ? console.log : console.error)(text);
    if (!voice.serve) return;
    const voicePortNumber = voicePortSetting.port;
    const voiceServer = createVoiceServer({
      secret: voiceSecret, names: config.contacts.map((c) => c.name), ...voiceLink,
      getStatus: () => tracker.snapshot(), actions,
    });
    // A voice-port problem never stops the main server or the ladder.
    voiceServer.on('error', (err) => {
      console.error(`ERROR: voice tools are OFF: could not listen on ${VOICE_HOST}:${voicePortNumber} (${err.code ?? err.message})`);
    });
    voiceServer.listen(voicePortNumber, VOICE_HOST, () => {
      console.log(`voice: tool webhooks on ${VOICE_HOST}:${voicePortNumber} only; tunnel only this port `
        + `(ngrok http ${VOICE_HOST}:${voicePortNumber}), never ${port}`);
    });
  });
}
