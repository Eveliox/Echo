// Echo box: Arduino Mega 2560. Pins, thresholds, and levels: docs/firmware.md.
// Reads the sensors, runs the alert logic, and sends one status line every
// STATUS_PERIOD_MS to USB Serial and to the ESP8266 on Serial1.
// If the power-up seat baseline fails, it shows a fault code on the RGB LED
// until a power cycle with the seat empty. The RGB LED and buzzer follow the
// alert level. Each temperature reading also feeds minutes to danger, which
// can raise WARNING and EMERGENCY and is sent in the status line.

#include "logic.h"

// Pins: docs/firmware.md, "Mega pin map".
const uint8_t IGNITION_PIN = 4;  // jumper to GND: plugged in (LOW) = car on
const uint8_t CANCEL_PIN = 5;    // button to GND: pressed = LOW
const uint8_t US_ECHO_PIN = 6;
const uint8_t US_TRIG_PIN = 7;
const uint8_t BUZZER_PIN = 8;  // tone() only
const uint8_t RGB_RED_PIN = 44;
const uint8_t RGB_GREEN_PIN = 45;
const uint8_t RGB_BLUE_PIN = 46;
const uint8_t LM35_PIN = A1;

// tone() owns the timer behind these two pins, so no PWM output may use them
// (CLAUDE.md, "Hardware rules for code"). The build fails if one does.
const uint8_t TONE_TIMER_PIN_A = 9;
const uint8_t TONE_TIMER_PIN_B = 10;
constexpr bool clearOfToneTimer(uint8_t pin) {
  return pin != TONE_TIMER_PIN_A && pin != TONE_TIMER_PIN_B;
}
static_assert(clearOfToneTimer(RGB_RED_PIN),
              "RGB_RED_PIN is on the tone() timer: see CLAUDE.md hardware rule on pins 9 and 10");
static_assert(clearOfToneTimer(RGB_GREEN_PIN),
              "RGB_GREEN_PIN is on the tone() timer: see CLAUDE.md hardware rule on pins 9 and 10");
static_assert(clearOfToneTimer(RGB_BLUE_PIN),
              "RGB_BLUE_PIN is on the tone() timer: see CLAUDE.md hardware rule on pins 9 and 10");
static_assert(clearOfToneTimer(BUZZER_PIN),
              "BUZZER_PIN is on the tone() timer: see CLAUDE.md hardware rule on pins 9 and 10");

const unsigned long SERIAL_BAUD = 115200UL;

// Set to true if the RGB LED turns out to be common anode (docs/firmware.md,
// "RGB LED note"); then each color value is inverted.
const bool RGB_COMMON_ANODE = false;

// HC-SR04: give up on an echo after about 4 m of travel, and leave time for
// the previous echo to die out before the next ping.
const unsigned long PING_TIMEOUT_US = 25000UL;
const unsigned long PING_GAP_MS = 60UL;
const float US_PER_CM = 58.0f;  // round-trip microseconds per cm

AlertState alertState;
SeatDetector seat;
Debouncer cancelButton;
Periodic statusTimer;
LevelClock levelClock;
TempHistory tempHistory;

// Set from the LM35 in setup() before the first status line.
float tempF = 0.0f;
// Last good distance: the server needs a number, so a failed read repeats the
// previous value instead of breaking the line.
float distanceCm = 0.0f;
// From tempHistory after each temperature reading; NaN = null (unknown).
float minsToDanger = NAN;

// Off during setup() so the power-up baseline pings don't flash the fault code.
bool outputsLive = false;

// Frequency tone() is playing now; 0 = silent. tone() is only called on a change.
uint16_t buzzerPlayingHz = 0;

void updateOutputs(uint32_t now);

// delay() that keeps the LED and buzzer patterns running, so the blocking
// sensor reads never freeze a flash or the siren sweep.
void waitMs(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) updateOutputs(millis());
}

// One ping in cm; 0 on timeout (seatPingValid treats that as a failed ping).
float pingCm() {
  digitalWrite(US_TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(US_TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG_PIN, LOW);
  unsigned long us = pulseIn(US_ECHO_PIN, HIGH, PING_TIMEOUT_US);
  waitMs(PING_GAP_MS);
  return us / US_PER_CM;
}

float readLM35F() {
  long total = 0;
  for (int i = 0; i < 10; i++) {
    total += analogRead(LM35_PIN);
    waitMs(2);
  }
  return lm35AdcToF(total / 10.0f);
}

// Ultrasonic and temperature: once per status period.
void readSlowSensors() {
  float pings[SEAT_PINGS_PER_READING];
  for (uint8_t i = 0; i < SEAT_PINGS_PER_READING; i++) pings[i] = pingCm();
  seatUpdate(seat, pings);
  float median;
  if (seatMedianCm(pings, median)) distanceCm = median;

  float t = readLM35F();
  if (!isnan(t)) tempF = t;
  tempHistoryAdd(tempHistory, t, millis());  // skips a failed (NaN) reading
  minsToDanger = tempHistoryMinsToDanger(tempHistory, tempF);
}

void sendStatus() {
  StatusFields f;
  f.level = alertState.level;
  f.tempF = tempF;
  f.presence = seat.occupied;
  f.distanceCm = distanceCm;
  f.minsToDanger = minsToDanger;
  char line[STATUS_LINE_MAX];
  if (statusFormat(line, sizeof line, f) == 0) return;
  Serial.println(line);
  // UART has no flow control: these bytes clock out whether or not an ESP is
  // listening, so a missing ESP never stalls the loop.
  Serial1.println(line);
}

// The only analogWrite in the sketch: it touches only the RGB pins, which the
// static_asserts above keep off the tone() timer. Why these pins:
// docs/firmware.md, "RGB LED note"; the rule: CLAUDE.md, "Hardware rules for code".
void setRgb(RgbColor c) {
  analogWrite(RGB_RED_PIN, rgbPinValue(c.r, RGB_COMMON_ANODE));
  analogWrite(RGB_GREEN_PIN, rgbPinValue(c.g, RGB_COMMON_ANODE));
  analogWrite(RGB_BLUE_PIN, rgbPinValue(c.b, RGB_COMMON_ANODE));
}

void setBuzzer(uint16_t hz) {
  if (hz == buzzerPlayingHz) return;
  if (hz == 0) {
    noTone(BUZZER_PIN);
  } else {
    tone(BUZZER_PIN, hz);
  }
  buzzerPlayingHz = hz;
}

// LED (level color, or the seat fault code; alarm levels win) and buzzer.
// Called every loop pass and from waitMs() inside the blocking reads, so the
// patterns never stall. Never blocks.
void updateOutputs(uint32_t now) {
  if (!outputsLive) return;
  uint32_t inLevel = levelClockElapsed(levelClock, now);
  setRgb(alarmLedColor(seat, alertState.level, inLevel, now));
  setBuzzer(buzzerHz(alertState.level, inLevel));
}

void printBaselineFault() {
  Serial.println(F("# seat baseline failed: check the ultrasonic"));
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  Serial1.begin(SERIAL_BAUD);

  pinMode(IGNITION_PIN, INPUT_PULLUP);
  pinMode(CANCEL_PIN, INPUT_PULLUP);
  pinMode(US_TRIG_PIN, OUTPUT);
  pinMode(US_ECHO_PIN, INPUT);
  digitalWrite(US_TRIG_PIN, LOW);
  pinMode(RGB_RED_PIN, OUTPUT);
  pinMode(RGB_GREEN_PIN, OUTPUT);
  pinMode(RGB_BLUE_PIN, OUTPUT);
  setRgb(RGB_OFF);
  noTone(BUZZER_PIN);

  // Seat baseline: the seat must be empty at power-up.
  float samples[SEAT_BASELINE_SAMPLES];
  for (uint8_t i = 0; i < SEAT_BASELINE_SAMPLES; i++) samples[i] = pingCm();
  if (seatSetBaseline(seat, samples)) {
    distanceCm = seat.baselineCm;
  } else {
    printBaselineFault();
  }

  tempF = readLM35F();
  tempHistoryInit(tempHistory);

  alertInit(alertState);
  levelClockInit(levelClock, alertState.level, millis());
  debounceInit(cancelButton, digitalRead(CANCEL_PIN) == LOW, millis());
  periodicInit(statusTimer);
  outputsLive = true;
}

void loop() {
  uint32_t now = millis();
  bool due = periodicDue(statusTimer, now, STATUS_PERIOD_MS);
  if (due) readSlowSensors();

  // Ignition and cancel are read every loop so they act right away.
  AlertInputs in;
  in.ignitionOn = digitalRead(IGNITION_PIN) == LOW;
  in.cancelPressed = debounceUpdate(cancelButton, digitalRead(CANCEL_PIN) == LOW, millis());
  in.seatOccupied = seat.occupied;
  in.tempF = tempF;
  in.minsToDanger = minsToDanger;
  in.nowMs = millis();
  alertStep(alertState, in);
  levelClockUpdate(levelClock, alertState.level, millis());
  updateOutputs(millis());

  if (due) {
    sendStatus();
    // Repeated with every status line so a Serial Monitor attached late still
    // sees it. USB Serial only; the ESP never gets it.
    if (!seat.hasBaseline) printBaselineFault();
  }
}
