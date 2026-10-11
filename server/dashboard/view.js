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

// The page's look, in the app's colors (app/App.js): EMERGENCY turns the whole
// page deep red; every other level is the warm style with its own accent; no
// level yet is muted. Unlike the app's Car screen, a lost EMERGENCY stays red
// here (the app shows an urgent notice instead). style.css has one
// .theme-<token> rule per token.
const THEMES = {
  IDLE: 'calm', ARMED: 'calm', OCCUPANT: 'caution', WARNING: 'caution', EMERGENCY: 'emergency',
};

// Losing the box (or the server) at WARNING or EMERGENCY keeps the alarm look:
// silence from the car is not good news, and nothing over Wi-Fi may lower an
// alarm. Lower levels go muted while the box is offline.
const KEEP_WHEN_LOST = ['WARNING', 'EMERGENCY'];

export function pageTheme(state, online) {
  if (!Object.hasOwn(THEMES, state)) return 'muted';
  return online === true || KEEP_WHEN_LOST.includes(state) ? THEMES[state] : 'muted';
}

// The banner shown while the box is out of contact at WARNING or EMERGENCY;
// '' when there is nothing to warn about.
export function lostAlarmText(level, online, lastSeen) {
  if (online === true || !KEEP_WHEN_LOST.includes(level)) return '';
  const since = lastSeen === MISSING ? 'No updates' : `No updates since ${lastSeen}`;
  return `${since} · last alert ${level}. The box alarms on its own without Wi-Fi. Go to the car now.`;
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
  const lastSeen = isNumber(snapshot?.lastSeen) ? clockTime(snapshot.lastSeen) : MISSING;
  return {
    level: state,
    ...levelStyle(state),
    theme: pageTheme(state, online),
    tempF: formatValue(status?.tempF),
    minsToDanger: formatValue(status?.minsToDanger),
    seat: seatText(status?.presence),
    distanceCm: formatValue(status?.distanceCm),
    connection,
    online,
    lastSeen,
    lostAlarm: lostAlarmText(state, online, lastSeen),
  };
}

// Danger threshold: docs/firmware.md, "Firmware behavior". Only used to draw
// the danger line; levels and minutes to danger come from the box.
export const DANGER_F = 104;

// The heat curve from GET /history entries: SVG polyline points in a
// `width` x `height` box, plus the lowest and highest tempF as sent and the
// time span. Entries without a numeric tempF or receivedAt are skipped.
// With `dangerF`, the scale also takes in that temperature (2 °F of margin
// each side) and `dangerY` is where its line goes.
export function heatCurve(entries, { width = 300, height = 120, dangerF } = {}) {
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
  const danger = isNumber(dangerF);
  const lo = danger ? Math.min(minF, dangerF) - 2 : minF;
  const hi = danger ? Math.max(maxF, dangerF) + 2 : maxF;
  const y = (f) => (hi === lo ? height / 2 : height - ((f - lo) / (hi - lo)) * height);
  const coord = (n) => String(Math.round(n * 10) / 10);
  return {
    samples: samples.map(s => ({ x: Number(coord(x(s.t))), y: Number(coord(y(s.f))), time: s.t, tempF: s.f })),
    ticks: [hi, (hi + lo) / 2, lo],
    points: samples.map((s) => `${coord(x(s.t))},${coord(y(s.f))}`).join(' '),
    minF: String(minF),
    maxF: String(maxF),
    start: clockTime(t0),
    end: clockTime(t1),
    ...(danger ? { dangerY: coord(y(dangerF)) } : {}),
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

// Nearest recorded sample by horizontal position, including irregular timestamps.
export function nearestSample(samples, ratio) {
  if (!samples?.length || !Number.isFinite(ratio)) return null;
  const x = Math.max(0, Math.min(1, ratio)) * 300;
  return samples.reduce((nearest, sample) => Math.abs(sample.x - x) < Math.abs(nearest.x - x) ? sample : nearest);
}

export function cabinPresentation(view) {
  if (!view.online) {
    if (view.level === MISSING && view.connection !== 'server unreachable') {
      return { mode: 'waiting', title: 'Waiting for readings', detail: 'The cabin view will update when the box connects.' };
    }
    return { mode: 'offline', title: 'Connection lost', detail: view.lastSeen === MISSING ? 'Updates paused. Check the car.' : `Last update ${view.lastSeen} · animation paused` };
  }
  if (view.level === 'WARNING') return { mode: 'warning', title: 'Cabin warning', detail: 'Heat effects reflect the alert level from the box.' };
  if (view.level === 'EMERGENCY') return { mode: 'emergency', title: 'Emergency at the car', detail: 'Go to the car now.' };
  if (view.level === 'OCCUPANT') return { mode: 'caution', title: 'Seat detected', detail: 'Monitoring temperature with the seat occupied.' };
  if (view.level === MISSING) return { mode: 'waiting', title: 'Waiting for readings', detail: 'No cabin status has been received.' };
  return { mode: 'monitoring', title: 'Monitoring the cabin', detail: 'Live updates from your box.' };
}
