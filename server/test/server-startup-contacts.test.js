// Starts the real `node server/server.js` with a saved contacts file
// (ECHO_CONTACTS_FILE, never server/contacts.json) and checks which list it
// uses, what it prints, and that no number is printed or served.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const START_TIMEOUT_MS = 10_000;
const children = [];
const dirs = [];

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

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

// Starts the server with `fileText` as its saved contacts and resolves
// { port, output } once it has printed its contacts line.
async function start(fileText) {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), 'echo-startup-contacts-'));
  dirs.push(dir);
  const file = join(dir, 'contacts.json');
  writeFileSync(file, fileText);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env, ECHO_CALLS: 'off', ECHO_PORT: String(port), ECHO_LOG_DIR: dir, ECHO_BOX_TOKEN: '',
      ECHO_CONTACTS_FILE: file, ECHO_CONTACTS_PIN: '',
      CONTACT1_NAME: 'EnvMom', CONTACT1_NUMBER: '+15550000001', CONTACT2_NAME: '', CONTACT2_NUMBER: '',
      GEMINI_API_KEY: '', ELEVENLABS_API_KEY: '', ECHO_VOICE_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no contacts line within ${START_TIMEOUT_MS} ms:\n${output}`)), START_TIMEOUT_MS);
    const check = (chunk) => {
      output += chunk;
      if (/^contacts: (\d+ saved from the app|from server\/\.env)/m.test(output)) {
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
  return { port, output };
}

test('a saved list replaces the .env contacts, and no number is printed or served', { timeout: START_TIMEOUT_MS + 2000 }, async () => {
  const saved = { version: 1, contacts: [{ name: 'Grandma', number: '+13055550100' }, { name: 'Alex', number: '+13055550101' }] };
  const { port, output } = await start(JSON.stringify(saved));
  assert.match(output, /^contacts: 2 saved from the app/m);
  assert.match(output, /saving from the app is off/);
  const res = await fetch(`http://127.0.0.1:${port}/contacts`);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), [{ order: 1, name: 'Grandma' }, { order: 2, name: 'Alex' }]);
  for (const number of ['+13055550100', '+13055550101', '+15550000001']) {
    assert.ok(!output.includes(number) && !text.includes(number), number);
  }
});

test('an unusable saved file falls back to the .env contacts without stopping the server', { timeout: START_TIMEOUT_MS + 2000 }, async () => {
  const { port, output } = await start('{"version":1,"contacts":[{"name":"Grandma","number":"555"}]}');
  assert.match(output, /is unusable .*; using server\/\.env/);
  assert.match(output, /^contacts: from server\/\.env/m);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/contacts`)).json(), [{ order: 1, name: 'EnvMom' }, { order: 2, name: 'Contact #2' }]);
});
