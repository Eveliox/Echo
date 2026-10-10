// Pure view helpers for the dashboard page (no DOM, so node:test can load them).
// They only pass along what the box and server sent: tempF and minsToDanger are
// shown as sent, never rounded or computed, and a missing value shows as "--".

export const MISSING = '--';

// Level colors and blinking follow the level table in docs/firmware.md,
// "Firmware behavior" (the RGB LED column).
const LEVELS = {
  IDLE: { color: 'blue', blink: false },
  ARMED: { color: 'blue', blink: true },
  OCCUPANT: { color: 'yellow', blink: true },
  WARNING: { color: 'yellow', blink: false },
  EMERGENCY: { color: 'red', blink: true },
};

export function levelStyle(state) {
  return Object.hasOwn(LEVELS, state) ? { ...LEVELS[state] } : { color: 'none', blink: false };
}

// The page's look, matching the app's Car screen (app/App.js): EMERGENCY with
// the box online turns the whole page deep red; the box offline, the server
// unreachable, or no level yet is muted; every other level is the warm style
// with its own accent. style.css has one .theme-<token> rule per token.
const THEMES = {
  IDLE: 'calm', ARMED: 'calm', OCCUPANT: 'caution', WARNING: 'caution', EMERGENCY: 'emergency',
};

export function pageTheme(state, online) {
  return online === true && Object.hasOwn(THEMES, state) ? THEMES[state] : 'muted';
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

// A number exactly as the box sent it; anything else (null, missing) is "--".
export function formatValue(v) {
  return isNumber(v) ? String(v) : MISSING;
}

export function seatText(presence) {
  if (presence === true) return 'yes';
  if (presence === false) return 'no';
  return MISSING;
}

// Local wall-clock time "HH:MM:SS" for an ISO string or epoch ms; "--" if invalid.
export function clockTime(t) {
  if (t === null || t === undefined || t === '') return MISSING;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return MISSING;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// What the top of the page shows, from a GET /status answer. `reachable` is
// false when any poll failed. Only the fields listed here are read.
export function statusView(snapshot, reachable = true) {
  const status = snapshot && typeof snapshot.status === 'object' ? snapshot.status : null;
  const state = status && typeof status.state === 'string' && Object.hasOwn(LEVELS, status.state)
    ? status.state : MISSING;
  let connection;
  if (!reachable) connection = 'server unreachable';
  else if (snapshot?.online === true) connection = 'online';
  else connection = 'offline';
  const online = reachable && snapshot?.online === true;
  return {
    level: state,
    ...levelStyle(state),
    theme: pageTheme(state, online),
    tempF: formatValue(status?.tempF),
    minsToDanger: formatValue(status?.minsToDanger),
    seat: seatText(status?.presence),
    connection,
    online,
    lastSeen: isNumber(snapshot?.lastSeen) ? clockTime(snapshot.lastSeen) : MISSING,
  };
}

// The heat curve from GET /history entries: SVG polyline points in a
// `width` x `height` box, plus the lowest and highest tempF as sent and the
// time span. Entries without a numeric tempF or receivedAt are skipped.
export function heatCurve(entries, { width = 300, height = 120 } = {}) {
  const samples = (Array.isArray(entries) ? entries : [])
    .filter((e) => isNumber(e?.receivedAt) && isNumber(e?.status?.tempF))
    .map((e) => ({ t: e.receivedAt, f: e.status.tempF }))
    .sort((a, b) => a.t - b.t);
  if (samples.length === 0) {
    return { points: '', minF: MISSING, maxF: MISSING, start: MISSING, end: MISSING };
  }
  const minF = Math.min(...samples.map((s) => s.f));
  const maxF = Math.max(...samples.map((s) => s.f));
  const t0 = samples[0].t;
  const t1 = samples[samples.length - 1].t;
  const x = (t) => (t1 === t0 ? width : ((t - t0) / (t1 - t0)) * width);
  const y = (f) => (maxF === minF ? height / 2 : height - ((f - minF) / (maxF - minF)) * height);
  const coord = (n) => String(Math.round(n * 10) / 10);
  return {
    points: samples.map((s) => `${coord(x(s.t))},${coord(y(s.f))}`).join(' '),
    minF: String(minF),
    maxF: String(maxF),
    start: clockTime(t0),
    end: clockTime(t1),
  };
}

// Action feed rows from GET /actions entries (oldest first there), newest first.
const text = (v) => (typeof v === 'string' ? v : '');
export function feedRows(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      time: clockTime(e.time), action: text(e.action), to: text(e.to), reason: text(e.reason),
    }))
    .reverse();
}
