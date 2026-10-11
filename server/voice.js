// Live voice on the Responder's calls (ticket #19; agent setup in server/voice/agent.md).
//
// createVoiceCaller is the Responder's caller, and the ladder's for step 1's
// first attempt only (server.js attachLadder). With
// ECHO_CALLS=live and ElevenLabs configured, a call starts an ElevenLabs voice
// conversation (elevenlabs.js) that opens with the code-built emergencyMessage
// and gets the box's values as sent. If ElevenLabs isn't configured, fails, or
// doesn't accept the call within ELEVENLABS_TIMEOUT_MS, the same contact gets
// the plain Twilio <Say> call instead. Not live, it only logs, never touches
// the network. A timeout can mean ElevenLabs placed the call anyway, so the
// contact may get two calls: earlier, never later.
//
// createVoiceServer is the voice agent's webhook tools, on their own port
// (ECHO_VOICE_PORT), listening on 127.0.0.1 only: a tunnel (ngrok) to that
// port is the one way in, and the main server's routes (/status, /history,
// /actions, the dashboard) are never served here. Each request needs the
// shared secret in X-Echo-Voice-Secret (401 before the body is read). The
// tools work only while the Responder has an incident open: otherwise 409,
// nothing recorded (a stranger phoning the number, or talk after cancel).
// Then each request is rate-limited, size-capped, and validated like the
// Responder's tool calls, and writes one action-log entry, reason starting
// "agent: voice: <tool>: ". It can read the car, ask for a call through the
// Responder's caps, and write notes; nothing here can lower or end an alarm.

import http from 'node:http';
import { realTimers, emergencyMessage } from './ladder.js';
import { textError } from './responder.js';
import { REJECT_LOG_INTERVAL_MS, tokenMatches } from './auth.js';
import {
  ELEVENLABS_TIMEOUT_MS, elevenLabsDialer, missingElevenLabsSettings,
} from './elevenlabs.js';

export const VOICE_PORT = 3100;
export const VOICE_HOST = '127.0.0.1';
export const VOICE_SECRET_HEADER = 'x-echo-voice-secret'; // Node lowercases header names
export const MAX_VOICE_BODY_BYTES = 2048;
// Bounds the voice agent's entries, so it can't push an incident's ladder
// entries out of the capped action log.
export const VOICE_RATE_WINDOW_MS = 10 * 60_000;
export const MAX_VOICE_REQUESTS_PER_WINDOW = 40;

// What the action log says about a fallback. Fixed text: never ElevenLabs' answer.
export const FALLBACK_REASONS = {
  unconfigured: 'ElevenLabs is not configured',
  timeout: 'ElevenLabs did not accept the call in time',
  failed: 'ElevenLabs failed, see the server log',
};

// The shared secret for the webhook tools, or '' (tools off). Blank is unset.
export function readVoiceSecret(env = process.env) {
  return (env.ECHO_VOICE_SECRET || '').trim();
}

// { port } for the webhook tools, or { error } if ECHO_VOICE_PORT is bad or
// the main server's port. A bad value turns the tools off, never the server.
export function voicePort(env, mainPort) {
  const raw = env.ECHO_VOICE_PORT ?? '';
  const port = raw === '' ? VOICE_PORT : Number(raw);
  if (raw !== '' && (!/^\d+$/.test(raw) || port < 1 || port > 65535)) {
    return { error: `ECHO_VOICE_PORT must be a port number 1-65535, got "${raw}"` };
  }
  if (port === mainPort) return { error: `the main server is on port ${mainPort} too; set ECHO_VOICE_PORT to another port` };
  return { port };
}

// The voice agent's dynamic variables (names in server/voice/agent.md): box
// values as strings exactly as sent, and contact names, never numbers.
export function voiceVariables(status, contact, names) {
  return {
    emergency_message: emergencyMessage(status),
    car_state: String(status.state),
    temp_f: String(status.tempF),
    mins_to_danger: String(status.minsToDanger),
    contact_name: contact.name,
    contact_names: names.join(', '),
  };
}

// Returns call({ contact, message, reason, status }) for createResponder and
// the ladder's `firstCall`.
// `say` is createCaller's call (calls.js): the Twilio <Say> call and the
// ECHO_CALLS gate. `start` defaults to elevenLabsDialer(elevenLabs). Never
// throws; resolves like `say`, plus `voice: true` for a voice call or
// `fallback` (a FALLBACK_REASONS text) when `say` was used instead live.
// An optional `stillNeeded()` in the args is asked after a failed voice call:
// false (the incident ended meanwhile) resolves { ok: false, dialed: false,
// skipped: true, fallback } without calling `say`.
export function createVoiceCaller({
  live, elevenLabs, start, say, names, timers = realTimers, log = console.log, logError = console.error,
}) {
  const ready = missingElevenLabsSettings(elevenLabs).length === 0;
  const startFn = start ?? (ready ? elevenLabsDialer(elevenLabs) : null);

  // ElevenLabs' answer, or a rejection; `timedOut` says which kind.
  async function startWithin(request, attempt) {
    const abort = new AbortController();
    let timer;
    const late = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        attempt.timedOut = true;
        const err = new Error(`no answer from ElevenLabs within ${ELEVENLABS_TIMEOUT_MS / 1000} s`);
        abort.abort(err);
        reject(err);
      }, ELEVENLABS_TIMEOUT_MS);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => startFn({ ...request, signal: abort.signal })), late]);
    } finally {
      timers.clearTimeout(timer);
    }
  }

  return async function call(args) {
    if (!live) return say(args);
    const { contact, reason, status } = args;
    const who = `${contact.name} (${contact.number || 'number not set'})`;
    let fallback = FALLBACK_REASONS.unconfigured;
    if (!ready) {
      log(`calls: ElevenLabs is not configured; ${who} gets the Twilio spoken call for ${reason}`);
    } else if (!status || !contact.number) {
      fallback = FALLBACK_REASONS.failed;
      logError(`calls: no ElevenLabs voice call to ${who} for ${reason}: no box status or no number; `
        + 'placing the Twilio spoken call instead');
    } else {
      const attempt = { timedOut: false };
      try {
        const { conversationId } = await startWithin({
          to: contact.number, firstMessage: emergencyMessage(status), variables: voiceVariables(status, contact, names),
        }, attempt);
        log(`calls: called ${who} for ${reason} (ElevenLabs voice call, conversation ${conversationId})`);
        return { ok: true, dialed: true, voice: true };
      } catch (err) {
        fallback = attempt.timedOut ? FALLBACK_REASONS.timeout : FALLBACK_REASONS.failed;
        logError(`calls: ElevenLabs voice call to ${who} for ${reason} not placed (${err?.message ?? err}); `
          + 'placing the Twilio spoken call instead');
      }
      if (args.stillNeeded?.() === false) {
        log(`calls: no Twilio spoken call to ${who} for ${reason}: the incident ended while ElevenLabs was tried`);
        return { ok: false, dialed: false, skipped: true, fallback };
      }
    }
    return { ...(await say(args)), fallback };
  };
}

// What the server prints at startup about voice. Names keys, never values.
// `serve` says whether to start the webhook tools server.
export function voiceStartup({ elevenLabs, secret, responderOn, port }) {
  const missing = missingElevenLabsSettings(elevenLabs);
  if (!responderOn) {
    const text = missing.length
      ? `voice: off (the Responder is off; server/.env has no ${missing.join(', ')}): every call uses the Twilio spoken alert`
      : 'voice: off (the Responder is off) except the ladder\'s first call to Contact #1, an ElevenLabs voice call '
        + '(the Twilio spoken alert if it fails); the voice tools are off';
    return { serve: false, lines: [{ level: 'info', text }] };
  }
  if (missing.length) {
    return {
      serve: false,
      lines: [{ level: 'info', text: `voice: off (server/.env has no ${missing.join(', ')}): every call uses the Twilio spoken alert` }],
    };
  }
  const lines = [{
    level: 'info',
    text: 'voice: on: the Responder\'s calls and the ladder\'s first call to Contact #1 start ElevenLabs voice calls '
      + '(the Twilio spoken alert if one fails)',
  }];
  if (!secret) {
    lines.push({
      level: 'warn',
      text: 'WARNING: voice tools are OFF: ECHO_VOICE_SECRET is not set in server/.env, '
        + 'so the voice agent cannot read the car, ask for calls, or log notes.',
    });
    return { serve: false, lines };
  }
  if (port.error) {
    lines.push({ level: 'error', text: `ERROR: voice tools are OFF: ${port.error}` });
    return { serve: false, lines };
  }
  return { serve: true, lines };
}

const TOOL_ARGS = { get_car_status: [], request_call: ['contact'], log_action: ['note'] };
// ElevenLabs won't save a webhook tool with an empty body, so get_car_status may
// also carry one `reason` (checked like a note, otherwise ignored).
const OPTIONAL_ARGS = { get_car_status: ['reason'], request_call: [], log_action: [] };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns { args } for a valid tool body, or { error } saying why not. Error
// text never quotes the body, which may hold a number someone said.
export function checkVoiceTool(tool, body, names) {
  if (!isObject(body)) return { error: 'the body is not a JSON object' };
  const expected = TOOL_ARGS[tool];
  const optional = OPTIONAL_ARGS[tool];
  const keys = Object.keys(body);
  if (!expected.every((k) => Object.hasOwn(body, k)) || !keys.every((k) => expected.includes(k) || optional.includes(k))) {
    return { error: `needs exactly (${expected.join(', ')})${optional.length ? ` and optionally (${optional.join(', ')})` : ''}` };
  }
  for (const k of keys) {
    const error = textError(k, body[k]);
    if (error) return { error };
  }
  if ('contact' in body && !names.includes(body.contact)) return { error: 'unknown contact (use a name exactly as listed)' };
  return { args: body };
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The tool a request path names, or null.
function toolFor(url) {
  let path;
  try {
    path = new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
  const m = /^\/voice\/(\w+)$/.exec(path);
  return m && Object.hasOwn(TOOL_ARGS, m[1]) ? m[1] : null;
}

// Answer to any tool request while no incident is open.
export const NO_INCIDENT = { ok: false, error: 'no emergency is running' };

// `requestCall(name)` and `inIncident()` are the Responder's (createResponder's
// connectVoice). `getStatus` returns the tracker's snapshot. `names` are the
// contacts' names.
export function createVoiceServer({
  secret, names, requestCall, inIncident, getStatus, actions, now = Date.now, logError = console.error,
}) {
  if (!secret) throw new Error('the voice tools need ECHO_VOICE_SECRET');
  if (typeof inIncident !== 'function') throw new Error('the voice tools need the Responder\'s inIncident');
  const times = [];
  let rejectLoggedAt = null;
  let rateLoggedAt = null;
  let idleLoggedAt = null;
  const record = (action, to, reason) => actions.record({ action, to, reason: `agent: voice: ${reason}` });
  const once = (last, message) => {
    if (last !== null && now() - last < REJECT_LOG_INTERVAL_MS) return last;
    logError(message);
    return now();
  };

  function handle(res, tool, text) {
    let body;
    try {
      body = text.trim() === '' && tool === 'get_car_status' ? {} : JSON.parse(text);
    } catch {
      record('rejected', '', `${tool}: rejected: the body is not JSON; nothing done`);
      return send(res, 400, { ok: false, error: 'the body is not JSON' });
    }
    const checked = checkVoiceTool(tool, body, names);
    if (checked.error) {
      record('rejected', '', `${tool}: rejected: ${checked.error}; nothing done`);
      return send(res, 400, { ok: false, error: checked.error });
    }
    const { args } = checked;
    if (tool === 'log_action') {
      record('note', '', `log_action: ${args.note}`);
      return send(res, 200, { ok: true });
    }
    if (tool === 'request_call') {
      // The Responder records the call or why it was refused.
      const { ok, error } = requestCall(args.contact);
      return send(res, 200, ok ? { ok, result: `calling ${args.contact} now` } : { ok, error });
    }
    const snapshot = getStatus();
    const s = snapshot?.status;
    record('note', '', s ? `get_car_status: state ${s.state}, tempF ${s.tempF}, minsToDanger ${s.minsToDanger}`
      : 'get_car_status: no status from the box yet');
    return send(res, 200, { ok: true, ...snapshot });
  }

  return http.createServer((req, res) => {
    const fail = (err) => {
      logError('voice: request failed:', err?.stack ?? err);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.destroy();
    };
    try {
      if (!tokenMatches(secret, req.headers[VOICE_SECRET_HEADER])) {
        req.resume(); // drain and discard the body unread
        rejectLoggedAt = once(rejectLoggedAt, 'voice: rejected tool requests: bad or missing X-Echo-Voice-Secret '
          + `(logged at most every ${REJECT_LOG_INTERVAL_MS / 1000} s)`);
        return send(res, 401, { error: 'unauthorized' });
      }
      const tool = toolFor(req.url);
      if (!tool) {
        req.resume();
        return send(res, 404, { error: 'not found' });
      }
      if (req.method !== 'POST') {
        req.resume();
        return send(res, 405, { error: 'method not allowed' });
      }
      // Before the rate limit, so refusals can't use up an emergency's budget.
      if (!inIncident()) {
        req.resume();
        idleLoggedAt = once(idleLoggedAt, 'voice: refused tool requests: no emergency is running '
          + `(logged at most every ${REJECT_LOG_INTERVAL_MS / 1000} s)`);
        return send(res, 409, NO_INCIDENT);
      }
      while (times.length && now() - times[0] >= VOICE_RATE_WINDOW_MS) times.shift();
      if (times.length >= MAX_VOICE_REQUESTS_PER_WINDOW) {
        req.resume();
        rateLoggedAt = once(rateLoggedAt, `voice: rate limit: ${MAX_VOICE_REQUESTS_PER_WINDOW} tool requests in the last `
          + `${VOICE_RATE_WINDOW_MS / 60_000} min; refusing more (the backup ladder keeps its schedule)`);
        return send(res, 429, { error: 'too many requests' });
      }
      times.push(now());
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_VOICE_BODY_BYTES) chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          if (size > MAX_VOICE_BODY_BYTES) {
            record('rejected', '', `${tool}: rejected: the body is over ${MAX_VOICE_BODY_BYTES} bytes; nothing done`);
            return send(res, 413, { ok: false, error: 'body too large' });
          }
          return handle(res, tool, Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          return fail(err);
        }
      });
      return undefined;
    } catch (err) {
      return fail(err);
    }
  });
}
