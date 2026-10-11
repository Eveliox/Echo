// Emergency contacts a parent saves from the app (POST /saved-contacts).
// They go to a git-ignored file and take effect the next time the server
// starts: the running ladder, Responder and voice agent keep the list they
// started with, so a save can never change who is called mid-incident.
// Numbers stay on the server; GET /contacts only ever shows names.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONTACTS_FILE = fileURLToPath(new URL('./contacts.json', import.meta.url));
export const MAX_CONTACTS = 5;
// Names reach the AI prompt and the voice agent, so only plain characters.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u;
// E.164: a plus, then 8 to 15 digits.
const NUMBER = /^\+[1-9][0-9]{7,14}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The saved-contacts file: ECHO_CONTACTS_FILE (tests), else server/contacts.json.
export function contactsFile(env = process.env) {
  return env.ECHO_CONTACTS_FILE || CONTACTS_FILE;
}

// The PIN that unlocks saving from the app, 6 to 12 digits; '' = saving is off.
export function readContactsPin(env = process.env) {
  const pin = (env.ECHO_CONTACTS_PIN || '').trim();
  return /^[0-9]{6,12}$/.test(pin) ? pin : '';
}

// What the server prints at startup about saving contacts. Never the PIN.
export function contactsPinStartupMessage(env = process.env) {
  if (readContactsPin(env)) return { level: 'info', text: 'contacts: the app can save contacts with the PIN (they apply after a restart)' };
  if ((env.ECHO_CONTACTS_PIN || '').trim()) {
    return { level: 'warn', text: 'WARNING: ECHO_CONTACTS_PIN must be 6 to 12 digits; saving contacts from the app is OFF' };
  }
  return { level: 'info', text: 'contacts: saving from the app is off (set ECHO_CONTACTS_PIN in server/.env to turn it on)' };
}

// { contacts } trimmed, or { error } in words a parent can act on.
export function validateContacts(list) {
  if (!Array.isArray(list) || list.length === 0) return { error: 'Add at least one contact.' };
  if (list.length > MAX_CONTACTS) return { error: `Echo can call up to ${MAX_CONTACTS} contacts.` };
  const contacts = [];
  for (const [i, entry] of list.entries()) {
    const which = `Contact ${i + 1}`;
    if (!isObject(entry) || Object.keys(entry).some((k) => k !== 'name' && k !== 'number')) {
      return { error: `${which} isn't a name and a number.` };
    }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const number = typeof entry.number === 'string' ? entry.number.trim() : '';
    if (!NAME.test(name)) return { error: `${which}: use a name of up to 40 letters, spaces, or . ' -` };
    if (!NUMBER.test(number)) return { error: `${which}: use a full phone number starting with +, like +13055550100.` };
    const lower = name.toLowerCase();
    if (contacts.some((c) => c.name.toLowerCase() === lower)) return { error: `${which}: ${name} is already on the list.` };
    if (contacts.some((c) => c.number === number)) return { error: `${which}: that number is already on the list.` };
    contacts.push({ name, number });
  }
  return { contacts };
}

// The saved list, or null when there is no file or it is unusable (then the
// server keeps the server/.env contacts). Never throws.
export function loadSavedContacts(file = contactsFile(), { logError = console.error } = {}) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logError(`contacts: could not read ${file} (${err.code ?? err.message}); using server/.env`);
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    logError(`contacts: ${file} is not JSON; using server/.env`);
    return null;
  }
  const checked = isObject(data) && data.version === 1 ? validateContacts(data.contacts) : { error: 'not a version 1 contacts file' };
  if (checked.error) {
    logError(`contacts: ${file} is unusable (${checked.error}); using server/.env`);
    return null;
  }
  return checked.contacts;
}

// Writes the list (already validated) whole: a temp file, then a rename, so
// a crash mid-write never leaves half a list. Owner-only, it holds numbers.
export function saveContacts(contacts, file = contactsFile()) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, contacts }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
