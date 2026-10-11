// Threshold and silence window: docs/firmware.md, Firmware behavior / Data format and Wi-Fi.
export const DANGER_F = 104;
export const OFFLINE_MS = 10_000;
export const COLORS = { IDLE: '#5B9CFF', ARMED: '#5B9CFF', OCCUPANT: '#FFB547', WARNING: '#FFB547', EMERGENCY: '#E5202E', OFFLINE: '#6E6468' };
// Losing the box at these levels is still an alarm: silence from the car is not good news.
const KEEP_WHEN_LOST = ['WARNING', 'EMERGENCY'];
export function viewModel(snapshot, connected, now = Date.now(), receivedAt = null) {
  const status = snapshot?.status ?? null;
  const age = Number.isFinite(snapshot?.lastSeen) ? Math.max(0, Math.floor((now - snapshot.lastSeen) / 1000)) : null;
  const online = Boolean(connected && snapshot?.online && status && receivedAt !== null && now - receivedAt < OFFLINE_MS);
  return { status, online, emergency: online && status.state === 'EMERGENCY', color: COLORS[online ? status.state : 'OFFLINE'],
    lostAlarm: !online && KEEP_WHEN_LOST.includes(status?.state),
    heard: age === null ? 'Waiting for the box' : `${online ? 'Updated' : 'Last heard'} ${age} s ago`,
    temperature: status ? `${status.tempF}°` : '—',
    minutes: status?.minsToDanger == null ? '—' : String(status.minsToDanger),
    rising: online && status.minsToDanger !== null && status.minsToDanger > 0 };
}
// The Car screen's notice while the box is out of contact at WARNING or EMERGENCY.
export function lostAlarmCopy(status, lastHeard) {
  return {
    title: `${lastHeard ? `No updates since ${lastHeard}` : 'No updates'} · last alert ${status.state}`,
    body: 'The box alarms on its own without Wi-Fi. Go to the car now.',
  };
}
export function emergencyCopy(status) {
  return status?.presence ? 'An occupied seat. Dangerous heat. Go to the car now.' : 'Dangerous heat. Go to the car now.';
}
export function serverUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the laptop HTTP address and port only.');
  return url.origin;
}
export function phoneUrl(number) {
  if (typeof number !== 'string' || !/^\+?[0-9]{3,15}$/.test(number)) throw new Error('Set a phone number in the local app configuration.');
  return `tel:${number}`;
}
export function emergencyPhone(config) {
  return phoneUrl(config.demoCalls ? config.demoNumber : '911');
}
// The forecast joins the latest box reading to the danger threshold at the
// box's own minsToDanger. No warming-rate calculation or countdown on the phone.
export function heatCurve(entries, status, online, width = 300, height = 140) {
  const values = entries.filter(e => Number.isFinite(e.receivedAt) && Number.isFinite(e.status?.tempF)).slice(-300);
  if (!values.length) return { points: [], forecast: null, dangerY: height / 2 };
  const last = values.at(-1);
  const forecastMinutes = online && Number.isFinite(status?.minsToDanger) && status.minsToDanger > 0 && last.status.tempF === status.tempF ? status.minsToDanger : null;
  const start = values[0].receivedAt;
  const end = last.receivedAt + (forecastMinutes === null ? 0 : forecastMinutes * 60_000);
  const low = Math.min(DANGER_F - 5, ...values.map(e => e.status.tempF)) - 2;
  const high = Math.max(DANGER_F + 2, ...values.map(e => e.status.tempF)) + 2;
  const y = temp => height - (temp - low) / (high - low) * height;
  const x = time => (time - start) / Math.max(1, end - start) * width;
  const points = values.map(e => ({ x: x(e.receivedAt), y: y(e.status.tempF) }));
  return { points, dangerY: y(DANGER_F), forecast: forecastMinutes === null ? null : { from: points.at(-1), to: { x: width, y: y(DANGER_F) }, label: `+${forecastMinutes} min` } };
}

// Secondary telemetry stays literal; an unplugged sensor is unknown, not absent.
export function sensorReadings(status) {
  return [
    { label: 'Seat', value: status.presence == null ? '—' : status.presence ? 'Yes' : 'No' },
    { label: 'Movement', value: status.motion == null ? '—' : status.motion ? 'Seen' : 'None' },
    { label: 'Humidity', value: status.humidity == null ? '—' : `${status.humidity}%` },
    { label: 'Battery', value: status.battery == null ? '—' : `${status.battery}%` },
  ];
}

// Contacts a parent types in (Contacts tab). The server checks them again
// (server/contacts.js); these rules only catch mistakes before sending.
export const MAX_CONTACTS = 5;
const CONTACT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u;
// A typed number as E.164, or null. US numbers may be typed without +1.
export function normalizePhone(text) {
  if (typeof text !== 'string') return null;
  const compact = text.trim().replace(/[\s().-]/g, '');
  let number = compact;
  if (/^[0-9]{10}$/.test(compact)) number = `+1${compact}`;
  else if (/^1[0-9]{10}$/.test(compact)) number = `+${compact}`;
  return /^\+[1-9][0-9]{7,14}$/.test(number) ? number : null;
}
// The first problem with the typed rows, or null when they can be sent.
export function contactDraftError(rows) {
  if (!rows.length) return 'Add at least one contact.';
  if (rows.length > MAX_CONTACTS) return `Echo can call up to ${MAX_CONTACTS} contacts.`;
  const names = new Set();
  const numbers = new Set();
  for (const [i, row] of rows.entries()) {
    const which = `Contact ${i + 1}`;
    const name = row.name.normalize('NFC').trim();
    const number = normalizePhone(row.number);
    if (!CONTACT_NAME.test(name)) return `${which}: add a name (letters, spaces, or . ' -).`;
    if (!number) return `${which}: add a full phone number, like (305) 555-0100.`;
    if (names.has(name.toLowerCase())) return `${which}: ${name} is already on the list.`;
    if (numbers.has(number)) return `${which}: that number is already on the list.`;
    names.add(name.toLowerCase());
    numbers.add(number);
  }
  return null;
}
