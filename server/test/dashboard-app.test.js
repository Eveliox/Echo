// The page script (dashboard/app.js) run without a browser: a stub document
// built from the real index.html ids, a stub fetch, and a stub setTimeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { POLL_MS, POLLED_PATHS, startDashboard } from '../dashboard/app.js';
import { DANGER_F, clockTime, feedRows, heatCurve, statusView } from '../dashboard/view.js';

const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const IDS = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

function fakeElement(tag) {
  const classes = new Set();
  const el = {
    tag, textContent: '', hidden: false, children: [], attrs: {},
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c);
    },
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    set innerHTML(_) { throw new Error('innerHTML must never be used'); },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    append(...kids) { el.children.push(...kids); },
    replaceChildren(...kids) { el.children = kids; },
  };
  return el;
}

// Only ids that exist in index.html resolve, so a typo in app.js fails here.
function fakeDocument() {
  const byId = new Map(IDS.map((id) => [id, fakeElement('#' + id)]));
  return {
    byId,
    getElementById(id) {
      if (!byId.has(id)) throw new Error(`no element #${id} in index.html`);
      return byId.get(id);
    },
    createElement: (tag) => fakeElement(tag),
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

// A fetch whose answers the test releases by hand.
function manualFetch() {
  const calls = [];
  const fetch = (path, opts) => new Promise((resolve, reject) => calls.push({ path, opts, resolve, reject }));
  return { calls, fetch };
}

// A fetch that answers at once from `bodies` (path -> body, or an Error to fail).
function instantFetch(bodies) {
  const calls = [];
  const fetch = async (path, opts) => {
    calls.push({ path, opts });
    const body = bodies[path];
    if (body instanceof Error) throw body;
    if (body === undefined) return { ok: false, status: 500, json: async () => ({}) };
    return ok(body);
  };
  return { calls, fetch };
}

function fakeTimers() {
  const timers = [];
  return { timers, setTimeout: (fn, ms) => { timers.push({ fn, ms }); } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const status = (overrides = {}) => ({
  state: 'WARNING', tempF: 96.4, humidity: 41, presence: true, distanceCm: 38,
  motion: false, minsToDanger: 7.5, battery: 88, ...overrides,
});
const t1 = new Date(2026, 9, 10, 1, 2, 3).getTime();
const t2 = new Date(2026, 9, 10, 1, 2, 5).getTime();
const sample = {
  '/status': { online: true, lastSeen: t2, status: status() },
  '/history': {
    entries: [
      { receivedAt: t1, status: status({ state: 'OCCUPANT', tempF: 94.1, minsToDanger: 11.2 }) },
      { receivedAt: t2, status: status() },
    ],
  },
  '/actions': {
    entries: [
      { time: new Date(t1).toISOString(), action: 'skip', to: 'Alex', reason: 'not reached yet' },
      { time: new Date(t2).toISOString(), action: 'call', to: 'Mom', reason: '<b>step 1</b>' },
    ],
  },
};

const text = (doc, id) => doc.byId.get(id).textContent;

test('polls every 2000 ms', () => {
  assert.equal(POLL_MS, 2000);
});

test('one poll fetches exactly /status, /history, /actions, each with GET', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const { calls, fetch } = instantFetch(sample);
  const { timers, setTimeout } = fakeTimers();
  await startDashboard({ document: doc, fetch, setTimeout });
  assert.deepEqual(POLLED_PATHS, ['/status', '/history', '/actions']);
  assert.deepEqual(calls.map((c) => c.path).sort(), ['/actions', '/history', '/status']);
  for (const c of calls) assert.equal(c.opts?.method, 'GET', c.path);
  assert.equal(timers.length, 1);

  // The re-armed poll fetches the same three again.
  await timers[0].fn();
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(3).map((c) => c.path).sort(), ['/actions', '/history', '/status']);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 2000);
});

test('re-arms with 2000 ms only after all three fetches settle, so polls never overlap', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const { calls, fetch } = manualFetch();
  const { timers, setTimeout } = fakeTimers();
  const first = startDashboard({ document: doc, fetch, setTimeout });
  await flush();
  assert.equal(calls.length, 3);
  const by = (p) => calls.find((c) => c.path === p);
  by('/status').resolve(ok(sample['/status']));
  by('/history').reject(new Error('network down')); // one fails early
  await flush();
  assert.equal(timers.length, 0, 'not re-armed while /actions is still in flight');
  assert.equal(calls.length, 3, 'no second poll started');
  by('/actions').resolve(ok(sample['/actions']));
  await first;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 2000);
  assert.equal(text(doc, 'connection'), 'server unreachable');
});

test('renders each value into its own element, matching the view helpers', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const { fetch } = instantFetch(sample);
  await startDashboard({ document: doc, fetch, setTimeout: () => {} });
  const view = statusView(sample['/status'], true);

  assert.equal(text(doc, 'level-text'), 'WARNING');
  assert.equal(text(doc, 'level-text'), view.level);
  assert.equal(text(doc, 'tempF'), '96.4');
  assert.equal(text(doc, 'tempF'), view.tempF);
  assert.equal(text(doc, 'minsToDanger'), '7.5');
  assert.equal(text(doc, 'minsToDanger'), view.minsToDanger);
  assert.equal(text(doc, 'seat'), 'yes');
  assert.equal(text(doc, 'connection'), 'online');
  const level = doc.byId.get('level');
  assert.ok(level.classList.contains('level-yellow'));
  assert.ok(!level.classList.contains('blink'), 'WARNING is solid');
  assert.ok(doc.byId.get('connection').classList.contains('online'));

  const curve = heatCurve(sample['/history'].entries, { dangerF: DANGER_F });
  assert.equal(doc.byId.get('curve-line').attrs.points, curve.points);
  assert.equal(text(doc, 'curve-range'), '94.1–96.4 °F');
  const danger = doc.byId.get('curve-danger').attrs;
  assert.equal(danger.y1, curve.dangerY);
  assert.equal(danger.y2, curve.dangerY);
  assert.equal(danger.visibility, 'visible');
  assert.equal(text(doc, 'curve-danger-label'), `dashed: ${DANGER_F} °F danger`);
  assert.equal(doc.byId.get('lost-alarm').hidden, true, 'no banner while online');

  const rows = feedRows(sample['/actions'].entries);
  const feed = doc.byId.get('feed').children;
  assert.equal(feed.length, 2);
  feed.forEach((li, i) => {
    assert.deepEqual(li.children.map((s) => s.className), ['time', 'action', 'to', 'reason']);
    assert.deepEqual(li.children.map((s) => s.textContent),
      [rows[i].time, rows[i].action, rows[i].to, rows[i].reason]);
  });
  assert.equal(feed[0].children[1].textContent, 'call', 'newest first');
  assert.equal(feed[0].children[3].textContent, '<b>step 1</b>', 'reason stays text');
  assert.equal(doc.byId.get('feed-empty').hidden, true);
});

test('null minsToDanger shows "--"; EMERGENCY is red and blinking; offline shows last seen', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const bodies = {
    ...sample,
    '/status': { online: true, lastSeen: t2, status: status({ state: 'EMERGENCY', tempF: 104.5, minsToDanger: null }) },
  };
  await startDashboard({ document: doc, fetch: instantFetch(bodies).fetch, setTimeout: () => {} });
  assert.equal(text(doc, 'tempF'), '104.5');
  assert.equal(text(doc, 'minsToDanger'), '--');
  const level = doc.byId.get('level');
  assert.ok(level.classList.contains('level-red'));
  assert.ok(level.classList.contains('blink'));

  const offlineDoc = fakeDocument();
  const offline = { ...bodies, '/status': { ...bodies['/status'], online: false } };
  await startDashboard({ document: offlineDoc, fetch: instantFetch(offline).fetch, setTimeout: () => {} });
  assert.equal(text(offlineDoc, 'connection'), `offline, last seen ${clockTime(t2)}`);
  assert.ok(!offlineDoc.byId.get('level').classList.contains('blink'), 'stale data does not blink');
  assert.equal(offlineDoc.byId.get('page').className, 'theme-emergency', 'a lost EMERGENCY stays red');
  const lost = offlineDoc.byId.get('lost-alarm');
  assert.equal(lost.hidden, false);
  assert.match(lost.textContent, new RegExp(`since ${clockTime(t2)} · last alert EMERGENCY`));
  assert.match(lost.textContent, /Go to the car now\.$/);
});

test('the lost-alarm banner shows when the server becomes unreachable at WARNING, and hides below it', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const bodies = { ...sample };
  const { timers, setTimeout } = fakeTimers();
  await startDashboard({ document: doc, fetch: instantFetch(bodies).fetch, setTimeout });
  assert.equal(doc.byId.get('lost-alarm').hidden, true);
  bodies['/status'] = new Error('network down');
  await timers[0].fn();
  assert.equal(doc.byId.get('lost-alarm').hidden, false, 'last known WARNING');
  assert.equal(doc.byId.get('page').className, 'theme-caution');

  const calm = fakeDocument();
  const occupant = { ...sample, '/status': { online: false, lastSeen: t2, status: status({ state: 'OCCUPANT' }) } };
  await startDashboard({ document: calm, fetch: instantFetch(occupant).fetch, setTimeout: () => {} });
  assert.equal(calm.byId.get('lost-alarm').hidden, true);
  assert.equal(calm.byId.get('page').className, 'theme-muted');
});

test('the danger line stays hidden with no readings', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  await startDashboard({ document: doc, fetch: instantFetch({ ...sample, '/history': { entries: [] } }).fetch, setTimeout: () => {} });
  assert.equal(doc.byId.get('curve-danger').attrs.visibility, 'hidden');
  assert.equal(text(doc, 'curve-danger-label'), '');
});

test('a failed fetch or a non-2xx answer shows "server unreachable" and keeps polling', { timeout: 5000 }, async () => {
  const doc = fakeDocument();
  const bodies = { ...sample };
  const { fetch } = instantFetch(bodies);
  const { timers, setTimeout } = fakeTimers();
  await startDashboard({ document: doc, fetch, setTimeout });
  assert.equal(text(doc, 'connection'), 'online');

  bodies['/status'] = new Error('fetch failed');
  await timers[0].fn();
  assert.equal(text(doc, 'connection'), 'server unreachable');
  assert.ok(doc.byId.get('connection').classList.contains('unreachable'));
  assert.equal(text(doc, 'level-text'), 'WARNING', 'last level stays visible');
  assert.ok(doc.byId.get('level').classList.contains('stale'));
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, 2000);

  bodies['/status'] = sample['/status'];
  delete bodies['/actions']; // answers 500
  await timers[1].fn();
  assert.equal(text(doc, 'connection'), 'server unreachable');

  bodies['/actions'] = sample['/actions'];
  await timers[2].fn();
  assert.equal(text(doc, 'connection'), 'online', 'recovers on the next good poll');
});
