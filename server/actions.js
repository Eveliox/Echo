// Action log (docs/brief.md, "Shared data formats" > "Agent action log"),
// served at GET /actions. Entries are exactly { time, action, to, reason }:
// `time` is ISO, `to` is a contact's name (never a number), and `reason` never
// holds numbers or secrets. The backup ladder writes:
//   "call"         a call was placed, or, when not live, only logged (reason says so)
//   "call_failed"  a call could not be placed (Twilio error or missing settings)
//   "skip"         a step was not attempted for a contact (reason says why)
// The Responder (responder.js) adds its own entries, each reason starting
// "agent: ": "call", "call_failed", "note", and "rejected".

// Hard cap so memory stays bounded; the oldest entries drop first.
export const ACTIONS_MAX_ENTRIES = 200;

export function createActionLog({ now = Date.now, maxEntries = ACTIONS_MAX_ENTRIES } = {}) {
  const entries = [];
  return {
    record({ action, to, reason }) {
      const entry = { time: new Date(now()).toISOString(), action, to, reason };
      entries.push(entry);
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
      return entry;
    },
    // Oldest first, as copies.
    entries() {
      return entries.map((e) => ({ ...e }));
    },
  };
}
