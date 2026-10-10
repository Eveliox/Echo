# Echo

Hackathon project: a car-seat heat alarm box (Arduino Mega + ESP8266) plus a laptop server, call agent, Expo app, and Databricks notebook.

## Sources of truth

- `docs/brief.md`: the team plan (scope, guardrails, timeline, demo script).
- `docs/firmware.md`: everything on the box (parts, pins, thresholds, alert levels, status JSON). It wins over the brief on hardware.
- `docs/notes.md`: session continuity. Append a dated entry; never rewrite old ones.
- `docs/backlog.md`: tickets and their GitHub issue numbers.

Read thresholds, pins, and formats from these docs. Don't copy them into code comments, skills, or agents.

## Code principles

- Do the smallest change that moves the demo forward. Leave stretch goals alone until the slice works end to end.
- New behavior gets a test or a Checks row. Never weaken or delete a test to make it pass.
- The Mega decides and alarms; the ESP8266 only forwards lines. The box never waits on the network.
- Sensors are the truth. Server and agent code read `tempF` and `minsToDanger` from the box and never compute their own.
- Plain code guarantees the floor. The backup call ladder runs without the AI; the AI may act earlier, never later.
- Real phone calls only happen when `ECHO_CALLS=live` is set. Any other value means no calls are dialed.
- Secrets never go in git: Wi-Fi credentials, Twilio and Gemini keys load from a local file kept out of git.
- No new dependencies without saying why.

## Hardware rules for code

- Never use `analogWrite` on pins 9 or 10. `tone()` uses their timer.
- `firmware/mega/logic.h` is plain C++: no `Arduino.h`, no STL, only `<stdint.h>` and `<math.h>`. It must compile both with avr-gcc and with the laptop's g++.
- The status JSON format in `docs/firmware.md` is fixed. Don't add, rename, remove, or retype a field without both teammates' OK; a field marked pending there is not approved yet.
- Nothing received over Wi-Fi (ESP, server, app, agent) may silence or lower an alarm. Only the physical cancel button and the ignition clear one.
- `SIMULATE_TEMP` is test-only. The demo build must have it off.
- The hardware stack in `docs/firmware.md` is final. Part or pin changes need the whole team.
- Never upload to a board: no `arduino-cli upload`, no `--upload`/`-u` on `compile`, no `avrdude` or `esptool`. Compiling is fine.

## Safety-critical paths

Changes here get a second read-only review in `implement-ticket`:

- `firmware/mega/` (alert levels, alarms, minutes-to-danger)
- `server/`, all of it for now, since the backup ladder and call code live there (narrow this to exact paths once they exist)

## Checks

The single source of truth for build, test, lint, and smoke. Skills and agents run these commands from the repo root and never hardcode their own.

| Check | Command | Notes |
| --- | --- | --- |
| firmware-mega | `arduino-cli compile --fqbn arduino:avr:mega firmware/mega` | |
| firmware-esp | `arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 firmware/esp` | |
| logic-test | `g++ -std=c++17 -Wall -Wextra -Werror -I firmware/mega firmware/mega/test/logic_test.cpp -o "${TMPDIR:-/tmp}/echo_logic_test" && "${TMPDIR:-/tmp}/echo_logic_test"` | arduino-cli only compiles the sketch root and `src/`, so `test/` is ignored by the firmware build. The binary goes to a temp folder, never the repo |
| server | `node --test "server/test/*.test.js"` | Node built-ins only, no npm install. Tests use a random port, never 3000 |
| app | TODO | |
| lint | TODO | |
| smoke | TODO | Must replay a recording through the server end to end with `ECHO_CALLS=off` set in the command, and exit non-zero on failure. Never places real calls |

Reading the table:

- Exit code 0 is a pass. A `TODO` row is reported as SKIPPED, never as a pass.
- `smoke` starts processes; run it only where a skill or agent says to.
- Editing this table to make a check pass counts as test tampering.

## Demo readiness

Checked by `test-gate full`:

- Every non-TODO check passes, and `smoke` is not TODO.
- `SIMULATE_TEMP` is off in `firmware/mega/`.
- No secrets in tracked files.

## Workflow rules

- Never commit or push unless Eve explicitly asks. `/ship` is the only exception, and only after an explicit yes.
- Never force-push.
- Anything the next session needs goes in `docs/notes.md`. Don't create scattered new files.
