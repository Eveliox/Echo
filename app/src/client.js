import { serverUrl } from './model.js';
import { validInsights } from './insights.js';
export async function request(base, path, { fetcher = fetch, method = 'GET', timeoutMs = 4000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${serverUrl(base)}${path}`, { method, signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 429 ? 'Already sent recently. Alarm and calls continue.' : 'Could not reach the server.');
    return await response.json();
  } finally { clearTimeout(timer); }
}
export async function poll(base, options) {
  const [snapshot, history] = await Promise.all([request(base, '/status', options), request(base, '/history', options)]);
  if (typeof snapshot?.online !== 'boolean' || !Array.isArray(history?.entries)) throw new Error('Invalid server response.');
  return { snapshot, entries: history.entries, receivedAt: Date.now() };
}

// Feed and contacts have their own polling state. Their failures must never
// make a fresh car reading look offline or hold up the car's emergency UI.
export async function readResource(base, path, options) {
  const result = await request(base, path, options);
  if (path === '/actions') {
    if (!Array.isArray(result?.entries)) throw new Error('Invalid action log.');
    return result.entries;
  }
  if (path === '/contacts') {
    if (!Array.isArray(result) || result.some(contact => !Number.isInteger(contact.order) || contact.order < 1 || typeof contact.name !== 'string')) throw new Error('Invalid contacts.');
    return result.map(({ order, name }) => ({ order, name }));
  }
  throw new Error('Unknown app resource.');
}

// Heat insights from the server's last Databricks download (GET /insights; the
// app never calls Databricks). Never throws: anything but a valid file falls
// back to `bundled` (app/assets/insights.json), with fetchedAt null.
export async function liveInsights(base, bundled, options) {
  try {
    const result = await request(base, '/insights', options);
    if (result?.ok === true && validInsights(result.insights) && Number.isFinite(result.fetchedAt)) {
      return { data: result.insights, fetchedAt: result.fetchedAt };
    }
  } catch { /* offline or no server: the bundled file */ }
  return { data: bundled, fetchedAt: null };
}

// What the screen shows next: a failed poll (fetchedAt null) never replaces a
// live copy already shown; it only keeps the bundled file until one arrives.
export function nextInsights(previous, result) {
  return result.fetchedAt === null && previous?.fetchedAt != null ? previous : result;
}

// The freshness line for a live copy, null for the bundled file. The main time
// is the file's own generatedAt (when Databricks made it); fetchedAt is only when
// the server last checked. `format` turns a ms time into text.
export function insightsFreshness({ data, fetchedAt }, format) {
  if (fetchedAt === null || fetchedAt === undefined) return null;
  const made = typeof data?.generatedAt === 'string' ? Date.parse(data.generatedAt) : NaN;
  const kind = data?.source === 'databricks forecast' ? 'Forecast' : 'Prediction';
  return Number.isFinite(made) ? `${kind} from Databricks · made ${format(made)} · checked ${format(fetchedAt)}`
    : `${kind} from Databricks · checked ${format(fetchedAt)}`;
}

// Saves the parent's contact list on the server for its next start. The
// server's own error text is written for parents, so it is shown as is.
// `demo` (judging only, EXPO_PUBLIC_ECHO_DEMO_CONTACTS) sends nothing: the
// server keeps calling its own list.
export async function saveContacts(base, pin, contacts, { fetcher = fetch, timeoutMs = 4000, demo = false } = {}) {
  if (demo) return { ok: true, saved: contacts.length, appliesAfterRestart: true, demo: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetcher(`${serverUrl(base)}/saved-contacts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, contacts }), signal: controller.signal,
      });
    } catch { throw new Error('Could not reach the server.'); }
    let body = null;
    try { body = await response.json(); } catch { /* no JSON body */ }
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Could not reach the server.');
    return body;
  } finally { clearTimeout(timer); }
}
