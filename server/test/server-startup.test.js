// Starts the real `node server/server.js` with no box token and checks it
// warns loudly that token auth is off. ECHO_BOX_TOKEN is set to '' in the
// child's env, so a server/.env can't turn auth on (set variables win).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const START_TIMEOUT_MS = 10_000;

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

let child = null;
let logDir = null;

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
    clearTimeout(timer);
  }
  if (logDir) rmSync(logDir, { recursive: true, force: true });
});

test('the real server with no ECHO_BOX_TOKEN prints the loud auth-off WARNING', { timeout: START_TIMEOUT_MS + 2000 }, async () => {
  const port = await freePort();
  logDir = mkdtempSync(join(tmpdir(), 'echo-startup-logs-'));
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ECHO_CALLS: 'off', ECHO_PORT: String(port), ECHO_LOG_DIR: logDir, ECHO_BOX_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const warned = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no auth-off warning within ${START_TIMEOUT_MS} ms:\n${output}`)),
      START_TIMEOUT_MS);
    const check = (chunk) => {
      output += chunk;
      if (/^WARNING: box token auth is OFF\b/m.test(output)) {
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
  await warned;
  assert.match(output, new RegExp(`Echo server listening on port ${port}`));
  assert.doesNotMatch(output, /box token auth: on/);
});
