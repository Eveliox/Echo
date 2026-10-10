// Backup ladder (docs/brief.md, "Backup ladder"): plain code, no AI.
// Only step 1 so far: when an EMERGENCY incident starts, call Contact #1
// (retrying on the next EMERGENCY status until one placement succeeds).
//
// Incident: starts on the first EMERGENCY status and lasts while statuses stay
// EMERGENCY. Any other state ends it (the box only leaves EMERGENCY by cancel
// or ignition, docs/firmware.md "Leaving a level"). A later EMERGENCY is a new
// incident and calls again. The ladder only reads statuses; it has no path
// back to the box and can never lower or silence an alarm.

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
// { ok, dialed, sid? }. Returns { onStatus, inIncident, incident }; onStatus
// is meant for tracker.onStatus.
//
// Step 1 per incident: start a call to Contact #1 on an EMERGENCY status
// unless one is in flight or already done. A failed attempt (Twilio error,
// timeout, missing settings) is retried on the next EMERGENCY status of the
// same incident. Not live, the "would call" log counts as done.
export function createLadder({ contacts, call }) {
  // While an incident is open: { step1: { status, attempts, sid } }, where
  // status is 'dialing' | 'placed' | 'logged' | 'failed'. Later steps key off it.
  let incident = null;

  function startStep1(current, status) {
    const step1 = current.step1;
    step1.status = 'dialing';
    step1.attempts += 1;
    const finish = (result) => {
      if (result?.ok) {
        step1.status = result.dialed ? 'placed' : 'logged';
        step1.sid = result.sid ?? null;
      } else {
        step1.status = 'failed';
      }
      return result;
    };
    let pending;
    try {
      pending = Promise.resolve(call({
        contact: contacts[0],
        message: emergencyMessage(status),
        reason: 'emergency, ladder step 1',
      }));
    } catch {
      pending = Promise.resolve(null);
    }
    return pending.then(finish, () => finish(null));
  }

  return {
    onStatus(status) {
      if (status.state !== 'EMERGENCY') {
        incident = null;
        return undefined;
      }
      if (!incident) incident = { step1: { status: 'pending', attempts: 0, sid: null } };
      const { step1 } = incident;
      if (step1.status === 'pending' || step1.status === 'failed') return startStep1(incident, status);
      return undefined; // dialing, placed, or logged: never overlap, never repeat
    },
    inIncident() {
      return incident !== null;
    },
    // A copy of the open incident's record, or null.
    incident() {
      return incident && { step1: { ...incident.step1 } };
    },
  };
}
