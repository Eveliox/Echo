import { serverUrl } from './model.js';
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
