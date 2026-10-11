// Dashboard page script: polls the server every 2 s and renders what it gets.
// Read-only: the only request is getJson's GET. All data is written with
// textContent or attributes, never as HTML.
// startDashboard takes document, fetch, and setTimeout so tests can run it
// without a browser; the page starts it with the real ones (bottom of file).

import { DANGER_F, feedRows, heatCurve, statusView } from './view.js';

export const POLL_MS = 2000;
export const POLLED_PATHS = ['/status', '/history', '/actions'];

// Starts polling. Returns the first poll's promise (for tests).
export function startDashboard({ document, fetch, setTimeout }) {
  const $ = (id) => document.getElementById(id);

  async function getJson(path) {
    const res = await fetch(path, { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  }

  function renderStatus(view) {
    $('page').className = `theme-${view.theme}`;
    $('page').classList.toggle('stale', !view.online); // old readings never look live
    const conn = $('connection');
    conn.textContent = view.connection === 'offline' && view.lastSeen !== '--'
      ? `offline, last seen ${view.lastSeen}` : view.connection;
    conn.className = `connection ${view.connection === 'server unreachable' ? 'unreachable' : view.connection}`;

    // Shown before its text is written, and only rewritten when it changes,
    // so a screen reader announces it once.
    const lost = $('lost-alarm');
    lost.hidden = view.lostAlarm === '';
    if (lost.textContent !== view.lostAlarm) lost.textContent = view.lostAlarm;

    const level = $('level');
    level.className = `level level-${view.color}`;
    level.classList.toggle('blink', view.blink && view.online);
    level.classList.toggle('stale', !view.online);
    $('level-text').textContent = view.level;
    $('tempF').textContent = view.tempF;
    $('minsToDanger').textContent = view.minsToDanger;
    $('seat').textContent = view.seat;
    $('distanceCm').textContent = view.distanceCm;
  }

  function renderCurve(curve) {
    $('curve-line').setAttribute('points', curve.points);
    $('curve-range').textContent = curve.minF === '--' ? 'no readings yet' : `${curve.minF}–${curve.maxF} °F`;
    $('curve-span').textContent = curve.start === '--' ? '' : `${curve.start} → ${curve.end}`;
    const danger = $('curve-danger');
    const shown = curve.dangerY !== undefined;
    if (shown) {
      danger.setAttribute('y1', curve.dangerY);
      danger.setAttribute('y2', curve.dangerY);
    }
    danger.setAttribute('visibility', shown ? 'visible' : 'hidden');
    $('curve-danger-label').textContent = shown ? `dashed: ${DANGER_F} °F danger` : '';
  }

  function renderFeed(rows) {
    const items = rows.map((row) => {
      const li = document.createElement('li');
      for (const key of ['time', 'action', 'to', 'reason']) {
        const span = document.createElement('span');
        span.className = key;
        span.textContent = row[key];
        li.append(span);
      }
      return li;
    });
    $('feed').replaceChildren(...items);
    $('feed-empty').hidden = rows.length > 0;
  }

  let lastSnapshot = null;

  // Waits for all three answers to settle before re-arming, so polls never overlap.
  async function poll() {
    try {
      const results = await Promise.allSettled(POLLED_PATHS.map(getJson));
      if (results.some((r) => r.status === 'rejected')) {
        renderStatus(statusView(lastSnapshot, false));
        return;
      }
      const [snapshot, history, actions] = results.map((r) => r.value);
      lastSnapshot = snapshot;
      renderStatus(statusView(snapshot, true));
      renderCurve(heatCurve(history?.entries, { dangerF: DANGER_F }));
      renderFeed(feedRows(actions?.entries));
    } catch {
      renderStatus(statusView(lastSnapshot, false));
    } finally {
      setTimeout(poll, POLL_MS);
    }
  }

  return poll();
}

if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
  startDashboard({
    document: window.document,
    fetch: window.fetch.bind(window),
    setTimeout: window.setTimeout.bind(window),
  });
}
