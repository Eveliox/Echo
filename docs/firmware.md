# Echo — Firmware Handover

Oct 9, 2026 · Source of truth for the box's hardware and firmware.

## Summary

The box is an Arduino Mega 2560 plus one ESP8266 NodeMCU; the Raspberry Pi, PiJuice, and servo stay in the bag. **This stack is final as of 11 PM Friday:** build with it, and agree any change with the whole team first.

- **No Raspberry Pi.** The laptop runs the server, so the Pi's setup time buys nothing in the demo.
- **No breathing detection.** The ultrasonic sensor faces the baby seat; a shorter distance means the seat is occupied. Pitch: *"The demo detects an occupied seat; production adds mmWave radar for breathing."*
- **PIR is optional.** It backs up the ultrasonic but never replaces it, because it can miss a sleeping child. It is the first part to cut if time runs short.
- **LM35 for temperature; no humidity.** The LM35 reads up to 150°C and reacts instantly, so the box uses real hot-car thresholds. The DHT11 was removed; the box tracks temperature only.
- **Joystick simulates temperature for testing.** It walks the box through every alert level in about a minute; the demo itself uses the real LM35 and a hair dryer.
- **Photoresistor** logs whether the car sits in direct sun, an input for the Databricks model.
- **ESP8266 is the Wi-Fi modem.** The Mega decides and alarms; the ESP only forwards its messages.
- **1602 LCD** so judges can read the state and countdown on the box.
- **Passive buzzer** so the siren can sweep up and down.
- **One RGB LED** replaces three single LEDs; it changes color with the alert level.

## Parts

| Part | Qty | Job |
| --- | --- | --- |
| Arduino Mega 2560 | 1 | The box: sensors, alert levels, LED, buzzer, LCD. Alarms with no internet |
| ESP8266 NodeMCU | 2 | #1 forwards the Mega's JSON to the server; #2 is the spare |
| HC-SR04 ultrasonic | 1 | Aimed at the baby seat; detects someone in it by distance, awake or asleep |
| LM35 temperature sensor | 1 | Cabin temperature for the alert levels and minutes to danger |
| Photoresistor + 10kΩ | 1 | Light level: is the car in direct sun? |
| PIR motion sensor (optional) | 1 | Movement; raises confidence that the seat holds a person, not a bag |
| Joystick module | 1 | Testing only: simulates the cabin heating or cooling |
| Passive buzzer | 1 | Siren and chirps |
| RGB LED + three 220Ω | 1 | Alert level by color |
| 1602 LCD + 10kΩ potentiometer | 1 | Shows level, temperature, minutes to danger |
| Jumper wire (ignition), large push button (cancel) | 1 each | Car on/off; person at the car silences the alarm |
| 6-cell AA battery pack (9V) | 1 | Runs the box with the laptop unplugged |
| Laptop | 1 | Server, dashboard, Twilio calls |
| Phone hotspot | 1 | Wi-Fi for the ESP8266 |

Left in the kit: servo, stepper, relay, RFID, gas sensor, accelerometer, clock module, 7-segment and matrix displays. None of them makes the demo stronger in 36 hours.

## How it fits together

The Mega is the box and the ESP8266 is only its Wi-Fi modem, so the siren never depends on the internet.

![Architecture: the Mega alarms on its own; Wi-Fi only carries the news out](architecture.png)

Everything in the shaded "in the car" zone keeps working with the ESP8266 pulled out; only the calls and app alerts need the hotspot.

## Mega pin map

Run the Mega's 5V to the breadboard's red (+) rail and GND to the blue (−) rail once; every part takes power from those rails. Everything runs at 5V; only the link to the ESP8266 needs its signal stepped down to 3.3V.

| Part | Power | Signal pin(s) | Notes |
| --- | --- | --- | --- |
| (free) | — | D2 | Unused (the DHT11 was removed) |
| PIR motion sensor (optional) | VCC → + rail, GND → − rail | OUT → D3 | Settles about 60 s after power-up. Unplugged, the firmware sends `motion: null` |
| Ignition jumper | — | D4 ↔ − rail | Plugged in = car on; pulled out = car off. Built-in pull-up |
| Cancel button (large) | — | D5 ↔ − rail | Across the breadboard's middle gap. Built-in pull-up |
| HC-SR04 ultrasonic | VCC → + rail, GND → − rail | Echo → D6, Trig → D7 | Aim straight at the seat, not at a steep angle |
| Passive buzzer | − → − rail | + → D8 | Driven with `tone()` for the siren sweep |
| 1602 LCD | See LCD wiring | D22–D27 | Six data pins on the Mega's double header |
| ESP8266 link | See Mega to ESP8266 link | TX1 = pin 18, RX1 = pin 19 | Serial1; USB Serial stays free for the Serial Monitor |
| RGB LED | Longest leg → − rail (→ + rail if common anode) | Red → D44, Green → D45, Blue → D46, each through 220Ω | See RGB LED note |
| Battery reading | — | A0 | See Power |
| LM35 | Left leg → + rail, right leg → − rail (flat side facing you) | Middle leg → A1 | Main temperature. Check the print says LM35; wired backwards it gets hot fast |
| Photoresistor | One leg → + rail | Other leg → A2, and A2 → 10kΩ → − rail | Higher reading = brighter light |
| Joystick (testing) | GND → − rail, +5V → + rail | VRx → A3 | VRy and SW not connected |

**RGB LED note.** Find the type first: put the longest leg on the − rail and touch another leg, through a 220Ω resistor, to 5V. If it lights, it is common cathode (HIGH = on); if not, it is common anode (long leg to + rail, and each color value becomes 255 minus the value). It sits on pins 44–46 because `tone()` borrows the timer behind pins 9 and 10, and mixing yellow needs `analogWrite` while the siren plays.

**Gotcha:** some breadboards split their power rails in the middle. If a part at the far end gets no power, add a short jumper across the gap.

## LCD wiring

4-bit mode: six signal wires plus a potentiometer for contrast. Pins numbered 1–16 from the left, screen facing you.

| LCD pin | Label | Connects to |
| --- | --- | --- |
| 1 | VSS | − rail |
| 2 | VDD | + rail |
| 3 | V0 (contrast) | Middle leg of the 10kΩ potentiometer; outer legs to + and − rails |
| 4 | RS | D22 |
| 5 | RW | − rail (write only) |
| 6 | E | D23 |
| 7–10 | D0–D3 | Not connected |
| 11 | D4 | D24 |
| 12 | D5 | D25 |
| 13 | D6 | D26 |
| 14 | D7 | D27 |
| 15 | A (backlight +) | + rail through 220Ω |
| 16 | K (backlight −) | − rail |

Code: `LiquidCrystal lcd(22, 23, 24, 25, 26, 27);` (built-in library). If the screen lights up but shows nothing or solid blocks, turn the potentiometer slowly; contrast is the cause almost every time.

If the LCD has an I2C board on the back (GND, VCC, SDA, SCL), ignore the table: SDA → pin 20, SCL → pin 21, and use the LiquidCrystal_I2C library.

## Mega to ESP8266 link

The Mega sends one JSON line every 2 seconds on Serial1; the ESP8266 reads each line and posts it to the server. The ESP runs on 3.3V, so the Mega's 5V transmit line goes through a voltage divider. Both sides use 115200 baud.

| Mega | ESP8266 NodeMCU | Notes |
| --- | --- | --- |
| TX1 (pin 18) | RX | Through a divider: pin 18 → 1kΩ → ESP RX, and ESP RX → two 1kΩ in series → − rail (the kit has no 2kΩ) |
| RX1 (pin 19) | TX | Direct wire. Optional; only for Wi-Fi status back |
| GND | G | Required; without a shared ground the data is garbage |
| 5V | VIN | Powers the ESP from the Mega, or use the ESP's own USB instead |

**Gotchas:**

1. Unplug the wire on the ESP's RX pin before uploading code to the ESP. The USB upload uses the same pin.
2. Don't power the ESP from the Mega's 5V and laptop USB at the same time. Pick one.
3. The ESP prints boot noise on its TX at power-up. The Mega ignores any line that doesn't start with `{`.
4. Pulling the ESP out is part of the demo. The Mega keeps alarming without it.

## Power

| Mode | Mega power | ESP8266 power |
| --- | --- | --- |
| Building and testing | Laptop USB | Its own USB cable (for uploads and logs) |
| Demo | Battery pack → Mega barrel jack (7–12V) | Mega 5V → ESP VIN |

- If USB and the battery pack are both plugged in, the Mega picks the right source on its own.
- The 6-cell AA pack (9V) runs the box for several hours with the LCD and Wi-Fi on. Put fresh batteries in before the demo.
- The Mega's regulator gets warm feeding the ESP. That's fine for a demo; if it gets too hot to touch, power the ESP from a USB power bank.
- Battery reading: the Mega's VIN pin (not the pack's + or the barrel jack) → 10kΩ → A0 → 10kΩ → − rail. This halves the voltage so A0 reads it safely (batteries up to 10V). Without it, the firmware sends `battery: null`.
- Battery level (pending Eve's OK): measured at the pack's terminals, 7.0 V = 0 % (empty) and 9.0 V = 100 % (full), linear between, clamped to 0–100. VIN sits after the Mega's reverse-polarity diode, so it reads about 0.7 V below the pack; the firmware adds that drop back. Below 5.5 V at the pack (e.g. on laptop USB with no pack) the firmware sends `battery: null`, not 0. The reading assumes the Mega's 5 V rail holds; near empty the rail sags and the percentage reads a little high.

## Firmware behavior

The Mega makes every decision: it reads the sensors every 2 seconds, sets the alert level, drives the LED, buzzer, and LCD, then sends the JSON line. Temperature comes from the LM35, so the thresholds are real hot-car values; a hair dryer still reaches them in under a minute. Keep thresholds as named constants at the top of the sketch.

The alert-level logic and minutes-to-danger math live in `firmware/mega/logic.h`, separate from the hardware code, so they can be unit-tested on the laptop with g++.

| Level | Enters when | RGB LED | Buzzer | LCD line 2 |
| --- | --- | --- | --- | --- |
| IDLE | Ignition jumper plugged in | Blue solid | Silent | CAR ON |
| ARMED | Ignition pulled out | Blue blinking | Silent | SEAT EMPTY |
| OCCUPANT | Armed and seat occupied for 30 s | Yellow blinking | Short chirp every 5 s | SEAT OCCUPIED |
| WARNING | Occupant and 95°F (35°C) or more, or 10 min or less to danger | Yellow solid | Beep every second | DANGER IN 7.5m |
| EMERGENCY | Occupant and 104°F (40°C) or more, or 5 min or less to danger | Red flashing | Siren sweep 600–1200 Hz | DANGER IN 2.1m |

Colors as `analogWrite` values (R, G, B): blue (0, 0, 255), yellow (255, 120, 0), red (255, 0, 0). Lower the green if yellow looks greenish.

LCD line 1 always shows the level and temperature, e.g. `WARNING  96.4F`.

**Leaving a level:**

- Levels only climb on their own. Once WARNING or EMERGENCY starts, it stays even if the temperature drops or the seat reads empty.
- Only the cancel button or the ignition clears an alarm. Cancel returns to ARMED; plugging the ignition back in returns to IDLE. Nothing sent over Wi-Fi can silence it.

**Seat detection:** at power-up, with the seat empty, the Mega measures the seat distance 20 times and stores the average as the baseline. The seat counts as occupied when the median of 5 pings is 40 cm or less, or at least 10 cm shorter than the baseline, three readings in a row. The 40 cm rule works even when the baseline is missing or was taken with something near the sensor, so mount the sensor where the empty seat reads more than 40 cm; otherwise the seat reads occupied all the time. The PIR reports movement separately; it does not change the level by itself, and the box works the same with it unplugged.

**Minutes to danger:** the Mega keeps the last 2 minutes of LM35 readings (60 samples) and fits a straight line to get the warming rate in °F per minute:

`minutes to danger = (104 − current °F) ÷ warming rate`

If the rate is below 0.05°F per minute, the value is `null`. If the cabin is already at 104°F or above, it is `0`. It always comes from real readings, never from AI.

**Temperature simulation (testing only).** With `SIMULATE_TEMP = true`, the joystick replaces the LM35: push right and the cabin warms at up to 0.5°F per second (80°F to 104°F in about 48 seconds), let go and it holds, pull left and it cools. The LCD shows SIM in this mode so a test run is never mistaken for real readings. **Set it to false before the demo.**

```cpp
const bool SIMULATE_TEMP = true;   // false for the demo
const int LM35_PIN = A1, JOY_X_PIN = A3;
float simTempF = 80.0;
unsigned long lastSimUpdate = 0;   // set to millis() in setup()

float readLM35F() {
  long total = 0;
  for (int i = 0; i < 10; i++) { total += analogRead(LM35_PIN); delay(2); }
  float tempC = (total / 10.0) * 5.0 / 1023.0 * 100.0;  // 10 mV per degree C
  return tempC * 9.0 / 5.0 + 32.0;
}

float readSimulatedF() {
  unsigned long now = millis();
  float seconds = (now - lastSimUpdate) / 1000.0;
  lastSimUpdate = now;
  int offset = analogRead(JOY_X_PIN) - 512;
  if (abs(offset) < 50) offset = 0;              // dead zone: let go = hold
  simTempF += (offset / 512.0) * 0.5 * seconds;  // full push = 0.5 F per second
  simTempF = constrain(simTempF, 60.0, 140.0);
  return simTempF;
}

float readTempF() { return SIMULATE_TEMP ? readSimulatedF() : readLM35F(); }
```

## Data format and Wi-Fi

The Mega sends the status message every 2 seconds; each message doubles as the heartbeat, so the server marks the box offline after 10 seconds of silence.

```json
{ "state": "WARNING", "tempF": 96.4, "light": 812, "presence": true, "distanceCm": 38, "motion": false, "minsToDanger": 7.5, "battery": 88 }
```

`distanceCm` and `motion` are approved by both teammates. `humidity` was removed with the DHT11 (both teammates agreed); the server ignores it if a box on older firmware still sends it. `light` (photoresistor reading, 0–1023) is new and needs both teammates' OK before it ships. `motion` is `null` when the PIR is unplugged; `battery` is `null` without the A0 divider or with no pack connected.

**Wi-Fi setup for the demo:**

1. One teammate's phone runs a hotspot; the laptop joins it too.
2. The hotspot must be 2.4 GHz; the ESP8266 can't see 5 GHz. On iPhone, turn on Maximize Compatibility.
3. The ESP8266 sends an HTTP POST to the laptop's address on the hotspot, e.g. `http://172.20.10.2:3000/status`. Find it with `ipconfig` (Windows) or `ifconfig` (Mac); it can change when the hotspot restarts.
4. No ngrok for the box; ngrok is only for Twilio reaching the server during calls.

Pitch line for the Wi-Fi question: the demo uses a hotspot; production carries its own LTE module, so it never depends on the parent's phone or Wi-Fi.

## Setup and build order

**Software**

- Arduino IDE (or `arduino-cli`) with board Arduino Mega 2560 (FQBN `arduino:avr:mega`)
- ESP8266 boards: add `http://arduino.esp8266.com/stable/package_esp8266com_index.json` to Additional Boards Manager URLs, install "esp8266", pick NodeMCU 1.0 (ESP-12E Module) (FQBN `esp8266:esp8266:nodemcuv2`)
- LiquidCrystal is built in
- Repo folders: `firmware/mega/` and `firmware/esp/`, one sketch each

**Build and test order (target: done by hour 3, Sat 1 AM)**

1. **First hour:** test the ultrasonic with the actual demo doll. Soft, fuzzy toys absorb sound and can read as an empty seat; if so, tape cardboard to its chest or use a hard plastic doll.
2. **First hour:** ask Backend to place one real Twilio test call and check whether the trial account plays a "press any key" message first.
3. Power rails: Mega 5V and GND to the rails; check 5V with the multimeter
4. Ultrasonic: print distance; record the empty-seat and occupied-seat numbers
5. LM35: print °F; warm it with the hair dryer and watch it climb within seconds
6. Joystick: with `SIMULATE_TEMP = true`, push right and watch the temperature rise; let go and it holds
7. Photoresistor: print the A2 reading; cover it, then shine a phone light on it
8. PIR (optional): print 1 or 0 while waving a hand
9. Ignition jumper and cancel button: print their states
10. RGB LED: find its type, then show blue, yellow, and red
11. Passive buzzer: play a test siren
12. LCD: show "HELLO" and adjust the contrast
13. Full Mega sketch: alert levels, LCD, buzzer, JSON in the Serial Monitor
14. ESP8266 alone: join the hotspot and POST a test message to the laptop server
15. Mega → ESP link: the server receives the Mega's JSON every 2 seconds
16. Switch `SIMULATE_TEMP` to false and run one full hair-dryer test
17. Battery pack: unplug the laptop and confirm the box still alarms
18. Unplug the ESP mid-alarm and confirm the siren keeps going
