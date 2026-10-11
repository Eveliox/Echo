# Backlog

## Slice: ignition off → seat occupied → alert → server → test call

### 1. server: accept box status on POST /status and track online/offline
Owner: Evelio (sw) · Size: M · Depends on: none · Issue: #1
- [ ] `POST /status` on port 3000 accepts the status JSON from `docs/firmware.md` "Data format and Wi-Fi" and keeps the latest one
- [ ] A body that isn't valid status JSON is rejected with a 4xx and doesn't replace the latest status
- [ ] The box is reported offline after the silence window in "Data format and Wi-Fi", and online again on the next message
- [ ] The `server` row in `CLAUDE.md` Checks is filled in and runs these tests
Proven by: server


### 2. mega: alert levels in logic.h with laptop tests
Owner: David (hw) · Size: M · Depends on: none · Issue: #2
- [ ] `firmware/mega/logic.h` steps IDLE → ARMED → OCCUPANT → WARNING → EMERGENCY per the level table in "Firmware behavior", using temperature thresholds only (minutes-to-danger comes later)
- [ ] Levels only climb on their own: a falling temperature or an empty seat never lowers WARNING or EMERGENCY
- [ ] Only cancel (→ ARMED) and ignition on (→ IDLE) clear a level; tests cover both
- [ ] `logic.h` follows the plain-C++ rule in `CLAUDE.md` and is included by the Mega sketch
Proven by: logic-test, firmware-mega


### 3. mega: seat-occupied detection in logic.h with laptop tests
Owner: David (hw) · Size: S · Depends on: none · Issue: #3
- [ ] Baseline, median-of-pings, distance drop, and readings-in-a-row rules match "Seat detection" in "Firmware behavior"
- [ ] Tests cover: empty seat stays empty, one noisy ping doesn't flip it, a sustained drop does
Proven by: logic-test


### 4. mega: read sensors, run the logic, send the status line every 2 s
Owner: David (hw) · Size: M · Depends on: 2, 3 · Issue: #4
- [ ] The sketch reads the ignition, cancel, ultrasonic, LM35 (with the `SIMULATE_TEMP` joystick path), and DHT11 on the pins in "Mega pin map"
- [ ] Every 2 s it prints one status line to Serial and Serial1, in the format from "Data format and Wi-Fi" (`light` left out while it's pending; `motion`, `battery`, and `minsToDanger` sent as `null` for now)
- [ ] Manual: someone sits on the seat, the ignition jumper is pulled, and the Serial Monitor shows OCCUPANT within the brief's alert-speed target
Proven by: firmware-mega, logic-test, manual hardware check


### 5. esp: forward the Mega's lines to the server
Owner: David (hw) · Size: S · Depends on: 1 · Issue: #5
- [ ] Wi-Fi name, password, and server URL load from `firmware/esp/secrets.h` (gitignored); a `secrets.example.h` with placeholders is committed
- [ ] Lines that don't start with `{` are dropped (see the gotchas in "Mega to ESP8266 link")
- [ ] Manual: with the Mega connected, the server receives a status every 2 s over the hotspot
Proven by: firmware-esp, manual hardware check


### 6. server: backup ladder step 1, call Contact #1 when EMERGENCY starts
Owner: Evelio (sw) · Size: M · Depends on: 1 · Issue: #6
- [ ] The first EMERGENCY status of an incident places exactly one call to Contact #1 (brief, "Backup ladder" step 1); repeated EMERGENCY statuses don't place more calls. Plain code, no AI
- [ ] No call is dialed unless `ECHO_CALLS=live`; a test shows that with it unset or `off` the call is only logged
- [ ] Twilio credentials and contact numbers load from `.env`
- [ ] Manual: with `ECHO_CALLS=live`, a verified phone rings. Note whether the trial account plays a "press any key" prompt first
Proven by: server, manual check (live call)


### 7. sim: replay a recording through the server and fill the smoke check
Owner: David (hw) · Size: M · Depends on: 1, 6 · Issue: #7
- [ ] A replay tool POSTs a recorded status file to the server at the box's pace, with a faster option for tests
- [ ] A recording that runs ignition off → OCCUPANT → EMERGENCY is committed
- [ ] The `smoke` row in `CLAUDE.md` Checks replays it with `ECHO_CALLS=off`, and fails unless the server logs exactly one ladder call
Proven by: smoke


### 8. mega: local alarm with RGB LED, buzzer, and LCD per level
Owner: David (hw) · Size: M · Depends on: 4 · Issue: #8
- [ ] LED color, buzzer pattern, and both LCD lines follow the level table in "Firmware behavior"; LCD shows SIM when simulating
- [ ] The rule in `CLAUDE.md` about pins 9 and 10 is followed
- [ ] Manual: walk the joystick from ARMED to EMERGENCY and check each level's LED, buzzer, and LCD; unplug the ESP mid-alarm and the siren keeps going
Proven by: firmware-mega, manual hardware check

## Later
- Minutes to danger (2-minute line fit) in logic.h, feeding WARNING/EMERGENCY and `minsToDanger`
- Backup ladder steps 2–4
- `light` field (photoresistor), once both teammates approve it
- PIR `motion`, battery reading on A0
- Dashboard
- Responder agent (Gemini + Twilio voice), Telegram messages
- Expo app, Figma
- Challenger agent, Databricks notebook

## Stage 2: after the end-to-end slice

### 9. server: keep recent status history and log every status to a file
Owner: Evelio (sw) · Size: S · Depends on: none · Issue: #9
- [ ] The server keeps the last 10 minutes of accepted statuses with their receive time and serves them at `GET /history` (10 minutes is a ticket choice, not a doc value)
- [ ] Each accepted status is logged to `server/logs/` (added to `.gitignore`) as a `# <ISO receive time>` line followed by the status JSON exactly as received, so a log replays unchanged through `simulator/replay.js` (a test proves it)
- [ ] The log folder is set by an env var; server tests and `simulator/smoke.js` point it at a temp folder, so no check writes into the repo (`git status` stays clean after a run)
- [ ] Rejected statuses are neither kept nor logged; a failed log write is reported and never delays the reply or the ladder
Proven by: server, smoke


### 10. server: backup ladder steps 2–4 on a timer, with an action log
Owner: Evelio (sw) · Size: M · Depends on: none · Issue: #10
- [ ] Steps 2–4 of the brief's "Backup ladder" fire at 2, 3 and 5 minutes after the incident starts, on a timer, and keep going if the box goes silent; a failed step-1 placement is also retried on that timer. Step 2 always re-calls (no answer detection yet): an extra call is acceptable, a late one is not
- [ ] The schedule stops only on a valid status whose state isn't EMERGENCY; silence, offline, invalid bodies (4xx) and dial errors never stop it. Plain code, no AI; `ECHO_CALLS` gating unchanged
- [ ] Each ladder action is recorded in the brief's "Agent action log" format (time, action, to, reason) and served at `GET /actions`; `to` is the contact's name, never the number; not-live calls say so in `reason`
- [ ] Contact #2 and "everyone" (a call to every listed contact) load from `.env`; `server/env.example` gets placeholders only, `simulator/smoke.js` blanks the new keys, and a missing Contact #2 is logged without blocking the other steps. Tests use an injected clock and fake dialer
Proven by: server (smoke only shows step 1 is unchanged)


### 11. dashboard: live read-only page served by the server
Owner: Evelio (sw) · Size: M · Depends on: 9, 10 · Issue: #11
- [ ] `GET /` serves one static HTML page (no build step, no new dependencies) that polls `/status`, `/history` and `/actions` every 2 s
- [ ] Shows the alert level colored per the level table in docs/firmware.md "Firmware behavior", `tempF`, `minsToDanger` exactly as sent ("--" when null), seat occupied, online/offline, a heat curve from `/history`, and the action feed
- [ ] The page is read-only: it only GETs and has no button or request that POSTs anything
- [ ] Manual: start the server with `ECHO_CALLS=off`, run `node simulator/replay.js simulator/recordings/synthetic-ignition-off-to-emergency.jsonl --url http://127.0.0.1:3000/status`, and watch IDLE → EMERGENCY, the curve climb, and the action appear; after the replay ends the page shows offline within the silence window
Proven by: server, manual check


### 12. mega: minutes to danger in logic.h, feeding the levels and `minsToDanger`
Owner: David (hw) · Size: M · Depends on: none · Issue: #12
- [ ] logic.h fits a line to the last 2 minutes of temperature samples per "Minutes to danger" in docs/firmware.md "Firmware behavior", in a fixed-size array (no STL or allocation): null below the minimum warming rate or before 2 minutes of samples exist; 0 at or above the danger temperature, even when the rate is low
- [ ] WARNING and EMERGENCY also enter on the minutes-to-danger conditions in the level table, only from OCCUPANT up; a null value never raises a level; levels still only climb
- [ ] The status line sends `minsToDanger` as a number or null, and LCD line 2 shows it
- [ ] Tests pin the doc values as literals. The synthetic recording's `minsToDanger` values follow the doc formula, and its tests check they are null or ≥ 0, 0 at or above the danger temperature, and that WARNING/EMERGENCY start on the first condition met (no test is weakened)
Proven by: logic-test, firmware-mega, smoke


### 13. mega: battery reading on A0
Owner: David (hw) · Size: S · Depends on: none · Issue: #13
- [ ] First: the empty and full battery-pack voltages are agreed by the team and added to docs/firmware.md "Power"
- [ ] logic.h maps the divider reading to a 0–100 integer, clamped; tests pin the doc voltages as literals
- [ ] A named constant `BATTERY_DIVIDER_WIRED` at the top of the sketch (default false) decides null vs. a reading; logic-test covers the mapping and the null path
- [ ] Manual: laptop USB unplugged from the Mega, ESP on Mega 5V: the siren keeps going and the server's `GET /status` shows a non-null `battery`
Proven by: logic-test, firmware-mega, manual hardware check


### 14. notebooks: Databricks heat-test notebook
Owner: David (hw) · Size: M · Depends on: 9 · Issue: #14
- [ ] A notebook in `notebooks/` loads the server's JSONL logs (uploaded by hand; logs are gitignored) into a table, using the `#` receive-time lines for time of day
- [ ] Fits minutes to danger from the logged fields (temperature, humidity, time of day; not `light` until it's approved) and shows predicted vs. actual for at least one real heat test, i.e. a run with `SIMULATE_TEMP` off, named as such in the log filename or a notes.md entry
- [ ] Predictions are only for the app's Heat insights screen; nothing feeds back into alerts or calls. No repo dependencies; Databricks runtime only
Proven by: manual check (run in Databricks)

## Stage 3: hardware run, agents, app, Challenger

### 15. hw: end-to-end run on the real box, through the ESP to the server
Owner: David (hw) · Size: M · Depends on: none · Issue: #15
- [ ] ESP enumerates and uploads (known data cable, then the spare NodeMCU), and the #5 hotspot check passes: the laptop server receives a status every 2 s and recovers after the hotspot drops
- [ ] The box reaches WARNING and EMERGENCY on hardware (LM35 against hot water, or a local `SIMULATE_TEMP` build switched back off before committing), with the #8 yellow and red LED colors, buzzer and siren seen
- [ ] With `ECHO_CALLS=off`, the dashboard shows the run live and the server logs exactly one ladder step-1 line; the run's status log is renamed `real-*.jsonl` per the #14 notebook's rule and kept for #14 and the Heat insights ticket
- [ ] #13 battery manual check, and results noted in docs/notes.md (this ticket tracks the open manual checks of #5, #8 and #13)
Proven by: manual hardware check


### 16. server: authenticate box status posts with a shared token
Owner: Evelio (sw) · Size: S · Depends on: none · Issue: #16
- [ ] With `ECHO_BOX_TOKEN` set in `server/.env`, a POST /status without the exact `X-Echo-Token` header gets 401 and never reaches the tracker, ladder, history or log; the comparison uses `crypto.timingSafeEqual` (checked in review); the token is never logged or served
- [ ] Rejections are counted and logged in a rate-limited line ("rejected N status posts: bad or missing token", no token text); the startup line says whether token auth is on, and warns loudly when it's off (behavior then unchanged)
- [ ] `simulator/replay.js` gains `--token`; smoke sets a token for its own server and uses it; the status JSON format is unchanged (the token is a header)
- [ ] docs/firmware.md "Data format and Wi-Fi" notes the header (with David's OK)
Proven by: server, smoke


### 17. esp: send the box token header
Owner: David (hw) · Size: S · Depends on: 15, 16 · Issue: #17
- [ ] The ESP sends `X-Echo-Token` with every POST, read from `firmware/esp/secrets.h`; `secrets.example.h` gets a placeholder; `esp.ino` stops compiling with a clear `#error` if `secrets.h` has no token
- [ ] Manual: with the token set on both sides the box's posts are accepted and the dashboard updates; a curl without the token gets 401 and the dashboard doesn't change
Proven by: firmware-esp, manual hardware check


### 18. agent: Responder decision loop (Gemini) with the four tools
Owner: Evelio (sw) · Size: M · Depends on: none · Issue: #18
- [ ] When an incident starts, the Responder reads the car through `get_car_status()` (never its own estimate) and picks one tool per turn: `get_car_status()`, `place_call(contact, message)`, `send_message(contact, message)`, `log_action(note)`. A turn runs at incident start and then at most once per new status; agent calls are capped per contact per incident so the action log can't push out ladder entries
- [ ] Contacts are named, never numbered: tools take a contact name that must match `readConfig().contacts`, unknown names are rejected and logged, and the model never sees phone numbers. A spoken message always starts with the code-built `emergencyMessage(status)`; model text may only follow it
- [ ] It can only add actions: it runs as its own `tracker.onStatus` listener, can't cancel, delay or skip a ladder step, end an incident, or reach the box. Test: with a fake model that throws, hangs past its timeout, or returns a malformed tool call, the ladder's call times (0/2/3/5 min, fake clock) match a run with no agent
- [ ] Every agent action goes to the action log with its reason; `place_call` uses the same caller and `ECHO_CALLS` gate; `send_message` only logs until the Telegram ticket lands. Gemini over REST with built-in `fetch` (no SDK); key from `.env` (placeholder in `env.example`, added to smoke's blank list; smoke still sees exactly one "would call" line); tests use a fake model
Proven by: server, smoke


### 19. agent: live voice conversation on the Responder's calls (ElevenLabs)
Owner: Evelio (sw) · Size: L · Depends on: 18 · Issue: #19
Decided (Eve, 2026-10-10): ElevenLabs Agents Platform with the Twilio number imported, HTTP webhook tools back into Echo; no WebSocket server or new dependency. The ladder keeps plain Twilio `<Say>` calls.
- [ ] Responder `place_call` starts an ElevenLabs outbound call (REST, `xi-api-key`; keys in `.env`, placeholders in `env.example`, blanked in smoke; `ECHO_CALLS=live` gate); opens with the code-built `emergencyMessage`, `tempF`/`minsToDanger` passed as sent
- [ ] Fallback to the Twilio `<Say>` call when ElevenLabs is unconfigured, errors or times out; the ladder's call times are unchanged
- [ ] Server tools on a separate port (ngrok only that port): `get_car_status`, `request_call(contact)`, `log_action(note)`; shared-secret header, size cap, rate limit, #18 validation and caps; logged as `agent: voice: …`
- [ ] Agent prompt, first message and tool definitions in the repo with setup steps; manual live checks ("I'm 20 minutes away" → requests Contact #2; 10 calls, ElevenLabs off for 3)
Proven by: server, smoke, manual check (live call)

### 20. app: Expo app with Home and Live alert screens
Owner: Evelio (sw) · Size: L · Depends on: none · Issue: #20
- [ ] An Expo app in `app/` from the Expo SDK template (expo, react, react-native; heat curve with react-native-svg or plain Views; nothing else) reads `/status` and `/history` over the hotspot (server URL configurable); `app/node_modules/` and `.expo/` are added to `.gitignore`
- [ ] Home shows the car card (temperature, seat occupied, alert level, battery) as sent, and shows offline from `/status` `online`/`lastSeen` so old data never looks live. Live alert is a full red screen at EMERGENCY with `minsToDanger` as sent, the heat curve, "I'm on my way" and "Call 911" (opens the dialer via `tel:` with the number filled in, never dials by itself; a config flag can point it at a teammate for the demo)
- [ ] "I'm on my way" posts to a new endpoint that only appends a fixed action-log entry (nothing from the request body is stored; size cap and rate limit); a test shows status, incident and ladder timers are unchanged. Second review for the `server/` change
- [ ] The `app` Checks row is filled with `node --test "app/test/*.test.js"` over plain-JS helpers that don't import React Native. Manual: Home and Live alert match the team's design in Claude Design (link added to this issue before starting)
Proven by: app, server, manual check on Expo Go


### 21. app: Agent feed and Contacts screens
Owner: Evelio (sw) · Size: S · Depends on: 20 · Issue: #21
- [ ] Agent feed shows `/actions` newest first: what the agent or ladder did and why
- [ ] Contacts shows who gets called in ladder order, by name only, from a new read-only `GET /contacts` → `[{order, name}]`; a test shows numbers never appear
- [ ] Manual: during `node simulator/replay.js simulator/recordings/synthetic-ignition-off-to-emergency.jsonl --url http://127.0.0.1:3000/status` the feed updates within one poll
Proven by: app, server, manual check


### 22. sim: Challenger agent that invents scenarios, graded by code
Owner: David (hw) · Size: M · Depends on: none · Issue: #22
- [ ] A development-only script in `simulator/` (built-in `fetch`, key from `.env`) asks Gemini for scenarios in the brief's "Challenger scenario" format; it never runs in a Checks row or touches the live server. Mapping: one array element = one status period; `presence[]` → `AlertInputs.seatOccupied`; `tempF[]` goes through `TempHistory` for `minsToDanger`; ignition off and cancel not pressed throughout
- [ ] A g++-built harness runs each scenario through the real `logic.h` and compares the final level to `expected`; code decides pass/fail. A seed set (no JSON library: written as a C++ header such as `firmware/mega/test/challenger_seed.h`, included by logic_test.cpp; the logic-test command is unchanged) runs offline in `logic-test`, with each seed's `expected` checked by a person against the docs/firmware.md level table before commit
- [ ] Generated scenarios run in a separate manual command that prints totals and failures for the pitch (target 200+); mismatches are sorted by a person, and logic.h is never changed to match an AI `expected` without checking docs/firmware.md
Proven by: logic-test, manual run


### 23. app: Heat insights screen from the Databricks predictions
Owner: David (hw) · Size: S · Depends on: 20, 15 · Issue: #23
- [ ] The #14 notebook exports its predictions to `app/assets/insights.json` (shape documented in the notebook; its header comment updated, since it currently says it writes nothing the app reads); no live Databricks call from the app
- [ ] The Heat insights screen shows them in plain words; values come from the JSON (the brief's "92°F / 14 minutes" line is only an example); predictions not from a real heat test show "(not from a real heat test)"; predictions never feed alerts or calls
- [ ] Uses a real heat-test log (`real-*.jsonl`) from the hardware run
Proven by: app, manual check


### 24. server: send_message through a Telegram bot (DROPPED by Eve, 2026-10-10: calls are the alert channel; send_message removed from the agent, which now has three tools)
Owner: David (hw) · Size: S · Depends on: none · Issue: #24
- [ ] A `sendTelegram(contactName, text)` module posts to that contact's chat; the bot token and chat ids load from `.env` (placeholders in `env.example`, added to smoke's blank list); setup: each contact sends `/start` to the bot to get a chat id
- [ ] Nothing is sent unless `ECHO_CALLS === 'live'` (the same check as `readConfig`); otherwise it's only logged. Errors are logged as a status code and fixed text, never `err.message` or the URL (the URL contains the token)
- [ ] Every message is recorded in the action log with `to` as the contact name, never a chat id; wired into the Responder's `send_message` once that ticket lands
- [ ] Manual: a live test message reaches a teammate's Telegram
Proven by: server, manual check


### 25. dashboard: match the app's design (fonts and level colors)
Owner: David (sw) · Size: S · Depends on: none · Issue: #25
- [ ] Doto / Manrope / Outfit from font files the server serves itself (woff2 + OFL license in `server/dashboard/fonts/`, allow-listed, CSP `font-src 'self'`, no CDN)
- [ ] The app's warm style (colors and gradients from `app/src/ui.js`, Echo logo in the header); EMERGENCY stays deep red as on the app's red Car screen (updated 2026-10-10: replaces the dark shell)
- [ ] Behavior unchanged (read-only, strict CSP, values as sent); existing dashboard tests unchanged; new tests for the font routes and the level-to-color map
- [ ] Manual: replay as in #11 and compare with the Claude Design canvas
Proven by: server, manual check

### 26. app + server: parents save emergency contacts from the app
Owner: Evelio (sw) · Size: M · Depends on: 21 · Issue: none yet
- [x] Contacts tab: "Edit contacts" form (names prefilled, numbers typed, up to 5, PIN); hidden during an emergency or a lost-contact alarm
- [x] `POST /saved-contacts` needs `ECHO_CONTACTS_PIN` (6-12 digits), locks for 60 s after 5 wrong PINs, refuses during an incident, validates names and E.164 numbers, saves to git-ignored `server/contacts.json`
- [x] Saved contacts replace the `.env` contacts only when the server next starts; a running server never changes its list, and `GET /contacts` stays read-only
- [ ] Manual: save from a phone, restart the server, see the new names on the Contacts tab; with `ECHO_CALLS=live`, a verified saved number rings
Proven by: server, app tests, manual check

Design decisions (Eve, 2026-10-11): parents may now add contacts from the app (#26), replacing #21's "no add"; saved lists apply after a server restart so the call floor never changes mid-run.

Design decisions (Eve, 2026-10-10): dark shell with red only at EMERGENCY (#20, #25); Contacts names only, fixed order, no drag or add (#21); History tab shows the heat insight only, run list stays in Later (#23).

Dropped from stage 3 (reviewer): History screen from the status logs. Not in the demo script; the dashboard already draws the heat curve. Back in Later.
