// Phone calls: config from .env, the ECHO_CALLS gate, and the Twilio dialer.
// Only ECHO_CALLS=live (exactly) dials. Any other value only logs the call.
// Twilio is reached with the built-in fetch (REST "Calls" resource), no SDK.

import { fileURLToPath } from 'node:url';

// server/.env (git-ignored). Copy server/env.example to start one.
export const ENV_FILE = fileURLToPath(new URL('./.env', import.meta.url));

// Loads `path` into process.env. Variables already set in the environment win,
// so `ECHO_CALLS=off node server/server.js` beats anything in the file.
// A missing file is not an error: the server still runs, calls just can't dial.
export function loadEnv(path = ENV_FILE, { log = console.log } = {}) {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    log(`calls: no ${path}; Twilio and contacts are unset (copy server/env.example)`);
    return false;
  }
}

// Blank or whitespace-only values count as unset.
const setting = (v) => (v || '').trim();

export function readConfig(env = process.env) {
  return {
    live: env.ECHO_CALLS === 'live',
    twilio: {
      accountSid: setting(env.TWILIO_ACCOUNT_SID),
      authToken: setting(env.TWILIO_AUTH_TOKEN),
      from: setting(env.TWILIO_FROM_NUMBER),
    },
    contacts: [
      { name: setting(env.CONTACT1_NAME) || 'Contact #1', number: setting(env.CONTACT1_NUMBER) },
      // Optional: without a number, ladder step 3 is skipped and step 4 leaves it out.
      { name: setting(env.CONTACT2_NAME) || 'Contact #2', number: setting(env.CONTACT2_NUMBER) },
    ],
  };
}

// Names (never values) of the .env keys a live call needs that are unset.
export function missingCallSettings(config) {
  const required = {
    TWILIO_ACCOUNT_SID: config.twilio.accountSid,
    TWILIO_AUTH_TOKEN: config.twilio.authToken,
    TWILIO_FROM_NUMBER: config.twilio.from,
    CONTACT1_NUMBER: config.contacts[0]?.number,
  };
  return Object.keys(required).filter((name) => !required[name]);
}

// What the server prints at startup about calls. Only names keys, never values.
// Live with settings missing is an error and does not claim calls will dial.
export function callsStartupMessage(config) {
  if (!config.live) return { ok: true, level: 'info', text: 'ECHO_CALLS is not "live": calls are only logged' };
  const missing = missingCallSettings(config);
  if (missing.length === 0) {
    return { ok: true, level: 'info', text: 'ECHO_CALLS=live: emergency calls WILL be dialed' };
  }
  return {
    ok: false,
    level: 'error',
    text: `ERROR: ECHO_CALLS=live but server/.env is missing ${missing.join(', ')}. `
      + 'Emergency calls CANNOT be dialed until these are set and the server restarts.',
  };
}

// Startup warnings about optional settings, live only. Names keys, never values.
export function callsStartupWarnings(config) {
  if (!config.live || config.contacts[1]?.number) return [];
  return ['WARNING: ECHO_CALLS=live but server/.env has no CONTACT2_NUMBER: '
    + 'ladder step 3 will be skipped and step 4 will not call Contact #2.'];
}

const TWILIO_TIMEOUT_MS = 10_000;

// Returns dial({ to, twiml }) that asks Twilio to place one call.
// Throws on a non-2xx answer; callers must catch (createCaller does).
export function twilioDialer({ accountSid, authToken, from }, { fetchFn = fetch } = {}) {
  return async function dial({ to, twiml }) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Twiml: twiml }).toString(),
      signal: AbortSignal.timeout(TWILIO_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Twilio answered ${res.status}: ${text.slice(0, 300)}`);
    let sid = null;
    try { sid = JSON.parse(text).sid ?? null; } catch { /* keep sid null */ }
    return { sid };
  };
}

// Returns call({ contact, message, reason, quiet }) which never throws or rejects.
// It resolves to { ok, dialed, sid? }: `ok` means this step is done.
// Not live: logs what would be dialed, never touches the network, ok: true.
// Live: dials through `dial` (default: Twilio from `config`), logging the result.
// Missing settings or a failed dial resolve ok: false so the ladder retries;
// with `quiet` such a failure is not logged (the ladder already logged one).
// A timeout can be ok: false even if Twilio did place the call; the retry may
// then ring twice, which is acceptable (earlier, never later).
export function createCaller({ config, dial, log = console.log, logError = console.error }) {
  const dialFn = dial ?? twilioDialer(config.twilio);

  return async function call({ contact, message, reason, quiet = false }) {
    const who = `${contact.name} (${contact.number || 'number not set'})`;
    if (!config.live) {
      log(`calls: [not live, ECHO_CALLS is not "live"] would call ${who} for ${reason}: "${message}"`);
      return { ok: true, dialed: false };
    }
    const missing = missingCallSettings({ ...config, contacts: [contact] });
    if (missing.length > 0) {
      if (!quiet) logError(`calls: cannot call ${who} for ${reason}: missing in server/.env: ${missing.join(', ')}`);
      return { ok: false, dialed: false };
    }
    try {
      const { sid } = await dialFn({ to: contact.number, twiml: sayTwiml(message) });
      log(`calls: called ${who} for ${reason} (Twilio call ${sid})`);
      return { ok: true, dialed: true, sid };
    } catch (err) {
      if (!quiet) logError(`calls: call to ${who} for ${reason} failed: ${err?.message ?? err}`);
      return { ok: false, dialed: false, error: err };
    }
  };
}

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
})[c]);

// Inline TwiML: say the message twice.
export function sayTwiml(message) {
  return `<Response><Say loop="2">${escapeXml(message)}</Say></Response>`;
}
