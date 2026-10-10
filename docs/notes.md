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
