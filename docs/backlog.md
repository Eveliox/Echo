# Backlog

## Slice: ignition off → seat occupied → alert → server → test call

### 1. server: accept box status on POST /status and track online/offline
Owner: sw · Size: M · Depends on: none · Issue: #1
- [ ] `POST /status` on port 3000 accepts the status JSON from `docs/firmware.md` "Data format and Wi-Fi" and keeps the latest one
- [ ] A body that isn't valid status JSON is rejected with a 4xx and doesn't replace the latest status
- [ ] The box is reported offline after the silence window in "Data format and Wi-Fi", and online again on the next message
- [ ] The `server` row in `CLAUDE.md` Checks is filled in and runs these tests
Proven by: server


### 2. mega: alert levels in logic.h with laptop tests
Owner: hw · Size: M · Depends on: none · Issue: #2
- [ ] `firmware/mega/logic.h` steps IDLE → ARMED → OCCUPANT → WARNING → EMERGENCY per the level table in "Firmware behavior", using temperature thresholds only (minutes-to-danger comes later)
- [ ] Levels only climb on their own: a falling temperature or an empty seat never lowers WARNING or EMERGENCY
- [ ] Only cancel (→ ARMED) and ignition on (→ IDLE) clear a level; tests cover both
- [ ] `logic.h` follows the plain-C++ rule in `CLAUDE.md` and is included by the Mega sketch
Proven by: logic-test, firmware-mega


### 3. mega: seat-occupied detection in logic.h with laptop tests
Owner: hw · Size: S · Depends on: none · Issue: #3
- [ ] Baseline, median-of-pings, distance drop, and readings-in-a-row rules match "Seat detection" in "Firmware behavior"
- [ ] Tests cover: empty seat stays empty, one noisy ping doesn't flip it, a sustained drop does
Proven by: logic-test


### 4. mega: read sensors, run the logic, send the status line every 2 s
Owner: hw · Size: M · Depends on: 2, 3 · Issue: #4
- [ ] The sketch reads the ignition, cancel, ultrasonic, LM35 (with the `SIMULATE_TEMP` joystick path), and DHT11 on the pins in "Mega pin map"
- [ ] Every 2 s it prints one status line to Serial and Serial1, in the format from "Data format and Wi-Fi" (`light` left out while it's pending; `motion`, `battery`, and `minsToDanger` sent as `null` for now)
- [ ] Manual: someone sits on the seat, the ignition jumper is pulled, and the Serial Monitor shows OCCUPANT within the brief's alert-speed target
Proven by: firmware-mega, logic-test, manual hardware check


### 5. esp: forward the Mega's lines to the server
Owner: hw · Size: S · Depends on: 1 · Issue: #5
- [ ] Wi-Fi name, password, and server URL load from `firmware/esp/secrets.h` (gitignored); a `secrets.example.h` with placeholders is committed
- [ ] Lines that don't start with `{` are dropped (see the gotchas in "Mega to ESP8266 link")
- [ ] Manual: with the Mega connected, the server receives a status every 2 s over the hotspot
Proven by: firmware-esp, manual hardware check


### 6. server: backup ladder step 1, call Contact #1 when EMERGENCY starts
Owner: sw · Size: M · Depends on: 1 · Issue: #6
- [ ] The first EMERGENCY status of an incident places exactly one call to Contact #1 (brief, "Backup ladder" step 1); repeated EMERGENCY statuses don't place more calls. Plain code, no AI
- [ ] No call is dialed unless `ECHO_CALLS=live`; a test shows that with it unset or `off` the call is only logged
- [ ] Twilio credentials and contact numbers load from `.env`
- [ ] Manual: with `ECHO_CALLS=live`, a verified phone rings. Note whether the trial account plays a "press any key" prompt first
Proven by: server, manual check (live call)


### 7. sim: replay a recording through the server and fill the smoke check
Owner: hw · Size: M · Depends on: 1, 6 · Issue: #7
- [ ] A replay tool POSTs a recorded status file to the server at the box's pace, with a faster option for tests
- [ ] A recording that runs ignition off → OCCUPANT → EMERGENCY is committed
- [ ] The `smoke` row in `CLAUDE.md` Checks replays it with `ECHO_CALLS=off`, and fails unless the server logs exactly one ladder call
Proven by: smoke


### 8. mega: local alarm with RGB LED, buzzer, and LCD per level
Owner: hw · Size: M · Depends on: 4 · Issue: #8
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
