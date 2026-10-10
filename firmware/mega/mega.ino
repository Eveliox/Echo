// Echo box: Arduino Mega 2560. Pins, thresholds, and levels: docs/firmware.md.
// Reads the sensors, runs the alert logic, and sends one status line every
// STATUS_PERIOD_MS to USB Serial and to the ESP8266 on Serial1.
// If the power-up seat baseline fails, it shows a fault code on the RGB LED
// until a power cycle with the seat empty. Level colors, buzzer, LCD, and
// minutes to danger come in later tickets.
//
// Library: "DHT sensor library" by Adafruit (see docs/firmware.md, "Setup and
// build order").

#include <DHT.h>

#include "logic.h"

// Test-only: the joystick replaces the LM35. Must be false for the demo.
const bool SIMULATE_TEMP = false;

// Pins: docs/firmware.md, "Mega pin map".
const uint8_t DHT_PIN = 2;
const uint8_t IGNITION_PIN = 4;  // jumper to GND: plugged in (LOW) = car on
const uint8_t CANCEL_PIN = 5;    // button to GND: pressed = LOW
const uint8_t US_ECHO_PIN = 6;
const uint8_t US_TRIG_PIN = 7;
const uint8_t RGB_RED_PIN = 44;
const uint8_t RGB_GREEN_PIN = 45;
const uint8_t RGB_BLUE_PIN = 46;
const uint8_t LM35_PIN = A1;
const uint8_t JOY_X_PIN = A3;

const unsigned long SERIAL_BAUD = 115200UL;

// Set to true if the RGB LED turns out to be common anode (docs/firmware.md,
// "RGB LED note"); then LOW lights a color.
const bool RGB_COMMON_ANODE = false;

// Sent as humidity when there is no recent good DHT11 reading. A number for
// now because the server requires one.
const float HUMIDITY_PLACEHOLDER = 0.0f;

// HC-SR04: give up on an echo after about 4 m of travel, and leave time for
// the previous echo to die out before the next ping.
const unsigned long PING_TIMEOUT_US = 25000UL;
const unsigned long PING_GAP_MS = 60UL;
const float US_PER_CM = 58.0f;  // round-trip microseconds per cm

DHT dht(DHT_PIN, DHT11);

AlertState alertState;
SeatDetector seat;
Debouncer cancelButton;
Periodic statusTimer;
HumidityHold humidity;

float tempF = SIM_START_F;
float simTempF = SIM_START_F;
unsigned long lastSimUpdate = 0;
// Last good distance: the server needs a number, so a failed read repeats the
// previous value instead of breaking the line.
float distanceCm = 0.0f;

// Off during setup() so the power-up baseline pings don't flash the fault code.
bool ledLive = false;

void updateLed(uint32_t now);

// delay() that keeps the LED pattern running, so the blocking sensor reads
// never freeze or hide a flash.
void waitMs(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) updateLed(millis());
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

float readSimulatedF() {
  unsigned long now = millis();
  simTempF = simTempStep(simTempF, analogRead(JOY_X_PIN), now - lastSimUpdate);
  lastSimUpdate = now;
  return simTempF;
}

float readTempF() { return SIMULATE_TEMP ? readSimulatedF() : readLM35F(); }

void readHumidity() { humidityUpdate(humidity, dht.readHumidity(), millis()); }

// Ultrasonic, temperature, and humidity: once per status period.
void readSlowSensors() {
  float pings[SEAT_PINGS_PER_READING];
  for (uint8_t i = 0; i < SEAT_PINGS_PER_READING; i++) pings[i] = pingCm();
  seatUpdate(seat, pings);
  float median;
  if (seatMedianCm(pings, median)) distanceCm = median;

  float t = readTempF();
  if (!isnan(t)) tempF = t;

  readHumidity();
}

void sendStatus() {
  StatusFields f;
  f.level = alertState.level;
  f.tempF = tempF;
  float h;
  f.humidity = humidityCurrent(humidity, millis(), h) ? h : HUMIDITY_PLACEHOLDER;
  f.presence = seat.occupied;
  f.distanceCm = distanceCm;
  char line[STATUS_LINE_MAX];
  if (statusFormat(line, sizeof line, f) == 0) return;
  Serial.println(line);
  // UART has no flow control: these bytes clock out whether or not an ESP is
  // listening, so a missing ESP never stalls the loop.
  Serial1.println(line);
}

void setRgb(bool red, bool green, bool blue) {
  digitalWrite(RGB_RED_PIN, red != RGB_COMMON_ANODE ? HIGH : LOW);
  digitalWrite(RGB_GREEN_PIN, green != RGB_COMMON_ANODE ? HIGH : LOW);
  digitalWrite(RGB_BLUE_PIN, blue != RGB_COMMON_ANODE ? HIGH : LOW);
}

// Fault code while the seat has no baseline; alarm levels always win
// (seatFaultActive). Level colors come in a later ticket and go in the else.
// Called every loop pass and from waitMs() inside the blocking reads.
void updateLed(uint32_t now) {
  if (!ledLive) return;
  if (seatFaultActive(seat, alertState.level)) {
    bool on = seatFaultLedOn(now);
    setRgb(on, false, on);  // magenta
  } else {
    setRgb(false, false, false);
  }
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
  setRgb(false, false, false);
  dht.begin();

  if (SIMULATE_TEMP) {
    // Not JSON, so the ESP drops it; only the Serial Monitor sees it.
    Serial.println(F("# SIMULATE_TEMP on: temperature comes from the joystick"));
  }

  // Seat baseline: the seat must be empty at power-up.
  float samples[SEAT_BASELINE_SAMPLES];
  for (uint8_t i = 0; i < SEAT_BASELINE_SAMPLES; i++) samples[i] = pingCm();
  if (seatSetBaseline(seat, samples)) {
    distanceCm = seat.baselineCm;
  } else {
    printBaselineFault();
  }

  tempF = SIMULATE_TEMP ? SIM_START_F : readLM35F();
  lastSimUpdate = millis();
  humidityInit(humidity);
  readHumidity();

  alertInit(alertState);
  debounceInit(cancelButton, digitalRead(CANCEL_PIN) == LOW, millis());
  periodicInit(statusTimer);
  ledLive = true;
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
  in.nowMs = millis();
  alertStep(alertState, in);
  updateLed(millis());

  if (due) {
    sendStatus();
    // Repeated with every status line so a Serial Monitor attached late still
    // sees it. USB Serial only; the ESP never gets it.
    if (!seat.hasBaseline) printBaselineFault();
  }
}
