const LEVEL_TITLES = { IDLE: 'Car monitoring', ARMED: 'Box armed', OCCUPANT: 'Seat occupied', WARNING: 'Getting hot', EMERGENCY: 'Emergency' };
const ACTION_TITLES = { call: 'Call logged', call_failed: 'Call failed', skip: 'Call skipped', message: 'Message logged', note: 'Note logged', rejected: 'Action rejected' };

// These are records, not a live conversation. Keep reasons verbatim and never
// infer that someone answered, that a call is ongoing, or that a note is speech.
export function activityRows(actions = [], history = []) {
  const occurrences = new Map();
  const rows = [];
  for (const entry of actions) {
    const time = Date.parse(entry.time);
    if (!Number.isFinite(time) || !['action', 'to', 'reason'].every(key => typeof entry[key] === 'string')) continue;
    const identity = JSON.stringify([entry.time, entry.action, entry.to, entry.reason]);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    rows.push({ id: `action:${identity}:${occurrence}`, time, kind: 'action', title: `${ACTION_TITLES[entry.action] ?? 'Action logged'}${entry.to ? ` · ${entry.to}` : ''}`, reason: entry.reason });
  }
  // A history window's first sample is an observation, not evidence of when a
  // level began. Only show changes between consecutive samples in that window.
  let previous = null;
  for (const entry of [...history].sort((a, b) => a.receivedAt - b.receivedAt)) {
    const state = entry.status?.state;
    if (!Number.isFinite(entry.receivedAt) || !LEVEL_TITLES[state]) continue;
    if (previous !== null && previous !== state) {
      const identity = `level:${entry.receivedAt}:${state}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      rows.push({ id: `${identity}:${occurrence}`, time: entry.receivedAt, kind: 'level', title: LEVEL_TITLES[state], reason: `The box reported ${state}.` });
    }
    previous = state;
  }
  return rows.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}
export function activityTime(time) {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
