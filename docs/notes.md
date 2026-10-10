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

## 2026-10-10 (#21 Agent feed and Contacts)

- Added Car/Feed/Contacts tabs. Activity merges action-log records with actual adjacent history level changes, newest first, retaining exact reasons and avoiding invented call/transcript claims. Contacts shows server names in fixed ladder order, with the required earlier-never-later agent copy.
- GET /contacts returns only order/name; rejects writes. Actions and contacts poll independently every 2 s, retain saved records with explicit unavailable text, and cannot change car freshness. A persistent emergency banner on non-Car tabs returns to the red alert. No new dependencies.
- Validation: app17, server221, Expo lint and iOS/Android exports pass; independent review found no issues. Final baseline test gate is running.
- Restarted local server with ECHO_CALLS=off, Gemini/voice disabled for phone checks; /contacts confirmed names-only in configured order. Expo reports phone disconnected; asked Eve to reopen and verify tabs/Contacts before replay. Manual one-poll feed timing and native layout still pending. Changes uncommitted, #21 open.

- #21 final test-gate APPROVE against main@9d7f097: both firmware builds and logic checks pass, server218→221 and app10→17; no regressions or tampering. Root lint row/smoke skipped in ticket gate; Expo lint separately passed. Phone verification remains pending.

- #21 phone: Eve confirmed tabs and Contacts order after reopening Expo ("perfect"). Starting accelerated synthetic replay to verify feed updates and emergency-banner navigation; calls remain off.

## 2026-10-10 (#21 phone verification complete)

- Eve confirmed the Feed replay check and emergency-banner navigation ("perfect"): newest-first alert/action entries appeared within the polling interval, and the banner returned to the red Car screen. Tabs and Contacts order were confirmed in the preceding check. Calls remained disabled.
- #21 acceptance checks complete: reviewer found no issues, baseline gate approved with no regressions, app17/server221 tests and both Expo exports passed, and phone verification passed. Closing #21; implementation remains uncommitted.

## 2026-10-10 (visual polish after #21)

- User requested a cleaner, modern visual pass with discretion for design improvements. Added Echo logo header, warm dark surfaces, crisp line icons, level-colored decorative halo, sensor tiles, icon navigation with selected pill, contact initial avatars, clearer timeline cards, and SVG measured/forecast chart. Emergency remains red; all values, polling, contact order, acknowledgement and dialer behavior preserved.
- Added Expo-compatible react-native-svg (icons/chart/halo) and react-native-safe-area-context (device notch/home indicator positioning); no router or server changes. Shared visual components in app/src/ui.js. Gentle online-dot pulse respects Reduce Motion; press feedback is subtle.
- Validation: all17 app tests, Expo lint, iOS/Android exports, npm ci dry-run lockfile validation and diff whitespace check pass. Expo reloaded to phone; no local simulator available, so native visual inspection of this polish awaits user feedback. Changes uncommitted.

## 2026-10-10 (quieter styling and logo launch)

- Eve disliked the boxed offline pill and asked for the Echo logo before the page. Removed status-pill backgrounds/borders, selected-tab containers, the header tagline, timeline-card fills, and notice boxes; retained icons, typography, and clear selected-tab color.
- Added a logo-only startup cover: normal reveal after roughly 0.9s once fonts/image are ready, capped wait1.8s; 260ms fade, no animation with Reduce Motion. Polling starts behind it; a live emergency bypasses it immediately. Introduction does not repeat when changing tabs or returning from the phone dialer.
- Added Expo splash-screen plugin with logo/dark background for installed builds. Expo Go still has its own pre-JavaScript loader; the matching in-app introduction is visible there. Native splash needs a release build to verify.
- New plain-JS launch tests cover minimum display, stalled assets, and emergency bypass;20 app tests pass. Native visual review remains with Eve.

- Eve reported the logo introduction did not render properly. Corrected timing: hold native splash until the in-app image is loaded and laid out, hide native splash, then start the visible pause on the next frame. Replaced nested percentage image sizing with explicit240×80 sizing; fade400ms. Emergency bypass preserved. Added regression for loader time not consuming the logo pause;21 app tests and both platform exports pass. Full Expo reload requested for phone verification; symptom detail still awaiting reply.

- Logo-at-bottom root cause confirmed: installed React Native0.86 removed StyleSheet.absoluteFillObject; spreading undefined silently left LaunchCover in normal flex flow below the page. Replaced with explicit absolute position plus all four edges0. Earlier timing fix alone did not address this layout bug. Phone centering verification pending.

## 2026-10-10 (Heat Insights design preview)

- Eve requested a polished heat visualization ahead of real Databricks data. Added an Insights tab with an amber-to-rose SVG curve, atmospheric contour lines, large example14-minute readout, selectable start/7/14-minute points, and example temperature/humidity/time/warming-rate inputs. Simple dividers and underlined selections replace pills. Four-tab navigation now stacks icons above labels.
- Preview is explicitly illustrative and marked “(not from a real heat test)”; the screen states real tests are pending and current logs are simulator replays. Its local design fixture is not a notebook export and receives no live status. Databricks integration/#23 remains pending. Live emergency navigation remains available above Insights.
- Checks: app21/21, Expo lint, iOS and Android exports, and diff whitespace all pass. Typecheck not applicable: plain JS project without tsconfig. Manual phone check pending: open Insights, tap all three curve times, check narrow-screen wrapping and scroll, then verify an emergency banner returns to Car. No added dependencies for this preview.

## 2026-10-10 (warm weather reference for Insights)

- Eve supplied a peach/yellow/orange weather UI and asked to see it on Echo. Adapted Insights to full-screen SVG atmospheric gradients, dark ink typography, oversized Doto numbers, interactive sun-marker timeline arc, and translucent warming/humidity panels with decorative bars/dots. Navigation and status bar use dark text on this tab. The arc represents example time progression, not a temperature plot; accessible description makes this explicit.
- Sample labels and pending-real-data disclosure remain. No model/live sensor integration. No new dependencies. App21 tests, lint, both platform exports and whitespace checks pass; Expo reloaded. Phone visual confirmation pending, including text wrapping and emergency-banner visibility on the warm background. Typecheck not applicable to this plain-JS project.

## 2026-10-10 (warm style across the app, original logo retained)

- Eve approved the warm Insights page and requested the same style elsewhere while keeping Echo’s original logo. Moved the atmospheric SVG background into shared UI and applied it to Car/offline, Feed, Contacts, and Insights. Shared palette now uses dark brown text, peach/amber light, translucent cream panels, thin dividers, and dark navigation. Dotted sensor numbers remain; page headings use Outfit.
- Replaced Insights’ temporary text wordmark with the original echo-logo.png; the asset also remains on every page and in the centered dark launch cover. Launch background stays explicitly dark to match native splash configuration.
- Emergency Car retains distinct deep red with explicit cream text/chart labels/buttons and navigation; emergency banners on other tabs retain their dark background and light copy. Offline readings remain visibly muted, with increased opacity for readability on the warm background. No polling, action, dialer, sensor, or data behavior changed.
- Checks: all21 app tests, Expo lint, iOS/Android exports, and whitespace pass. Plain JS/no tsconfig, so typecheck not applicable. Expo reloaded for phone review; visual confirmation of all tabs and emergency contrast pending. No new dependencies.

## 2026-10-10 (gradient logo introduction)

- Eve requested the warm gradient behind the pre-reveal Echo logo. LaunchCover now reuses WarmBackground, retaining the original centered logo, pause/fade, Reduce Motion behavior, and emergency bypass. Status bar uses dark content during normal launch. Native splash configuration uses matching peach as its solid background; the full gradient is in the JavaScript introduction (Expo Go owns its earlier loader).
- Validation: app21 tests, Expo lint, and whitespace checks pass. No timing or data changes. Expo reloaded for visual verification.

## 2026-10-10 (Eve, #23 Heat insights from the notebook)

- #23 reassigned from David to Eve. Parts 1-2 done: the notebook's last section builds `insights_payload` and writes `insights.json` to the `export_path` widget (and prints it); the app's Insights tab reads `app/assets/insights.json` instead of hard-coded values. The committed file is the design example (92°F, afternoon, 14 min), marked "Design example: no Databricks run yet" and "(not from a real heat test)". `real` is true only if every run the model used is `real-*`. Only `headline.minutes` is a prediction; the arc points are a run's logged temperatures.
- Waiting on David: #15 (real box → ESP → server) and 2-3 real heat tests. Then: rename the logs `real-<date>-<desc>.jsonl`, upload them to a Databricks Volume (sim logs removed from that folder), set `log_dir`, `timezone`, `export_path`, Run all, paste the printed JSON into `app/assets/insights.json`, run the app check (passes with no test edits), reload Expo. The notebook has never run in Databricks yet; that first run is its real test.
- Optional, not done: make `insights_payload` refuse fewer than 2 points or minutes over 600 so a bad export fails in Databricks instead of at the app check.

## 2026-10-10 (David, ESP on the box: #5 / #15)

Box → ESP → hotspot → laptop server works (#15 item 1, minus the hotspot-drop recovery):
- New data micro-USB cables: both NodeMCUs enumerate as CP2102 (`/dev/cu.usbserial-*`); the old cable was power-only. macOS 12 has the CP2102 driver built in.
- `firmware/esp/secrets.h` (git-ignored) holds the iPhone hotspot and `http://172.20.10.2:3000/status`. The ESP joined as 172.20.10.8. UCF_Guest won't work: 5 GHz on the Mac, likely a per-device sign-in and client isolation.
- Divider built from three 1kΩ (Mega TX1 18 → 1k → ESP RX, RX → 1k → 1k → − rail), ESP G → Mega GND.
- First run: the server received a status every 2.02 s (median, 1.76–4.05 s, 20 statuses, one skipped).

Found on the bench (fix or document):
- With the ESP's own USB plugged in, its USB chip holds RX high and the Mega's lines never arrive. Wired to the Mega, the ESP must run on Mega 5V → VIN with its USB unplugged. docs/firmware.md "Power" says "its own USB cable" for building and testing; that only works with the RX wire off. Needs a one-line doc fix.
- Wiring ESP VIN to the Mega's 5V appears to have restarted the Mega, which retook the seat baseline with something close (presence never flipped, even at 2–3 cm). Re-aimed at about 45 cm and pressed reset: fixed. Before a run, aim at 30–60 cm and reset with hands clear.
- iPhone hotspot: when the Mac left for another network, the hotspot stopped broadcasting and the ESP never rejoined, even after the Mac came back and the Personal Hotspot screen was opened. Only pressing the ESP's RST brought it back (about 18 min of statuses lost). #15 needs "recovers after the hotspot drops": add an ESP Wi-Fi watchdog (if not connected for about 30 s, restart Wi-Fi or the ESP), with a test for its timing helper.
- #17: the ESP doesn't send X-Echo-Token yet. Keep ECHO_BOX_TOKEN unset in server/.env until #17 lands, or every box status gets 401.

Still open for #15: WARNING/EMERGENCY on hardware (this session's log peaked at 85.7 °F; next time use the LM35 against a mug of hot water) with the yellow/red/buzzer/siren checks, the dashboard during that run, the `real-*.jsonl` log for #14/#23 (2–3 runs), and the #13 battery check. Today's room-temperature log (544 lines, ARMED/OCCUPANT only) is on David's Desktop, not in git; it isn't a heat test.

## 2026-10-10 (David, #17 box token)

#17 code is in: the ESP sends X-Echo-Token on every POST, read from firmware/esp/secrets.h. The build stops with a clear #error if the token is missing, and with a static_assert if it is empty, the placeholder, or uses characters outside [0-9A-Za-z_-]. That limit is there because server/.env parsing strips quotes, and a backslash differs between C and .env. A clean clone without secrets.h still builds (Wi-Fi off).

On David's laptop: one generated 48-char hex token is in both firmware/esp/secrets.h and server/.env (both git-ignored; server/.env holds only that line). The ESP on the box still runs the pre-#17 firmware, so don't restart a server with that .env until the ESP is re-flashed, or every box status gets 401.

To do (David): the #17 manual check. Re-flash the ESP (VIN and RX unplugged, upload over USB, then back to RX + VIN), restart the server (startup says "box token auth: on"), check the dashboard updates every ~2 s with no "rejected" lines, and that a curl POST without the token gets 401.

For Eve:
- Before turning on ECHO_BOX_TOKEN anywhere, the box's ESP must run the #17 firmware and her server/.env must hold the same token as the box's secrets.h.
- Follow-up in server/ (safety-critical, so out of #17's scope): server/auth.js startup text and server/env.example still describe #17 as pending; auth.test.js asserts /#17/ on that text.
- #16's unchecked doc item: docs/firmware.md doesn't mention the X-Echo-Token header yet (needs David's OK; it's a header, not a status field).
