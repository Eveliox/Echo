# Echo — Team Brief

Oct 9, 2026 · PM: Eve · Team of 2 · Hackathon ends Sunday Oct 11, 10 AM (submit by 9 AM)

Hardware details (parts, pins, wiring, power, firmware behavior) live in `firmware.md`, which is the source of truth for anything on the box.

## Overview

Echo is a roughly $40 dashboard box that detects an occupied seat in a parked car, measures how fast the cabin is heating up, and sounds alarms before it becomes deadly. An AI dispatcher then works the phones to get the right person to the car in time.

**Tagline:** *The box detects. The agent dispatches. Code guarantees the floor.*

**Pitch line on detection:** *"The demo detects an occupied seat; production adds mmWave radar for breathing."*

**Why this wins:** the ShellHacks 2026 winners we studied (Pointr, Repro, Halo) all kept AI on a leash, showed real measured numbers, and had demos that could not fail. This plan is built around those three things.

**Analogy:** a building fire alarm. The alarm goes off no matter what (the box). A dispatcher then calls the right people (the Responder agent). Before the building opens, an inspector tries to break the system (the Challenger agent).

## Target tracks

| Track | How we hit it |
| --- | --- |
| Encompass: Data Capturing Hardware | The box captures seat presence, cabin heat, humidity, sunlight, and motion every 2 s and turns them into a life-saving alert |
| Databricks: Best Use of Databricks | Log every heat test; predict minutes-to-danger from temperature, humidity, sunlight, and time of day; feed predictions into the app's Heat insights screen |
| Figma: Best Design | Clear, accessible app flow for a panicked parent: big status, one-tap actions, plain words |
| Adobe: Prettiest Hack | Cohesive visual style across the app, dashboard, and box; animated heat curve and countdown |

## How it works

1. **The box (Arduino Mega 2560):** reads the seat (ultrasonic), cabin heat (LM35), humidity (DHT11), sunlight (photoresistor), and optional motion (PIR); sets the alert level; alarms locally with an RGB LED, a passive-buzzer siren, and a 1602 LCD. It never needs the internet.
2. **Wi-Fi modem (ESP8266 NodeMCU):** forwards the Mega's JSON status line every 2 s to the laptop server over a 2.4 GHz phone hotspot. Pulling it out does not stop the alarm.
3. **Server (laptop):** listens on port 3000 at `POST /status`; shows the live dashboard; marks the box offline after 10 s of silence; runs the plain-code backup call ladder.
4. **Responder agent (Gemini + Twilio voice):** takes over contacting people at Emergency.
5. **Challenger agent (development only):** invents tricky scenarios and runs them through the simulator; plain code grades the results.

**Alert levels:** `IDLE` → `ARMED` → `OCCUPANT` → `WARNING` → `EMERGENCY`. Levels only climb on their own. Only the physical cancel button or the ignition clears an alarm.

**Thresholds (real hot-car values, LM35):** WARNING at 95°F (35°C) or 10 min or less to danger; EMERGENCY at 104°F (40°C) or 5 min or less. A hair dryer reaches them in under a minute. For testing, a joystick simulates the cabin heating (`SIMULATE_TEMP`); the LCD shows SIM so test runs are never mistaken for real readings.

**Backup ladder (plain code, runs no matter what):**

1. Emergency starts → call Contact #1
2. +2 min with no answer → call Contact #1 again
3. +3 min → call Contact #2
4. +5 min → alert everyone on the list

**Minutes to danger:** the Mega fits a straight line through the last 2 minutes of temperature readings and computes `(104 − current °F) ÷ warming rate`. Null if the cabin isn't warming; 0 if already at 104°F. Always from real readings, never from AI.

## Guardrails

1. **The box never waits on AI or internet.** The siren works with Wi-Fi unplugged.
2. **The Responder can only escalate, never de-escalate.** It cannot silence the siren or cancel the alert. Only a person at the car pressing the button can; the app's "I'm on my way" never silences it.
3. **The backup ladder is the floor.** The agent may act sooner than the schedule, never later. If it crashes or stalls, the ladder still runs.
4. **Sensors are the truth.** Agents read temperature and time-to-danger from the data and never estimate their own.
5. **The Challenger invents tests, but code grades them.** No AI decides whether the system passed.
6. **Everything is logged.** Every agent action and its reason appears in the dashboard and app feed.

## The calling agent (Responder)

When the box hits Emergency, the agent phones the parent, talks with them live, and decides who to call next. The phone call is the alarm; the app is the control center.

**Example call**

> **Agent:** "This is Echo. Someone is still inside your silver Civic. It's 104 degrees and rising, dangerous in about 6 minutes. Are you on your way?"
>
> **Parent:** "I'm like 20 minutes away."
>
> **Agent:** "That's too long. I'm calling Alex now, who's closer. If you can't get there, call 911."

**How it works**

1. The server asks Twilio to place the call.
2. A voice layer (Twilio ConversationRelay or ElevenLabs voice agents) turns speech into text and back.
3. Gemini gets the parent's words plus live car data and picks one tool.
4. If the AI fails mid-call, Twilio plays a fixed recorded message, and the backup ladder keeps calling on schedule.

**Tools:** `get_car_status()`, `place_call(contact, message)`, `send_message(contact, message)`, `log_action(note)`.

**Why calls, not texts:** US carriers block texts from unregistered numbers, and registration takes weeks. Voice is the main channel; written messages go through a Telegram bot or app push notifications. A call from a saved emergency contact can also break through Do Not Disturb.

## The mobile app (Expo React Native)

| Screen | What it shows |
| --- | --- |
| Home | The car's card: temperature, seat occupied, alert level, battery |
| Live alert | Full red screen: minutes-to-danger countdown, heat curve, "I'm on my way" and "Call 911" |
| Agent feed | What the agent is doing now, e.g. "Called Mom, no answer. Calling Alex." |
| Contacts | Who gets called, in what order |
| History | Past incidents and test runs, each with its heat curve |
| Heat insights | Databricks predictions, e.g. "On a 92°F afternoon, your car hits danger in 14 minutes" |

Design rules: one action per screen, big text, plain words, works one-handed. The app and dashboard read the same live data.

## Shared data formats

Change these only with both teammates' agreement.

**Box → server** (every 2 s; doubles as the heartbeat). `light` is pending both teammates' OK; `motion` is `null` if the PIR is unplugged:

```json
{ "state": "WARNING", "tempF": 96.4, "humidity": 41, "light": 812, "presence": true, "distanceCm": 38, "motion": false, "minsToDanger": 7.5, "battery": 88 }
```

**Challenger scenario:**

```json
{ "name": "bag on the seat", "presence": [...], "tempF": [...], "expected": "OCCUPANT" }
```

**Agent action log:**

```json
{ "time": "...", "action": "call", "to": "Alex", "reason": "Parent 20 min away, danger in 6 min" }
```

## Team and repo

| Role | Owns |
| --- | --- |
| Hardware + data | Mega and ESP8266 firmware, wiring, `logic.h` tests, recordings, simulator, Databricks |
| Software + design (Eve, PM/infra) | Server, dashboard, backup ladder, Responder agent, Expo app, Figma, pitch, Devpost |

**Repo layout:** `firmware/mega/`, `firmware/esp/`, `server/`, `app/`, `simulator/`, `notebooks/`, `docs/`.

**Testable logic:** alert levels and minutes-to-danger math live in `firmware/mega/logic.h` so they run in laptop unit tests.

**Accounts:** Twilio (verify every phone used in the demo), Gemini API key with a spending cap, Telegram bot, Databricks, Figma, Expo Go, ngrok (only for Twilio reaching the server).

## Timeline (hour 0 = Fri 10 PM)

| Hours | Clock time | Goal |
| --- | --- | --- |
| 0–3 | Fri 10 PM – 1 AM | Box wired, live data flowing, simulator replaying recordings |
| 3–10 | Sat 1 AM – 8 AM | Alert levels on the box, dashboard live, first test call |
| 10–16 | Sat 8 AM – 2 PM | Time to danger, battery fail-safe, Challenger running, Databricks notebook |
| **16** | **Sat 2 PM** | **Checkpoint: full demo works end to end** |
| 16–24 | Sat 2 PM – 10 PM | Calling agent, Expo app, fixes from the Challenger |
| 24–28 | Sat 10 PM – Sun 2 AM | Test trials and numbers, enclosure, prop car |
| 28–30 | Sun 2 AM – 4 AM | Polish app and dashboard, record backup video |
| 30–34 | Sun 4 AM – 8 AM | Devpost write-up, rehearse the pitch 3 times |
| 34–36 | Sun 8 AM – 10 AM | Buffer; submit by 9 AM |

If the demo doesn't work end to end by the checkpoint, the agents and the app become stretch goals. With two people, the Expo app and the Challenger come after the checkpoint.

**First vertical slice:** ignition off → seat occupied → alert → server → test call.

## Testing: numbers for the pitch

| Test | How | Target |
| --- | --- | --- |
| Detection | Person sitting still on the seat, 20 trials | 20/20 detected |
| False alarms | Empty seat with a fan or moving fabric, 60 trials | 0 false alerts |
| Alert speed | Seconds from ignition off to OCCUPANT | Under 45 s |
| Prediction | Predicted vs. actual minutes to danger | Within 1 min |
| Challenger coverage | Scenarios generated and run | 200+ |
| Responder judgment | Scripted replies, right next action | 10/10 |
| Backup ladder | Kill the agent mid-emergency | Ladder still calls on schedule |
| Call reliability | 10 test calls, AI off for 3 | 10/10 connect; fallback plays |
| Bag vs. person | 20 trials each | Honest result: both read as occupied |

## Demo script (2–3 minutes)

1. Stat + problem, one slide.
2. Pull the ignition jumper and walk away with someone on the seat. The box chirps: occupant detected.
3. Hair dryer on the LM35. The heat curve climbs, minutes-to-danger counts down, the LED turns red, and the siren sweeps.
4. A judge's phone rings and the agent speaks. The judge answers "I'm 20 minutes away."
5. The agent explains and calls a teammate; the app's agent feed shows why.
6. Pull out the ESP8266. The box keeps alarming. "The box detects. The agent dispatches. Code guarantees the floor."
7. Show the Challenger's results.
8. Close with the test numbers.

## Stretch goals

- GPS location in calls and messages
- Incident Reporter agent: a post-event timeline for the family
- Production version with mmWave radar, a BME280, and an LTE module
