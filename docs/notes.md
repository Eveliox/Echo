# Session notes

Append a dated entry per session. Never rewrite old ones.

## 2026-10-10 (David)

Done:
- #2 alert levels, #4 sensors + status line, #5 ESP forwarding: code merged, all checks green. Each issue stays open until its manual hardware check passes.
- Laptop toolchain: gh, arduino-cli 1.5.1 with cores arduino:avr 1.8.8 and esp8266:esp8266 3.1.2, libraries "DHT sensor library", "Adafruit Unified Sensor", LiquidCrystal (#8 needs it; the IDE bundles it, arduino-cli does not).

Decisions:
- Seat baseline is taken only at power-up. No auto-retry: a retry could learn an occupied seat as empty. While there is no baseline the LED shows the seat fault code and USB Serial repeats a "#" line; recovery is a power cycle with the seat empty.
- Humidity repeats the last good DHT11 value for up to 30 s, then sends the 0 placeholder.
- ESP forwards only the newest complete line, POST timeout 300 ms (worst case about 1.2 s, under the 2 s period). ECHO_SERVER_URL must be http://<IPv4>:<port>/status; a hostname is refused.

Open questions for Eve:
- Make `humidity` nullable (doc change, server/status.js accepts null, sketch sends null instead of 0)?
- Add the magenta seat fault code to the LED table in docs/firmware.md.

Next session starts with hardware:
1. RGB LED was wired to D9/D10/D11; moved to D44/D45/D46 per the pin map (common cathode). Re-check before power-up.
2. Upload firmware/mega (`arduino-cli upload -p /dev/cu.usbmodem14201 --fqbn arduino:avr:mega firmware/mega`, run by a person), seat empty, ignition jumper in. Run the #4 manual check (status lines, sensors, OCCUPANT under 45 s, cancel, ignition, seat fault on power-up with the ultrasonic unplugged) and the #8 LED, buzzer and LCD checks.
3. The ESP did not show up as a USB port: check its USB cable carries data and install the CH340/CP2102 driver if needed. Then fill firmware/esp/secrets.h (laptop IPv4 on the hotspot), upload with the ESP RX wire unplugged, and run the #5 manual check (a POST every 2 s, recovery after the hotspot drops).

## 2026-10-10 (David, hardware session)

Mega bench test with the uploaded main build (SIMULATE_TEMP off):
- Readings OK: ignition (IDLE/ARMED), LM35 about 75 °F at room temperature, DHT11 51–57 %, HC-SR04 baseline 17–30 cm, status line every 2 s.
- RGB LED: blue solid/blinking and the magenta seat-fault code verified (red + blue). Green and the yellow/red alarm colors not yet seen.
- Seat-fault path verified: with the ultrasonic unplugged at power-up, the "#" line repeats and the LED shows magenta.
- #4 alert-speed check passed twice: OCCUPANT 30.2 s and 30.1 s after the ignition jumper was pulled (target under 45 s). Cancel returned to ARMED and the ignition jumper returned to IDLE both times.
- Not reached: WARNING/EMERGENCY. Hand and hair-dryer heat peaked at 90.6 °F. Next time press the LM35 against a mug of hot water, or use the SIMULATE_TEMP joystick path in a local build and switch it back off.

Wiring fixes found on the bench:
- The RGB LED had been on D9/D10/D11; it is on D44/D45/D46 now (common cathode).
- When the ultrasonic and DHT11 drop out together, check the breadboard rail split or the bridge between the two breadboards first.

ESP (#5) blocked: the Mac doesn't enumerate the NodeMCU at all, so it's the cable or the board, not a driver. Next: try a known data micro-USB cable, then the spare NodeMCU, then upload firmware/esp once. After that it can run from Mega 5V → VIN, GND → G (never both USB and VIN).

Issues: #2 and #4 have every acceptance criterion met; close them once Eve has seen this. #5 stays open until the hotspot check.

## 2026-10-10 (Eve, Twilio live call)

First live call (#6 manual check) passed at about 07:20: `ECHO_CALLS=live node server/server.js` plus a curl EMERGENCY status rang Contact #1, and Echo's spoken message played. Eve reported it ran smoothly.

Twilio setup lessons (for #19 and anyone redoing it):
- `server/.env` is copied from `server/env.example` and is git-ignored. Fill Account SID, Auth Token, the Twilio number and Contact #1, then save before starting the server.
- On the free trial, Twilio rejected our call with 400 "trial accounts have limited parameter access": the server sends the message inline as the `Twiml` parameter (server/calls.js), which this trial type doesn't allow. Eve upgraded the account (and got a new Twilio number), and the error went away. The upgrade also drops the "press any key" trial notice and the verified-numbers-only rule, which the demo needs for a judge's phone.
- Next error was 21215 "Account not authorized to call ...": turn on United States under Voice > Settings > Geo permissions, then wait a couple of minutes.
- Stop a test server within 2 minutes, or ladder step 2 calls again (step 3 calls Contact #2 at 3 minutes).

No Twilio notice played: the call went straight to "This is Echo…". So #19's voice agent can start speaking as soon as the call is answered, with no trial prompt to work around.

## 2026-10-10 (Eve, Gemini Responder and ElevenLabs voice)

Live end-to-end test passed at 13:37 (#18 + #19, `ECHO_CALLS=live`, synthetic recording replayed):
1. Ladder step 1 called Contact #1 with the plain Twilio alert.
2. Gemini turn 1 got 503 "high demand" from Google and did nothing; turn 2 (25 s after EMERGENCY) called Contact #2 early as an ElevenLabs voice conversation.
3. Contact #2 said "about twenty minutes away"; the voice agent logged it and requested a call to Contact #1, placed as another voice call.
4. Every call opened with the box's values; every action showed in the dashboard feed with its reason. Server stopped before ladder step 2.

Gemini (#18):
- `gemini-2.5-flash` answers 404 for new accounts ("no longer available to new users"), even though the models list shows it. The code default is now `gemini-3.8-flash`, sent with low thinking (replies about 3-5 s); model timeout 15 s. `GEMINI_MODEL` in `server/.env` overrides it. Use a pinned name, never `gemini-flash-latest`.
- Google returns 503 "high demand" now and then; the agent skips that turn and the ladder is unaffected.
- The project is on the paid tier: set a budget alert in Google Cloud Billing.

ElevenLabs voice (#19), full steps in `server/voice/agent.md`:
- ElevenLabs is two products: ElevenCreative (voices) and ElevenAgents (use "Switch" bottom left). Agents, Phone Numbers, API keys and Secrets live in ElevenAgents; Phone Numbers and Secrets are under "Back to workspace".
- Preview needs test values for every dynamic variable (`{ } Vars`), or it fails with "Missing required dynamic variables in first message: {'emergency_message'}".
- The agent ID is only the `agent_...` part of the URL; copying the rest of the address bar breaks it.
- Tool webhooks: URL must start with a single `https://`; header name exactly `X-Echo-Voice-Secret` with the `echo-voice-secret` secret; body property identifiers exactly `reason`, `contact`, `note`. ElevenLabs refuses to save a tool with an empty body, so `get_car_status` takes an optional `reason`.
- Debugging: ngrok's local inspector (http://127.0.0.1:4040) shows each request's path and status; a 401 from GET /favicon.ico is just a browser opening the ngrok link. ElevenLabs' tool "Tool Logs" tab shows whether the agent tried a tool at all.
- The ElevenLabs workspace secret `twilio_token_...` belongs to the imported Twilio number: keep it.
- Free ngrok addresses change on every restart: update the three tool URLs after restarting ngrok, and stop ngrok when not testing. Tunnel only the voice port (3100), never 3000.

## 2026-10-10 (Eve, ticket #20 Expo app)

- Added SDK 57 Expo app: Home, offline last-known readings, and red Live alert for online EMERGENCY. The phone displays the box's numbers without calculating a countdown. Local response freshness prevents phone/laptop clock skew from hiding an emergency; informational last-heard ages still depend on clock agreement.
- `POST /on-my-way` records fixed text only, with a body cap and global cooldown. Tests prove status, history, incident, and the 0/2/3/5-minute ladder remain unchanged. Independent review found clock-skew and stale occupancy-copy issues; both were fixed and covered by tests.
- Dependencies: Expo, React, React Native; `expo-font` loads bundled OFL Doto 900, Manrope 400, and Outfit 600. The chart uses Views. ESLint tooling is development-only, required by the Expo template's instructions.
- Setup: copy `app/env.example` to git-ignored `app/.env`, set the laptop hotspot IP/port and local Mom/demo numbers, then run `npm ci` and `npx expo start` from `app/`. The phone needs SDK 57-compatible Expo Go and the same hotspot. Keep `EXPO_PUBLIC_ECHO_DEMO_CALLS=true` for the teammate dialer. App config is bundled and must never contain server secrets.
- Pending manual check: start the server with `ECHO_CALLS=off`, replay the synthetic recording, verify Home → Live alert and offline after silence/network loss, tap the log acknowledgement, and verify the demo/Mom buttons open the dialer without placing a call. Compare typography/layout with the ticket's Claude Design canvas at 390×844; that canvas was inaccessible to the implementation tools. Do not close #20 until the Expo Go check passes. The agent-order copy belongs with the Contacts screen (#21), which is outside this implementation.
- Validation: test-gate APPROVE against `main@be87f4c`, no regressions or test tampering; 218 server tests, 9 app tests, both firmware builds, and 104,911 logic checks pass. iOS and Android Expo exports pass. Smoke was skipped per ticket-mode workflow; the root lint Checks row remains TODO.

## 2026-10-10 (Eve, preparing #20 phone check)

- Created ignored app/.env using the current laptop Wi-Fi IP and demo dialing enabled; Mom/demo numbers still need local configuration for dialer checks.
- The documented npm ci exposed missing/inconsistent optional ESLint resolver dependencies in package-lock.json. Repaired the lock with npm install --package-lock-only; npm ci now passes. No direct dependency versions changed.
- Started Expo LAN and a local server with calls and AI disabled. Phone observations and recording replay are still pending; #20 remains open.

- Phone connection confirmed by Eve ("it works very nice"). Started the synthetic replay at 500 ms per status for the Home → Live alert check, with calls disabled. Screen transition/offline and button observations still await confirmation.

- Eve confirmed the replay phone check passed ("perfect" in response to Home → red Live alert with heat chart → OFFLINE after silence). Expo Go connection and these screen transitions are now manually verified. Acknowledgement and configured demo/Mom dialer buttons still need phone verification; no claim of complete design-canvas comparison. #20 remains open for those remaining checks.

- Acknowledgement phone check: Eve tapped the button and saw the repeat cooldown message. GET /actions confirmed the fixed app note was recorded at 18:30:13Z. Improved feedback: successful button says Message logged and disables for the cooldown; confirmation sits directly below it; in-flight guard prevents duplicate taps. Updated feedback still needs visual confirmation on phone.

- Eve confirmed the updated acknowledgement feedback works on the phone ("perfect it works"): Message logged button state and adjacent confirmation manually verified. Home/live/offline transitions and acknowledgement now pass phone checks. Configured demo/Mom dialer behavior and complete design-canvas comparison remain unverified; #20 remains open.

## 2026-10-10 14:33 (#20 handoff)

- Core #20 implementation is committed as b4c0031; phone verified Home → Live alert → offline and the acknowledgement after its feedback fix.
- Follow-up changes remain uncommitted: app/App.js acknowledgement feedback, app/package-lock.json clean-install repair, docs/notes.md. App tests and lint pass; npm ci succeeds.
- Remaining closure checks: configured demo/Mom dialer opens without calling, and explicit comparison/approval against the Claude Design boards. #20 remains open; no unverified checks marked passed.
- Next implementation: #21 Agent feed from /actions (newest first), Contacts in fixed ladder order from a names-only GET /contacts; include the agent-can-call-sooner-never-later copy there.

## 2026-10-10 (#20 supplied design references)

- Eve supplied six Claude Design screen images and requested design refinement plus demo/Mom dialer checks. Compared Home/offline/Live alert source layout to boards 1–3: replaced stacked cards with a centered number and unit, Family car header, compact Seat/Movement/Humidity/Battery row, last-heard timestamp, simple offline Call Mom action, and compact emergency chart/actions. Preserved agreed dark Home/offline with level glow and red only at EMERGENCY.
- Added a current chart point and kept the box-derived forecast; no sample call claims or predictions copied from the design. Feed/Contacts belong to #21; insights belong to #23. Contacts remain names-only and fixed order per the ticket decisions, despite draggable numbers in the reference.
- Validation after refinements: 10 app tests, Expo lint, iOS/Android exports, diff whitespace check pass. Native visual approval of these refinements is pending. Requested teammate/demo number for both local dialer targets; awaiting reply, no numbers assumed or copied from mockups.

- Configured both local Mom/demo dialer targets using Eve’s supplied US number in ignored app/.env; demo mode remains true. Restarted Expo to pick up configuration. Phone verification pending; number intentionally omitted from tracked notes.

- Eve confirmed offline Call Mom opens the configured number in the phone dialer/confirmation prompt without placing a call. Starting the emergency demo-dialer phone check next.

## 2026-10-10 (#20 phone verification complete)

- Eve confirmed the emergency demo dialer opens the configured teammate number without calling and approved the updated emergency layout (number, chart, buttons: "yes perfect"). Offline Call Mom was confirmed in the preceding check.
- Phone checks now cover Home → Live alert → offline, acknowledgement logging and persistent feedback, both dialer buttons, and user approval of the design refinements based on the supplied references. Preserve the agreed dark Home/offline and red emergency treatment.
- #20 is ready to close. Follow-up UI, lockfile, tests, and notes remain uncommitted. Next ticket: #21 Agent feed and names-only Contacts in fixed ladder order.
