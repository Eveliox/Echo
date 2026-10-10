// Starts the real `node server/server.js` (ECHO_CALLS=off, never posts a
// status, so neither Gemini nor ElevenLabs is ever asked anything) and checks
// the voice startup lines and that the voice tools' port serves only them.
// Every setting is in the child's env, so server/.env can't change the result.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const START_TIMEOUT_MS = 10_000;
const SECRET = 'c0ffee5ecret0123456789abcdef0123';

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const children = [];
const dirs = [];

after(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
    clearTimeout(timer);
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Starts the server with `extra` env and resolves its output once `until` matches.
async function start(extra, until) {
  const port = await freePort();
  const voicePort = await freePort();
  const logDir = mkdtempSync(join(tmpdir(), 'echo-voice-startup-logs-'));
  dirs.push(logDir);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ECHO_CALLS: 'off', ECHO_PORT: String(port), ECHO_VOICE_PORT: String(voicePort), ECHO_LOG_DIR: logDir,
      ECHO_BOX_TOKEN: '', TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', TWILIO_FROM_NUMBER: '',
      CONTACT1_NAME: '', CONTACT1_NUMBER: '', CONTACT2_NAME: '', CONTACT2_NUMBER: '',
      GEMINI_API_KEY: '', ELEVENLABS_API_KEY: '', ELEVENLABS_AGENT_ID: '', ELEVENLABS_PHONE_NUMBER_ID: '', ECHO_VOICE_SECRET: '',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${until} within ${START_TIMEOUT_MS} ms:\n${output}`)), START_TIMEOUT_MS);
    const check = (chunk) => {
      output += chunk;
      if (until.test(output)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.setEncoding('utf8').on('data', check);
    child.stderr.setEncoding('utf8').on('data', check);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}, signal ${signal}):\n${output}`));
    });
  });
  return { port, voicePort, output: () => output };
}

// This machine's first non-loopback IPv4 address, or null.
const lanAddress = () => Object.values(networkInterfaces()).flat()
  .find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;

// Resolves true if a TCP connection to host:port opens, false if refused or timed out.
const connects = (host, port) => new Promise((resolve) => {
  const socket = net.connect({ host, port, timeout: 1000 });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
});

const get = async (url, headers = {}) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
  return { code: res.status, body: await res.json() };
};

test('with ElevenLabs, the secret and the Responder set, the tools listen on loopback on their own port only',
  { timeout: START_TIMEOUT_MS + 5000 }, async () => {
    const s = await start({
      GEMINI_API_KEY: 'fake-gemini-key-never-used', ELEVENLABS_API_KEY: 'fake-eleven-key', ELEVENLABS_AGENT_ID: 'agent_fake',
      ELEVENLABS_PHONE_NUMBER_ID: 'phnum_fake', ECHO_VOICE_SECRET: SECRET,
    }, /^voice: tool webhooks on .*$/m);
    const out = s.output();
    assert.match(out, /^voice: on: /m);
    assert.match(out, new RegExp(`^voice: tool webhooks on 127\\.0\\.0\\.1:${s.voicePort} only; tunnel only this port`, 'm'));
    assert.ok(!out.includes(SECRET) && !out.includes('fake-eleven-key'), 'no secret or key printed');

    const voice = `http://127.0.0.1:${s.voicePort}`;
    assert.equal((await get(`${voice}/status`)).code, 401);
    for (const path of ['/status', '/actions', '/history', '/']) {
      assert.equal((await get(`${voice}${path}`, { 'X-Echo-Voice-Secret': SECRET })).code, 404, path);
    }
    // No box status yet, so no emergency: the tools are refused over the wire, via the Responder's inIncident.
    const res = await fetch(`${voice}/voice/get_car_status`, {
      method: 'POST', headers: { 'X-Echo-Voice-Secret': SECRET }, signal: AbortSignal.timeout(2000),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, error: 'no emergency is running' });
    const asked = await fetch(`${voice}/voice/request_call`, {
      method: 'POST', headers: { 'X-Echo-Voice-Secret': SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact: 'Contact #2' }), signal: AbortSignal.timeout(2000),
    });
    assert.equal(asked.status, 409);
    assert.deepEqual(await asked.json(), { ok: false, error: 'no emergency is running' });
    // Loopback only: not reachable on this machine's network address (a tunnel is the one way in).
    const lan = lanAddress();
    if (lan) {
      assert.equal(await connects('127.0.0.1', s.voicePort), true);
      assert.equal(await connects(lan, s.voicePort), false, `the voice port answers on ${lan}`);
    }
    // The main server still answers on its own port, and the refusals wrote nothing to its feed.
    assert.equal((await get(`http://127.0.0.1:${s.port}/status`)).code, 200);
    const { body } = await get(`http://127.0.0.1:${s.port}/actions`);
    assert.deepEqual(body.entries, []);
  });

test('without the voice settings the server says voice is off and opens no tools port', { timeout: START_TIMEOUT_MS + 5000 }, async () => {
  const s = await start({ GEMINI_API_KEY: 'fake-gemini-key-never-used' }, /^voice: off\b.*$/m);
  assert.match(s.output(), /^voice: off \(server\/\.env has no ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID\)/m);
  await assert.rejects(fetch(`http://127.0.0.1:${s.voicePort}/voice/get_car_status`, { method: 'POST', signal: AbortSignal.timeout(2000) }));
});
