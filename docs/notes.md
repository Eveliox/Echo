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

## 2026-10-10 (David, #22 Challenger, plus open items for David and Eve)

#22 committed as review-pending (issue stays open):
- 15 seed scenarios in firmware/mega/test/challenger_seed.h run in logic-test and all pass. They are still marked "PENDING HUMAN REVIEW (David)", which the ticket requires before sign-off. The reviewer agent re-derived all 15 against docs/firmware.md and agrees, but that doesn't replace David's check.
- Seeds that rest on logic.h decisions the doc doesn't state: #3 (exactly 30 s counts as the dwell), #11 (OCCUPANT is sticky), #12 (the dwell must be unbroken; a 1-period gap can't happen on the box, because seat detection needs 3 readings in a row). #7 and #8 reach their minutes-based level only at the 60th sample; add a few periods.
- Manual commands: `node simulator/challenger.js --count 200` (needs GEMINI_API_KEY in server/.env; not set on David's laptop) and `--from <file>` (offline re-grade; the example gives 2 pass, 1 FAIL, 1 invalid, both deliberate).
- Reviewer mediums to fix before the live run: a run where every Gemini batch fails exits 0 with 0/0/0, with no "requested N, got M"; scenario names starting with `#` are silently skipped by the harness. Lows: seed comments copy threshold numbers; abort on a non-retryable 4xx; move example.jsonl out of the results folder.

Waiting on David (hardware, one session at the box):
1. Re-flash the ESP with main (#17 token + #15 watchdog): unplug VIN and RX, upload over USB, then RX + VIN back (power-cycle before testing). Restart the server ("box token auth: on"); dashboard updates every 2 s; curl without the token gets 401.
2. #15 hotspot recovery: hotspot off about 60 s and about 3 min; the laptop leaves and returns; server stopped (slow 3-min cycle). Statuses resume without RST. Record the times here.
3. #15 heat run: LM35 against a mug of hot water → WARNING/EMERGENCY with yellow/red, buzzer and siren; dashboard live; one ladder step-1 line (calls off); rename the log `real-<date>-<desc>.jsonl`. 2–3 runs for #14/#23.
4. #13 battery divider check on pack power.
5. #22 seed review, then the live 200+ run once a Gemini key is available.

Waiting on Eve:
- OK the battery values (7.0/9.0 V, 5.5 V no-pack cutoff, 0.7 V diode drop); remove "pending Eve's OK" in docs/firmware.md.
- OK the 0.1-min rounding-before-compare rule for docs/firmware.md (#12).
- Review the #12 changes to the synthetic recording (60 IDLE lines prepended; alarms now start on minutes).
- Humidity nullable? Magenta seat-fault code in the docs' LED table?
- Box token: don't enable ECHO_BOX_TOKEN until the box runs the #17 firmware with the same token. Follow-up: server/auth.js startup text and server/env.example still describe #17 as pending (auth.test.js asserts /#17/).
- docs/firmware.md power note: when wired to the Mega, the ESP must run on Mega 5V → VIN (its USB holds RX high).
- Pi 4 idea (stretch, needs the team): keep the Mega as the alarm; a Pi replaces or backs up the ESP, buffers statuses offline on SD, and uploads to Databricks.
- Gemini key for the #22 live run (paid tier; budget alert).

## 2026-10-10 (David, #25 dashboard style)

#25 committed: the dashboard uses the app's warm style (palette and heatSky/heatSun/heatEmber values from app/src/ui.js), the self-served Doto/Manrope/Outfit TTFs with OFL licenses, and the Echo logo. EMERGENCY turns the whole page deep red with cream text; offline is muted. Existing dashboard tests are unchanged; new tests pin the asset routes, the level-to-theme map, and byte-identity with the app's fonts and logo (an app-only palette or asset change will now fail the server check until the dashboard follows).

For Eve:
- The CSP gained `img-src 'self'` as well as `font-src 'self'`; the logo can't load otherwise under default-src 'none'. Update #25's text ("CSP gains only font-src") to match.
- A last-known EMERGENCY shows muted (not red) once the box is offline, as the ticket asks and as the app does; the level text still says EMERGENCY. Worth a conscious team OK.
- app/assets/fonts/doto-OFL.txt says 2024 and manrope-OFL.txt says 2018; the font files say 2024-2024 and 2019. The server copies use the files' own lines.
- Assets are no-store (~1.1 MB per page load, not per poll). Fine for the demo.

To do (David, with a phone): the #25 side-by-side. Start a second server on port 3001 (ECHO_CALLS=off, ECHO_LOG_DIR in a temp folder), replay the synthetic recording into it with `--token` (server/.env now sets ECHO_BOX_TOKEN), then compare the laptop page and the app's Car tab through EMERGENCY.

## 2026-10-10 (David, hardware: #17 and #15 recovery verified)

The ESP was re-flashed with main (#17 box token + #15 Wi-Fi watchdog), then went back to Mega 5V → VIN with its USB unplugged.
- Watchdog seen on the bench: with the hotspot hidden (Mac on UCF_Guest), the ESP logged `Wi-Fi down (status 1, …)`, then `Wi-Fi down 30 s (status 1, 0 failed): restarting Wi-Fi`. Once the hotspot was visible again it rejoined as 172.20.10.8 with no RST.
- #17 manual check passed: the server started with `box token auth: on` (token in server/.env and secrets.h, both git-ignored). The box's statuses were accepted (online, live readings, zero box rejections), and a curl POST without the token got 401.
- #15 "recovers after the hotspot drops" passed: hotspot off about 40 s, then on. Last status 22:55:03 UTC, offline 22:55:14, statuses resumed 22:55:53 (50 s gap overall, inside the ~100 s worst case), with nobody touching the ESP. This morning the same drop needed RST.
- OCCUPANT → ARMED during the check was David pressing cancel, not a Mega restart.
- Not run: the 3-minute drop (reboot path) and "server stopped while on the hotspot" (slow 3-min cycle). They're optional; the code paths are unit-tested.

Still open for hardware (David):
1. #15 heat run: LM35 against a mug of hot water → WARNING/EMERGENCY with yellow/red LED, buzzer, siren; dashboard live; exactly one ladder step-1 line (calls off). Rename the server log `real-<date>-<desc>.jsonl` (logs go to ~/Desktop/echo-logs while the server runs with ECHO_LOG_DIR there). 2–3 runs for #14/#23.
2. #13 battery: fit the A0 divider (Mega VIN → 10k → A0 → 10k → GND), set BATTERY_DIVIDER_WIRED = true locally, pack in the barrel jack, laptop USB unplugged, siren keeps going, GET /status shows a numeric battery.
3. #25 phone side-by-side (second server on 3001, replay with --token).
4. #12 optional: watch minsToDanger count down and LCD line 2 during the heat run.

## 2026-10-11 (David, seat rule change)

Decision (David, hardware owner): a reading counts as occupied-looking if its median is 40 cm or less, OR at least the existing drop below the power-up baseline; three readings in a row both ways, as before. The 40 cm rule works even with no baseline, so a bad or missing power-up measurement can no longer hide an occupant. On the bench, power-ups twice took a too-short baseline, and even a hand at 3 cm never counted. The change only adds detections (the reviewer proved it; a test fails if the 40 cm rule is removed). docs/firmware.md "Seat detection" states the rule. One existing assertion changed deliberately: test_seat_baseline_needs_majority_valid now checks that a no-baseline reading over 40 cm stays empty, instead of 5 cm.

Aiming rule (supersedes "aim at 30–60 cm" in the 2026-10-10 notes): the empty seat must read well over 40 cm, ideally 55–60 cm. At 40 cm or less it reads occupied forever (false alarms). Between 40 and 50 cm the margin is thin (at a 45 cm empty seat, a 5 cm change counts). Verified on the box after uploading: empty seat 49–52 cm → no; hand at 26–30 cm → yes after 3 readings.

For Eve: the seat rule is a safety behavior change; please review docs/firmware.md "Seat detection". docs/backlog.md #3's wording still lists only the drop rule.

Also: the dashboard now shows "Seat distance cm" (the box's distanceCm as sent), which makes bad aiming visible at a glance.

## 2026-10-11 (David, heat run attempt; hardware paused)

- No clean heat run yet. In the first attempt the LM35 read 90 ↔ 111 °F within seconds and sat at about 116–119 °F with nothing heating it: an electrical fault (likely water from the mug on the legs, a loose A1 wire, or the sensor bumped out of place), not real heat. After unplugging and checking, it read a steady 78–79 °F. That log is renamed `spoiled-2026-10-11-lm35-glitch.jsonl` on David's Desktop (~/Desktop/echo-logs); never upload it as real.
- The clean run that followed only went IDLE/ARMED/OCCUPANT at 76–79 °F (no heating), so it isn't a heat test either.
- Next heat run: keep the mug's outside against the LM35 with no drips, keep the A1 wire seated, start a fresh server per run (one log per run), and go past 104 °F. Then rename `real-<date>-<desc>.jsonl`.
- The server and trackers are stopped. The Desktop logs from today are room-temperature or bench-test data only.

## 2026-10-11 (David, Databricks set up; pipeline proven)

- Databricks Free Edition: catalog `workspace`, Volume `/Volumes/workspace/default/echo_logs`; notebooks/heat_test.py imported into David's Home. Widgets: log_dir `/Volumes/workspace/default/echo_logs`, timezone `America/New_York`, export_path `/Volumes/workspace/default/echo_logs/insights.json`. Compute: Serverless.
- First Databricks run ever: Run all completed with no errors on one sim log (`sim-2026-10-11-synthetic-replay.jsonl`: the synthetic recording replayed at 2 s into a temp server with the box token). The output passes the app's `validInsights` (`valid: true`); the app would show "On a 80°F night, your car hits danger in 3 minutes. (not from a real heat test)".
- Not put in the app: one synthetic run gives mae 0.0 in-sample (memorized) and a hair-dryer-speed "3 minutes". Eve's design example stays in app/assets/insights.json until there are real runs.
- For real runs: delete the sim file from echo_logs, upload `real-*.jsonl`, Run all, validate, then paste into app/assets/insights.json.
- For Eve: the app's sentence says "On a 80°F" (should be "an" before 8x/11/18 °F); and the notebook's headline uses the run's first moment, where warmRateFPerMin was -0.04 (cooling) while predicting 3 min. Pick a warming moment instead.

## 2026-10-11 (David, Databricks auto-upload)

- `simulator/databricks_upload.js` (dev tooling, never in a Checks row, never touches the Echo server or alarms) uploads heat-test logs to the Volume through the Databricks Files API (HEAD to skip files already there, PUT with overwrite=false) and can start the notebook job (`--run`, Jobs API run-now; never retried after a timeout). Config is in the git-ignored server/.env: DATABRICKS_HOST and DATABRICKS_TOKEN (set on David's laptop), optional DATABRICKS_VOLUME_PATH (default /Volumes/workspace/default/echo_logs) and DATABRICKS_JOB_ID (not set yet). Names are allow-listed (`real-*`/`sim-*` only, never status-/spoiled-). `--watch` uploads a file only once it has stopped growing for one interval.
- Verified live: the token and host are accepted, and the script sees the Volume (the hand-uploaded sim file is reported "already in the Volume, skipped"). A first real PUT of a new file hasn't happened yet.
- After each heat run: stop the server, then `node simulator/databricks_upload.js --dir ~/Desktop/echo-logs --latest --as real-<date>-<desc>.jsonl --run`. Delete the sim file from echo_logs before the first real run.
- The notebook's widget defaults now point at David's Volume and America/New_York (a job run ignores interactive widget values). Re-import notebooks/heat_test.py into Databricks, or set task parameters on the job.
- App: deps installed from the lockfile (`npm ci` in app/); app/.env (git-ignored) is copied from env.example (server URL http://172.20.10.2:3000). Expo needs the same Expo account signed in on the laptop (`npx expo login`, run inside app/) and in Expo Go. David's account was made with Google, so set a password at expo.dev for the CLI.

## 2026-10-11 (Eve, dashboard and app: lost alarm stays an alarm)

Decision (Eve, PM): when the box goes offline, or the dashboard loses the server, and the last level was WARNING or EMERGENCY, both screens keep the alarm look. This reverses #25's "a last-known EMERGENCY shows muted" (David asked for a conscious team OK; this is it). Reason: losing contact mid-emergency is worse news, not better, and in the demo the screens were going calm right as the ESP8266 is pulled.
- Dashboard: the theme stays caution/emergency, and a banner reads "No updates since HH:MM:SS · last alert X. The box alarms on its own without Wi-Fi. Go to the car now." Below WARNING it still goes muted. dashboard-theme.test.js's offline assertions were rewritten for the new rule on purpose.
- Dashboard readability: minutes to danger is the biggest reading, on its own row; the heat curve has a dashed danger line (heatCurve takes an optional dangerF); the newest action is larger.
- App: offline at WARNING/EMERGENCY shows an urgent notice and Call 911 (the demo dialer when EXPO_PUBLIC_ECHO_DEMO_CALLS=true). The offline "Call Mom" button and EXPO_PUBLIC_ECHO_MOM_NUMBER are gone; the parent holds the app. A local app/.env can drop that line.
- Demo script doc (Claude Docs, "Echo: Devpost & Demo Script"): the ESP-pull beat now names the red dashboard banner and the app's Call 911; the close says Heat insights is a design example unless real heat runs land.

For David: please look at the dashboard and the app's Car tab with the ESP pulled during the next replay or heat run.

## 2026-10-11 (Eve, #26 contacts from the app)

Parents can now replace the contact list from the app's Contacts tab (Edit contacts: names prefilled, numbers typed, up to 5, PIN). Decision (Eve): saved contacts take effect only when the server next starts, so the ladder, Responder and voice agent never change their list mid-run. This replaces #21's "no add".
- Server: `POST /saved-contacts` is off until `ECHO_CONTACTS_PIN` (6-12 digits) is set in server/.env. A wrong PIN gets 401; 5 in a row lock all attempts for 60 s; refused with 409 during an incident. The list goes to server/contacts.json (git-ignored, holds numbers). At startup the server prints which list it uses ("N saved from the app" or "from server/.env").
- To undo: delete server/contacts.json and restart; the .env contacts come back.
- Demo gotcha: on the Twilio trial, a saved number only rings if it's verified in Twilio. Save the demo phones' numbers, or keep using the .env ones.
- Not done: the manual check in #26 (phone save → restart → new names; a live call to a saved number). No GitHub issue opened yet.

## 2026-10-11 (David, humidity and DHT11 removed)

Decision (David, with Eve's agreement): the DHT11 is physically removed and the system tracks temperature only. The `humidity` status field is gone from docs (firmware.md parts, pin map with D2 free, JSON, build steps; brief; backlog), firmware (logic.h, mega.ino; the DHT library is no longer needed), the server validator, the simulator recording (107 lines, humidity keys only), the notebook features and insights payload (`inputs` now `{warmRateFPerMin}`), the app (Insights humidity card, validator, model, insights.json), and tests. Supersedes the "make humidity nullable?" open questions above.
- Compatibility: the server accepts statuses with or without humidity (any value ignored), so a box still on old firmware stays online and the ladder is unaffected. Pinned by unit and HTTP tests.
- Re-flash the Mega to stop sending humidity (the port can change: check `arduino-cli board list`; it was /dev/cu.usbmodem14101 today). Until then, the voice agent's get_car_status still sees the old humidity value. Re-import notebooks/heat_test.py into Databricks.
- For Eve: app/test/model.test.js "preserves zero and decimals" lost its only decimal case (humidity 41.25), so add a decimal battery value; the Insights row now has a single full-width card; brief.md still lists "sunlight" as a model input while `light` is pending.

## 2026-10-11 (Eve, cinematic dashboard design)

- Restyled the local browser dashboard from the supplied warm, translucent mobile reference: charcoal shell, amber-lit SVG cabin seat, cream typography, prominent Doto danger timer, responsive two-column layout, and action timeline. Uses existing local fonts and logo; no dependencies or remote assets. Mobile app unchanged.
- Slow decorative lighting and entry motion respect reduced motion; emergency disables entry animation and brings the timer before the artwork. Existing stale readings and lost-alarm banner remain; data/polling/call behavior unchanged.
- Checks: all 263 server tests passed. Installed Playwright checked 1440/768/390/320 widths, no horizontal overflow, emergency and lost-emergency states, reduced motion, and browser errors with intercepted synthetic preview data only. Screenshots in /tmp/echo-dashboard-{desktop,mobile,emergency}.png.

## 2026-10-11 (David, unused parts removed)

Decision (David, with Eve's agreement): the box has no joystick, photoresistor, A0 battery divider, 1602 LCD or PIR. All are removed from firmware (logic.h, mega.ino; LiquidCrystal is no longer needed), server validation, simulator recording and fixtures, notebook, app (Home shows only Seat) and docs. The `light`, `motion` and `battery` fields are gone. The status line is now state, tempF, presence, distanceCm, minsToDanger. #13 is dropped. The remaining box: Mega, ESP8266, HC-SR04 (D6/D7), LM35 (A1), RGB LED (D44–46), passive buzzer (D8), ignition jumper (D4), cancel button (D5). Free pins: D2, D3, D22–D27, A0, A2, A3.
- Compatibility: the server accepts every older format (humidity, motion, battery, light; any value ignored) and the new line, pinned by unit and HTTP tests. Until the Mega is re-flashed, /status and the voice agent's get_car_status still carry the old null fields.
- CLAUDE.md: the two SIMULATE_TEMP lines (hardware rule, demo readiness) were removed with David's OK, since the flag no longer exists.
- docs/firmware.md also records the bench finding: while wired to the Mega, the ESP runs on Mega 5V → VIN (its USB chip holds RX high), so the "USB power bank" advice is replaced.
- To do: re-flash the Mega (check the port with `arduino-cli board list`); re-import notebooks/heat_test.py into Databricks.
- For Eve: the app's Home sensor row now has one cell, and model.test.js lost the battery zero case (decimal coverage remains in the viewModel tests).

## 2026-10-11 (Eve, dashboard palette alignment)

- Kept the cinematic dashboard layout and motion, replacing the charcoal treatment with the mobile UI's exact peach/gold/orange background and brown text tokens. Panels use the shared translucent cream surfaces. Restored the unfiltered original orange-to-pink logo; the red emergency state gives it a cream backing for visibility.
- Browser checks passed across desktop/mobile widths, emergency/lost-alarm states, and reduced motion. No mobile app or data behavior changes.

## 2026-10-11 (Eve, reference dashboard shell)

- Restyled the browser dashboard around the supplied smart-home layout while retaining the mobile palette and original logo: sticky side panel, section menu with graduated emphasis, icon capsule, 8px mixed tile grid, 14px corners, and light system-font metrics. Mobile uses a horizontal menu and single-column cards; emergency keeps the timer first.
- Navigation and corner arrows focus existing in-page sections via fragment links and CSS target styling. No routes, polling, APIs, or data logic changed. No profile, unread count, or percent-change data exists, so these were not fabricated; the bell links to response activity. Activity rows remain readable and noninteractive rather than suggesting unavailable detail pages.
- Updated resource-link validation to allow fragment links only when their target exists; file allow-list checks remain. All 267 server tests passed on rerun after an unrelated startup-log timing failure. Browser checks passed at 1440/768/390/320 widths, section/rail/bell links, emergency/lost-alarm states, reduced motion, and unchanged logo colors.

## 2026-10-11 (Eve, logo-gradient accents and rotating seat)

- Added orange/coral/pink decorative tokens matching the original logo; used on the cabin backdrop, inline SVG heat curve, and small accents. The actual logo asset remains unmodified; status and emergency color semantics remain intact.
- Replaced the flat SVG chair with a CSS 3D seat made from eight six-faced solids, cream upholstery, and gradient shell. Slow 24-second rotation, pause/resume disclosure control, hover pause, and static reduced-motion/emergency presentation. No dependencies, external models, or data logic changes.
- All 267 server tests pass. Browser checks cover responsive layouts, rotation changing transforms, pause freezing transforms, keyboard resume, emergency stop, reduced motion, and section navigation. Asset test now validates local SVG gradient references separately from the unchanged file allow-list.

## 2026-10-11 (Eve, exact gradient and borderless shell)

- Applied Eve's supplied gradient shades: #FF9A4A, #FF6150, #F2334F, #E0306A, including the chair shell and chart gradient. Original logo image unchanged.
- Removed the vertical icon capsule and its CSS; retained the text section menu. Removed the exterior rounded frame, coral top rule, and surrounding gradient gutter; aligned sidebar text to the freed space. Card separators retained.
- All 267 server tests pass; browser checks cover the removed capsule, absent shell border, responsive layout, navigation, and chair motion controls.

## 2026-10-11 (Eve, animated car cabin scene)

- Replaced the CSS chair with a lightweight procedural 3D sedan rendered on Canvas: curved cream body, wheels, translucent roof, coral seats, and orange-to-pink heat waves. Gentle orbit keeps the interior visible. Decorative only; no inferred heat values or data changes.
- New same-origin dashboard/cabin.js is served through the explicit dashboard asset allow-list. No dependencies or external model requests. Pauses via the disclosure control, mouse hover, reduced motion, hidden page/offscreen canvas, and emergency mode.
- All 267 server tests and browser checks passed, including animated canvas changes, frozen pause/emergency frames, keyboard resume, and 1440/768/390/320 layouts. Restarted the local dashboard and isolated synthetic-data preview to load the new asset route; calls remain off.

## 2026-10-11 (Eve, realistic transparent sedan)

- Replaced the geometric car with an imagegen automotive render matching the supplied reference: realistic white electric sedan, translucent body and roof, visible interior and highlighted coral rear seat. Asset has true alpha, copied into server/dashboard/assets/transparent-sedan.png and explicitly allow-listed.
- cabin.js now animates gentle float and heat shimmer around the locally bundled render; it is a rendered image, not an orbitable mesh. Pause, reduced-motion, visibility, and emergency handling remain. Original logo unchanged.
- All 267 tests pass on rerun; the known startup-log timing test failed on the initial run. Browser screenshots and animation checks passed. Both local servers restarted for the new asset route.

## 2026-10-11 (Eve, dashboard detail polish)

- Enlarged the cabin tile and separated the transparent car from its status copy. Increased supporting typography and aligned card metrics; preserved the original logo and palette.
- Cabin presentation now follows received status: quiet monitoring, stronger warning heat, paused waiting/offline and emergency motion. Lost connections preserve cached readings and emergency treatment.
- Added chart temperature ticks and exact recorded-value/time tooltips for pointer, touch, and keyboard navigation. Selection survives polling by timestamp and clears when the reading leaves history. Added intentional empty history/activity and waiting/offline copy.
- All 271 server tests passed. Browser checks passed across desktop/tablet/mobile widths, tooltips, keyboard navigation, paused/offline recovery, empty history, emergency and reduced motion, with no browser errors. Restarted the local dashboard and isolated synthetic-data preview; calls remain disabled.

## 2026-10-11 (Eve, mobile cabin home and rotating car)

- Reworked the calm/offline Car home around a clear received-status heading and last-recorded timestamp, compact temperature/seat/reported-minutes metrics, a centered transparent rotating sedan, and latest activity linking to the existing Feed. Existing emergency actions, polling, routes, original logo, and alarm semantics retained. Unknown occupancy remains unknown.
- Added a local procedural 3D mesh projected through existing react-native-svg: full rotation, visible seats and a decorative coral rear seat, warning heat rings, and pause control. No new dependencies or remote assets. Rotation stops for reduced motion, background, offscreen home, offline, manual pause, and emergencies. This is a stylized model, not the dashboard's photographic image or a seat-localization reading.
- Added temperature axes and exact recorded-value/time chart inspection by tap, horizontal drag, and accessibility increment/decrement; the existing box-reported forecast stays distinct and is absent offline. Softened background gradient, preserved cream/brown surfaces, and added gradient active-tab accents. Existing action success notices are now live regions.
- Validation: all 40 app tests pass; Expo lint and TypeScript no-emit parsing of the JavaScript app pass; iOS and Android production bundle exports succeed. Rendered the mesh at four angles for visual review. No phone is connected to Metro and simctl is unavailable, so native touch/performance and full-screen visual checks still require a device. No commits or pushes.

## 2026-10-11 (Eve, parent-focused home and detailed rotating sedan)

- Put a plain-language next step directly below status and timestamp. Warning/lost-alert guidance and emergency phone/response actions precede the car and history. Replaced abbreviated metrics with cabin temperature, seat occupancy, and an explicit current/last-recorded heat estimate; null estimates and unknown occupancy remain unknown. History is a disclosure; navigation labels now read Home and Activity while preserving the existing sections. Larger text and touch targets, readable emergency card surfaces, unchanged logo with a cream backing during emergencies.
- Replaced the simple SVG car in the live app with a locally bundled detailed Model 3 mesh, adapted from RBLXSupercars' CC BY 4.0 asset. Attribution, original source, modifications, and license links are in app/assets/models/CREDITS.md and the illustration-info control. A reproducible importer strips textures, quantizes geometry and compresses it; the renderer provides studio lighting, translucent cabin, white bodywork, visible seats, and status-driven coral heat. Full 360-degree rotation is capped at 30fps, with pause/reduced-motion/offline/background/offscreen stops. Uses a dashboard-image fallback if the 3D view fails.
- Added Expo-compatible react-native-webview for the isolated renderer, plus three and esbuild as build-time dependencies. The generated HTML/model is entirely local, with a CSP forbidding network access. Run npm run build:car from app after renderer/asset changes. No server, sensor, alarm, or calling logic changes; API routes and data remain unchanged.
- Validation: 45 app tests pass, uncached ESLint and TypeScript no-emit JavaScript parsing pass, iOS/Android production exports succeed. Browser preview of actual React Native Web components passed 320/390/430 widths, rotation/pause/resume, offline/waiting, emergency action placement and history disclosure. Native WebView integration, touch and performance still require an attached phone; no simulator/device is connected here. No commit or push requested for this revision.

## 2026-10-11 (Eve, Live alert countdown, larger text, vibration)

- Red Live alert screen now matches the brief: the animated CountdownRing (box's `minsToDanger` as sent, "DANGER REACHED" at 0, "NO ESTIMATE" when null; the phone never counts down on its own) sits under the status, then the action buttons, then temperature/seat, and the heat curve is shown open during an emergency instead of behind the "Temperature history" disclosure. The small estimate line is hidden on red since the ring shows it.
- The phone vibrates once when it sees a live EMERGENCY start (React Native's built-in Vibration, no new dependency), and again on reconnecting or returning to the app mid-emergency. It only adds alerting.
- No app text is below 12px now; "Only the button on the box can stop the alarm" is 14px. Covers section labels, activity times, contact labels, the editor, and Insights captions and footnote.
- Cleanup: removed 18 unused App.js styles, unused StatusLabel/Halo (ui.js) and HeatTrace (HeatMotion.js), and model.js helpers no screen used (sensorReadings, emergencyCopy, lostAlarmCopy) with their three tests. The "unknown seat is not an empty seat" rule moved to `seatLabel` in home.js with its own test. New tests: countdownView, alertVibration, seatLabel.
- Validation: 45 app tests pass, uncached ESLint and TypeScript no-emit parse pass, iOS/Android exports succeed. Not rendered: react-native-web isn't installed and no phone is connected. Layout of the red screen still needs a look on the demo phone.
- Pre-demo check (server URL): the app reads `EXPO_PUBLIC_ECHO_SERVER_URL` from `app/.env` when Expo starts. On the demo hotspot: (1) on the laptop run `ipconfig getifaddr en0`; (2) if it differs from the IP in `app/.env`, edit it and restart with `npx expo start --clear`; (3) on the phone's browser open `http://<that IP>:3000/status` and confirm JSON loads before opening the app.
- Still to do on the demo phone through Expo Go: 3D car WebView loads (the still image shows until it does) and runs smoothly, chart drag works, fonts load, vibration fires on EMERGENCY, and the "I'm on my way" button is reachable without scrolling.

## 2026-10-11 (Eve, demo-only contact save for judging)

- Calls for judging stay on the two `server/.env` contacts. To still show "add a contact", `EXPO_PUBLIC_ECHO_DEMO_CONTACTS=true` in `app/.env` makes Save in Edit contacts check names and numbers as usual, hide the PIN field, send nothing to the server, and show the normal "Saved … after the Echo server restarts" message. Off by default in `app/env.example`. Test: demo save sends nothing and needs no PIN.
- After judging: set it to false (or remove it) in `app/.env` and restart Expo, so Save goes back to the real PIN-protected `POST /saved-contacts`. `ECHO_CONTACTS_PIN` is also set in `server/.env` now, so real saving works once the switch is off.

## 2026-10-11 (Eve, ladder's first call uses the ElevenLabs agent)

- Why: live calls always opened with the plain Twilio alert because ladder step 1 dials Contact #1 the moment EMERGENCY arrives, before Gemini's first turn, and only Responder calls used ElevenLabs. Eve wants the smoother agent voice first.
- Change: with all three ElevenLabs keys set, step 1's first attempt goes through `createVoiceCaller` (`attachLadder`, `firstCall` in `createLadder`). On an ElevenLabs error, missing number, or no answer within `ELEVENLABS_TIMEOUT_MS`, the same attempt places the Twilio call. Step-1 retries and steps 2-4 always use Twilio. Not live or ElevenLabs not fully set: unchanged. The action log says "as an ElevenLabs voice call" or why it fell back. 8 new tests (server-voice, ladder, voice startup); 280 server tests pass.
- Tradeoffs: worst case, Contact #1's floor call is up to the ElevenLabs timeout late; ElevenLabs accepting just after the timeout means two calls to Contact #1. The voice conversation can still be running when step 2 re-calls Contact #1 at 2 minutes. Voice tools on the ladder's call need the Responder on (Gemini key).
- If cancel or ignition ends the incident during the ElevenLabs attempt, the Twilio fallback is not dialed; the action log gets a `skip` entry (`stillNeeded` in the voice caller). 3 more tests; 283 server tests pass.
- CLAUDE.md's floor rule reworded by Eve to allow only this first call to try the voice agent. `docs/brief.md` ladder step 1 and guardrail 3 now name this one exception. Still open: the teammate's OK on both. Left as is on purpose: the demo-contacts "Saved" message (turn `EXPO_PUBLIC_ECHO_DEMO_CONTACTS` off after judging), and brief "How it works" step 4 (no fixed message if the voice agent fails mid-call; that was already true of the Responder's voice calls). Needs a live check (`ECHO_CALLS=live`, ngrok up) that the first call to Contact #1 is the agent, and one with ElevenLabs keys broken to hear the Twilio fallback.

## 2026-10-11 (Eve, Florida weather notebook for Databricks)

- New `notebooks/florida_weather.py`: pulls the last 24 h of hourly weather (°F temperature, feels-like, heat index, humidity, UV, clouds, condition) for Miami, Orlando, Tampa, Jacksonville, Tallahassee, and Fort Myers from the Google Maps Platform Weather API (`history/hours:lookup`) and MERGEs it into the Delta table `workspace.default.florida_weather_hourly` (widget), keyed by city + hour. Insights only; never feeds alerts or calls. Standard library only (urllib), no new dependencies.
- Google keeps only 24 h of history, so the notebook must run as an hourly (at least daily) Databricks Job to build a record.
- Setup still to do: enable Weather API in the Google Cloud project (billing on), make a key restricted to it, store it with `databricks secrets put-secret echo google_weather_api_key`. The key never goes in the notebook or git.
- Not yet run in Databricks or against the real API. Parse functions were checked locally against a doc-shaped sample response. Next: Run all once, schedule it, then optionally join outdoor `temp_f` into `heat_test.py` by hour for the Heat insights line.

## 2026-10-11 (Eve, Florida hot-car risk forecast)

- `notebooks/florida_weather.py` is now the Florida hot-car risk forecast. Each run: last 24 h observed weather MERGEd into `workspace.default.florida_weather_hourly` (grows over time); next 24 h Google forecast (`forecast/hours:lookup`) turned into minutes until a parked car hits 104°F, overwritten into `workspace.default.florida_heat_risk_forecast` with risk EXTREME (≤10 min) / HIGH (≤20) / ELEVATED (≤60) / WATCH / NIGHT; the worst Florida hour exported as insights.json (`export_path` widget, default `/Volumes/workspace/default/echo_logs/florida_insights.json`). Two API requests per city per run.
- Cabin curve: Jan Null's SJSU table from McLaren, Null & Quinn, Pediatrics 2005;116:e109 (dark sedan, full sun, 16 clear days at 72–96°F): +19°F at 10 min, +29 at 20, +34 at 30, +38 at 40, +41 at 50, +43 at 60, interpolated. Night hours get no estimate; a missing `isDaytime` counts as daytime. Assumes full sun, so cloudy hours read high (the safe direction).
- App: `insights.js` accepts `source: "databricks forecast"` with a required `place` (≤40 chars); it can never be `real`. The screen says "On a 91°F afternoon in Orlando, FL, a parked car hits danger in 7 minutes.", keeps "(not from a real heat test)", and adds "Never leave a child in the car, even for a minute. Echo's box watches the seat itself; this forecast never changes an alert." `HeatInsights.js` now takes its explanation and footnote from the view. 3 new app tests; 49 app tests pass. The notebook's curve, risk, and export functions were checked locally, and its export passes the app's `validInsights`.
- `app/assets/insights.json` holds David's first real heat-test export (hair-dryer run, "0 minutes"). Whether the forecast replaces it is David's call: after the first Databricks run, paste the printed forecast JSON there if so.
- Still to do: API key + Databricks secret (see the entry above), re-import the notebook, Run all, schedule hourly, paste insights.json, and check the Insights tab in Expo Go.

## 2026-10-11 (David, seat dwell removed, cancel grace added)

- Decision (David): the 30 s seat dwell is gone. ARMED goes to OCCUPANT on the first step the seat detector reads occupied; the detector's three-readings-in-a-row rule (about 6 s) is the only filter. `OCCUPANT_AFTER_MS` and the dwell timer state were removed from `firmware/mega/logic.h`.
- Decision (David): after cancel, a 10 s grace (`CANCEL_GRACE_MS`). ARMED while cancel is held and for 10 s after the last held step, even with the seat occupied; then an occupied seat re-alarms (OCCUPANT, and WARNING/EMERGENCY in the same step if the heat calls for it). A new press restarts it; ignition ends it. Without it, a released cancel re-alarmed on the next loop pass. Written in `docs/firmware.md` "Leaving a level".
- Consequence for the server: a re-alarm after the grace is a new incident, so the backup ladder starts over and calls Contact #1 again.
- More OCCUPANT false positives are possible now that no dwell backs up the seat filter: a few close readings (bag, hand, fabric) are enough. The brief's "False alarms" test matters more; the "Alert speed: under 45 s" target is now loose and is a team call.
- Challenger seeds changed, still PENDING David's review: "occupied 28 s, under the dwell" (ARMED) became "occupied only in the last period" (OCCUPANT, new presence data); "occupied exactly 30 s after empty start" renamed "occupied after an empty start"; "brief seat blip restarts the dwell" (ARMED) became "brief seat blip after occupant" (OCCUPANT); "already hot when the dwell ends" renamed "already hot when the seat fills" (still WARNING). `simulator/challenger/example.jsonl` line 3 renamed "example: occupied from the first period".
- Recording `synthetic-ignition-off-to-emergency.jsonl`: status lines 70-84 (15) changed `state` ARMED to OCCUPANT; no other field changed. Header comment reworded.
- Bench check (re-flash the Mega first): on the AA pack, pull the ignition, put a hand within 40 cm: "Seat occupied: yes" then OCCUPANT right away. Press and release cancel with the hand still there: ARMED for 10 s, then OCCUPANT again.

## 2026-10-11 (David, live Insights from Databricks; Orlando)

- Live path: Databricks job "Echo: Florida hot-car forecast (hourly)" (job 320426281873606, created via the Databricks CLI; runs florida_weather at :05 every hour, America/New_York, Serverless) writes /Volumes/workspace/default/echo_logs/florida_insights.json. The laptop server downloads it every 5 min (DATABRICKS_HOST/TOKEN in server/.env; optional ECHO_INSIGHTS_PATH, ECHO_INSIGHTS_REFRESH_MIN) and serves GET /insights. The app polls it and falls back to the bundled app/assets/insights.json. Startup shows "insights: on (Databricks, every 5 min)". The smoke check and server startup tests blank the Databricks keys, so no check ever reaches Databricks.
- florida_weather.py has a new `app_city` widget (default "Orlando"): the app's forecast is that city's worst upcoming hour, falling back to the statewide worst if the city has none. Empty means statewide. The notebook was re-imported into the workspace with the CLI.
- Forecasts no longer show "(not from a real heat test)": they are real weather data and already say FORECAST. The label stays on the design example and on heat-test predictions that aren't from real runs. Two of Eve's app tests were updated to match.
- Databricks CLI v1.20.0 is installed at /usr/local/bin from the official GitHub release (Homebrew refused the databricks tap without a trust override). The `echo` secret scope holds google_weather_api_key.
- Restart the server after pulling server changes: a running server keeps old code (that is what caused the "400" box rejections earlier today).
