// Backup ladder (docs/brief.md, "Backup ladder"): plain code, no AI.
// Step 1 calls Contact #1 when an EMERGENCY incident starts; its first attempt
// can go through `firstCall` (server.js: the ElevenLabs voice call, which
// falls back to the Twilio <Say> call itself). Steps 2-4 run on
// timers from the incident's start and keep going if the box goes silent:
// step 2 calls Contact #1 again (no answer detection yet, so it always
// re-calls), step 3 calls Contact #2, step 4 calls every listed contact.
//
// Incident: starts on the first EMERGENCY status and lasts while statuses stay
// EMERGENCY. Only a status whose state isn't EMERGENCY ends it and clears its
// timers (the box only leaves EMERGENCY by cancel or ignition, docs/firmware.md
// "Leaving a level"). The ladder only gets statuses that passed validateStatus,
// so invalid bodies, silence, and offline never stop it. A later EMERGENCY is a
// new incident and starts over. The ladder only reads statuses; it has no path
// back to the box and can never lower or silence an alarm.

import { createActionLog } from './actions.js';

const MINUTE_MS = 60_000;
// When steps 2-4 fire, measured from the incident's first EMERGENCY status.
export const STEP2_AFTER_MS = 2 * MINUTE_MS;
export const STEP3_AFTER_MS = 3 * MINUTE_MS;
export const STEP4_AFTER_MS = 5 * MINUTE_MS;
// A failed call is retried on a timer this long after it failed, at most
// MAX_TIMER_RETRIES times per call. Step 1 is also retried on every EMERGENCY
// status, as before; those retries don't use up the timer's.
export const RETRY_AFTER_MS = 20_000;
export const MAX_TIMER_RETRIES = 4;
// Step-1 status retries that fail without being logged one by one are
// summed up in one entry at the latest this long after the first of them
// (and at once when step 1 succeeds or the incident ends).
export const QUIET_SUMMARY_AFTER_MS = 5 * MINUTE_MS;

// Real timers, unref'd so a pending ladder timer never keeps a process alive.
export const realTimers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout(t) {
    clearTimeout(t);
  },
};

// Steps 2-4: when they fire and which contacts (by index) they call.
const TIMED_STEPS = [
  { step: 2, afterMs: STEP2_AFTER_MS, targets: () => [0] },
  { step: 3, afterMs: STEP3_AFTER_MS, targets: () => [1] },
  { step: 4, afterMs: STEP4_AFTER_MS, targets: (contacts) => contacts.map((_, i) => i) },
];

// The spoken words use tempF and minsToDanger exactly as the box sent them.
export function emergencyMessage({ tempF, minsToDanger }) {
  let danger;
  if (minsToDanger === null) danger = 'Go to the car now.';
  else if (minsToDanger === 0) danger = 'It is already at the danger level. Go to the car now.';
  else danger = `Danger in about ${minsToDanger} minute${minsToDanger === 1 ? '' : 's'}. Go to the car now.`;
  return `This is Echo, an emergency alert. Someone is still inside the car. `
    + `It is ${tempF} degrees inside. ${danger}`;
}

// `call` comes from createCaller (calls.js): it never throws and resolves to
// { ok, dialed, sid? }. `firstCall` (default `call`) places only step 1's
// first attempt; it resolves the same way, plus `voice` or `fallback` from
// createVoiceCaller (voice.js), or `skipped` when the incident ended before
// its fallback (logged as a skip, never retried). Step-1 retries and steps 2-4 always use `call`. Returns { onStatus, inIncident, incident }; onStatus
// is meant for tracker.onStatus. Every call outcome and skipped step goes to
// `actions` (actions.js). `timers` ({ setTimeout, clearTimeout }) is
// injectable so tests never wait in real time.
//
// Each call (step 1, step 2, step 3, and one per contact in step 4) is its
// own record: 'pending' | 'dialing' | 'placed' | 'logged' | 'failed'. Not
// live, the "would call" log counts as done. A failed call is retried on a
// timer (bounded, see above), and step 1 also on the next EMERGENCY status. A
// retry never starts while a dial to the same contact is in flight. A timed
// step always dials at its time, even if another dial to the same contact is
// still in flight: an extra call is acceptable, a late one is not. No step
// ever waits on another, and an error in one contact's call is reported
// through `logError` without stopping the others or any later step.
//
// Step-1 retries on statuses come every couple of seconds, so after the first
// of them fails, their further failures are counted instead of logged one by
// one; they keep dialing. The count goes into one summary entry (see
// QUIET_SUMMARY_AFTER_MS). Every other outcome, timer retries included, is
// recorded, so the action log's cap can't push out steps 2-4.
export function createLadder({
  contacts, call, firstCall = call, timers = realTimers, actions = createActionLog(), log = console.log,
  logError = console.error, now = Date.now,
}) {
  // While an incident is open: { step1, calls, lastStatus, timers }.
  let incident = null;

  const contactAt = (i) => contacts[i] ?? { name: `Contact #${i + 1}`, number: '' };
  const newCall = (step, contact) => ({
    step, contact, status: 'pending', attempts: 0, sid: null, retrying: false, timerRetries: 0,
    statusFailureLogged: false, quietFailures: 0, quietSince: null,
  });
  const busy = (current, contact) => current.calls.some((c) => c.contact === contact && c.status === 'dialing');

  // Runs fn, reporting (never throwing) anything it throws.
  function safely(what, fn) {
    try {
      fn();
    } catch (err) {
      report(what, err);
    }
  }
  function report(what, err) {
    try {
      logError(`ladder: ${what} failed unexpectedly:`, err?.message ?? err);
    } catch { /* nothing left to report to */ }
  }
  // For promises nobody awaits: report a rejection instead of crashing.
  const watch = (what, promise) => promise.catch((err) => report(what, err));

  // Runs fn after ms, only if `current` is still the open incident.
  function later(current, ms, what, fn) {
    const t = timers.setTimeout(() => {
      current.timers.delete(t);
      if (current === incident) safely(what, fn);
    }, ms);
    current.timers.add(t);
  }

  function recordOutcome(rec, status, result, viaStatus) {
    const facts = `ladder step ${rec.step}: tempF ${status.tempF}, minsToDanger ${status.minsToDanger}`;
    // Fixed text only: never ElevenLabs' answer.
    let how = '';
    if (result?.voice) how = '; as an ElevenLabs voice call';
    else if (result?.fallback) how = `; ElevenLabs voice call not placed (${result.fallback}), so the Twilio spoken alert instead`;
    if (result?.ok) {
      const reason = result.dialed
        ? `${facts}${how}`
        : `${facts}; not live: ECHO_CALLS is not "live", so the call was only logged, not dialed`;
      actions.record({ action: 'call', to: rec.contact.name, reason });
      return;
    }
    // Never the error text: Twilio's can quote the number.
    let why = 'the call failed';
    if (result?.error) why = 'the dial failed (see server log)';
    else if (result) why = 'call settings are missing in server/.env';
    const retry = rec.retrying ? `, retrying in ${RETRY_AFTER_MS / 1000} s` : '';
    const quietNext = viaStatus
      ? '; it is retried on every EMERGENCY status, and failures of those retries are not logged again '
        + 'one by one but counted in a summary entry'
      : '';
    actions.record({
      action: 'call_failed', to: rec.contact.name, reason: `${facts}${how}; ${why} (attempt ${rec.attempts}${retry})${quietNext}`,
    });
  }

  // One entry (and one console line) for the failures not logged one by one.
  function flushQuiet(rec) {
    if (rec.quietFailures === 0) return;
    const n = rec.quietFailures;
    const reason = `ladder step ${rec.step}: ${n} status ${n === 1 ? 'retry' : 'retries'} failed since `
      + `${new Date(rec.quietSince).toISOString()} (not logged one by one)`;
    rec.quietFailures = 0;
    rec.quietSince = null;
    actions.record({ action: 'call_failed', to: rec.contact.name, reason });
    logError(`ladder: ${reason}`);
  }

  function noteQuietFailure(current, rec) {
    rec.quietFailures += 1;
    if (current !== incident) {
      flushQuiet(rec); // finished after the incident ended: nothing later would flush it
      return;
    }
    if (rec.quietSince !== null) return;
    rec.quietSince = now();
    later(current, QUIET_SUMMARY_AFTER_MS, `step ${rec.step} failure summary`, () => flushQuiet(rec));
  }

  function scheduleRetry(current, rec) {
    if (current !== incident || rec.retrying || rec.timerRetries >= MAX_TIMER_RETRIES) return;
    rec.retrying = true;
    later(current, RETRY_AFTER_MS, `step ${rec.step} retry to ${rec.contact.name}`, () => {
      rec.retrying = false;
      if (rec.status !== 'failed') return;
      if (busy(current, rec.contact)) {
        scheduleRetry(current, rec);
        return;
      }
      rec.timerRetries += 1;
      watch(`step ${rec.step} retry to ${rec.contact.name}`, attempt(current, rec));
    });
  }

  // `viaStatus`: a step-1 retry started by an EMERGENCY status.
  function attempt(current, rec, { viaStatus = false } = {}) {
    const status = current.lastStatus;
    const quiet = viaStatus && rec.statusFailureLogged;
    const dial = rec.step === 1 && rec.attempts === 0 ? firstCall : call;
    rec.status = 'dialing';
    rec.attempts += 1;
    const finish = (result) => {
      if (result?.skipped) {
        rec.status = 'failed';
        actions.record({
          action: 'skip', to: rec.contact.name,
          reason: `ladder step ${rec.step}: the incident ended while the ElevenLabs voice call was tried `
            + `(${result.fallback}), so no Twilio call was placed`,
        });
        return result;
      }
      if (result?.ok) {
        rec.status = result.dialed ? 'placed' : 'logged';
        rec.sid = result.sid ?? null;
        flushQuiet(rec);
      } else {
        rec.status = 'failed';
        scheduleRetry(current, rec);
        if (quiet) {
          noteQuietFailure(current, rec);
          return result;
        }
        if (viaStatus) rec.statusFailureLogged = true;
      }
      recordOutcome(rec, status, result, viaStatus);
      return result;
    };
    let pending;
    try {
      pending = Promise.resolve(dial({
        contact: rec.contact,
        message: emergencyMessage(status),
        reason: `emergency, ladder step ${rec.step}`,
        quiet,
        status,
        stillNeeded: () => current === incident,
      }));
    } catch {
      pending = Promise.resolve(null);
    }
    return pending.then(finish, () => finish(null));
  }

  // Each contact on its own: one contact's error never skips the others.
  function fireStep(current, step, targets) {
    for (const i of targets) {
      safely(`step ${step} for contact #${i + 1}`, () => {
        const contact = contactAt(i);
        // Contact #1 always goes to the caller, which reports a missing number.
        if (i > 0 && !contact.number) {
          const why = `${contact.name} has no number (CONTACT${i + 1}_NUMBER is not set in server/.env, and no contact #${i + 1} was saved from the app)`;
          actions.record({ action: 'skip', to: contact.name, reason: `ladder step ${step}: ${why}` });
          log(`ladder: step ${step} skipped: ${why}`);
          return;
        }
        const rec = newCall(step, contact);
        current.calls.push(rec);
        watch(`step ${step} call to ${contact.name}`, attempt(current, rec));
      });
    }
  }

  function start(status) {
    const step1 = newCall(1, contacts[0]);
    const current = { step1, calls: [step1], lastStatus: status, timers: new Set() };
    incident = current;
    for (const { step, afterMs, targets } of TIMED_STEPS) {
      later(current, afterMs, `step ${step}`, () => fireStep(current, step, targets(contacts)));
    }
  }

  function end() {
    if (!incident) return;
    safely('step 1 failure summary', () => flushQuiet(incident.step1));
    for (const t of incident.timers) timers.clearTimeout(t);
    incident = null;
  }

  return {
    onStatus(status) {
      if (status.state !== 'EMERGENCY') {
        end();
        return undefined;
      }
      if (!incident) start(status);
      incident.lastStatus = status;
      const { step1 } = incident;
      if (step1.status === 'pending') return attempt(incident, step1);
      if (step1.status === 'failed' && !busy(incident, step1.contact)) {
        return attempt(incident, step1, { viaStatus: true });
      }
      return undefined; // dialing, placed, or logged: never overlap, never repeat
    },
    inIncident() {
      return incident !== null;
    },
    // A copy of the open incident's step-1 record, or null.
    incident() {
      if (!incident) return null;
      const { status, attempts, sid } = incident.step1;
      return { step1: { status, attempts, sid } };
    },
  };
}
