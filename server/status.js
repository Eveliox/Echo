// Box status: validation and the latest-status / online tracker.
// The format, field types, and silence window come from docs/firmware.md,
// "Data format and Wi-Fi". The server stores what the box sends; it never
// computes tempF or minsToDanger itself.

export const STATES = ['IDLE', 'ARMED', 'OCCUPANT', 'WARNING', 'EMERGENCY'];

// Silence window from docs/firmware.md, "Data format and Wi-Fi".
export const OFFLINE_AFTER_MS = 10_000;

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumberOrNull = (v) => v === null || isNumber(v);
const isBoolean = (v) => typeof v === 'boolean';
const isBooleanOrNull = (v) => v === null || isBoolean(v);

// Required fields. `light` is pending approval, so it is optional (checked below).
const FIELDS = {
  state: (v) => STATES.includes(v),
  tempF: isNumber,
  humidity: isNumber,
  presence: isBoolean,
  distanceCm: isNumber,
  motion: isBooleanOrNull,
  minsToDanger: isNumberOrNull,
  battery: isNumberOrNull,
};

// Returns null if `body` is a valid status object, otherwise an error string.
export function validateStatus(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'status must be a JSON object';
  }
  for (const [name, check] of Object.entries(FIELDS)) {
    if (!(name in body)) return `missing field: ${name}`;
    if (!check(body[name])) return `bad value for ${name}`;
  }
  if ('light' in body && !isNumber(body.light)) return 'bad value for light';
  return null;
}

// Keeps the latest valid status and reports whether the box is online.
// `now` is injectable so tests don't have to wait.
export function createTracker({ now = Date.now, offlineAfterMs = OFFLINE_AFTER_MS } = {}) {
  let latest = null;
  let lastSeen = null;
  const listeners = [];

  return {
    // Call only with a status that passed validateStatus.
    update(status) {
      latest = status;
      lastSeen = now();
      for (const listener of listeners) listener(status);
    },
    isOnline() {
      return lastSeen !== null && now() - lastSeen < offlineAfterMs;
    },
    snapshot() {
      return { online: this.isOnline(), lastSeen, status: latest };
    },
    // Seam for later tickets (backup ladder): called with each new valid status.
    onStatus(listener) {
      listeners.push(listener);
    },
  };
}
