// Echo box logic: pure decision code shared by the Mega sketch and the laptop
// tests. Plain C++ only (see CLAUDE.md "Hardware rules for code"): no
// Arduino.h, no STL, no dynamic allocation; only <stdint.h> and <math.h>.
// Rules and numbers come from docs/firmware.md, "Firmware behavior".

#ifndef ECHO_LOGIC_H
#define ECHO_LOGIC_H

#include <stdint.h>
#include <math.h>

// ---------------------------------------------------------------------------
// Seat detection ("Seat detection" in docs/firmware.md, "Firmware behavior").
//
// Inputs are ultrasonic ping distances in cm; this block never reads hardware.
//
// Decisions not in the doc (pinned by tests in test/logic_test.cpp):
// - A ping outside the sensor's range (0 = HC-SR04 timeout, negative, NaN, or
//   too far) is invalid and dropped. It never counts as a short distance.
// - A reading needs a majority of valid pings; otherwise it is "no reading":
//   the seat state holds and both in-a-row counts restart.
// - The baseline averages only valid samples and needs a majority of them;
//   without a baseline the seat stays empty.
// - Symmetric: an occupied seat goes back to empty only after the same number
//   of not-occupied readings in a row.
// ---------------------------------------------------------------------------

static const uint8_t SEAT_BASELINE_SAMPLES = 20;
static const uint8_t SEAT_PINGS_PER_READING = 5;
static const float SEAT_DROP_CM = 10.0f;
static const uint8_t SEAT_READINGS_IN_A_ROW = 3;

// HC-SR04 datasheet range; anything outside is treated as a failed ping.
static const float SEAT_PING_MIN_CM = 2.0f;
static const float SEAT_PING_MAX_CM = 400.0f;

static const uint8_t SEAT_MIN_VALID_PINGS = SEAT_PINGS_PER_READING / 2 + 1;
static const uint8_t SEAT_MIN_VALID_BASELINE = SEAT_BASELINE_SAMPLES / 2 + 1;

struct SeatDetector {
  float baselineCm;
  bool hasBaseline;
  bool occupied;
  uint8_t occupiedRun;  // valid occupied-looking readings in a row
  uint8_t emptyRun;     // valid empty-looking readings in a row
};

inline void seatInit(SeatDetector &s) {
  s.baselineCm = 0.0f;
  s.hasBaseline = false;
  s.occupied = false;
  s.occupiedRun = 0;
  s.emptyRun = 0;
}

// False for 0 (timeout), negatives, NaN, and anything out of sensor range.
inline bool seatPingValid(float cm) {
  return cm >= SEAT_PING_MIN_CM && cm <= SEAT_PING_MAX_CM;
}

// Median of the valid pings in one reading. Returns false (and leaves `out`
// alone) when fewer than SEAT_MIN_VALID_PINGS are valid.
inline bool seatMedianCm(const float pings[SEAT_PINGS_PER_READING], float &out) {
  float v[SEAT_PINGS_PER_READING];
  uint8_t n = 0;
  for (uint8_t i = 0; i < SEAT_PINGS_PER_READING; i++) {
    if (!seatPingValid(pings[i])) continue;
    // Insertion sort as we go.
    uint8_t j = n;
    while (j > 0 && v[j - 1] > pings[i]) {
      v[j] = v[j - 1];
      j--;
    }
    v[j] = pings[i];
    n++;
  }
  if (n < SEAT_MIN_VALID_PINGS) return false;
  if (n % 2 == 1) {
    out = v[n / 2];
  } else {
    out = (v[n / 2 - 1] + v[n / 2]) / 2.0f;
  }
  return true;
}

// Stores the average of the valid empty-seat samples as the baseline and
// resets the seat to empty. Returns false (no baseline) when fewer than
// SEAT_MIN_VALID_BASELINE samples are valid.
inline bool seatSetBaseline(SeatDetector &s, const float samples[SEAT_BASELINE_SAMPLES]) {
  float sum = 0.0f;
  uint8_t n = 0;
  for (uint8_t i = 0; i < SEAT_BASELINE_SAMPLES; i++) {
    if (!seatPingValid(samples[i])) continue;
    sum += samples[i];
    n++;
  }
  seatInit(s);
  if (n < SEAT_MIN_VALID_BASELINE) return false;
  s.baselineCm = sum / n;
  s.hasBaseline = true;
  return true;
}

// Feeds one reading (SEAT_PINGS_PER_READING pings) and returns whether the
// seat counts as occupied afterwards.
inline bool seatUpdate(SeatDetector &s, const float pings[SEAT_PINGS_PER_READING]) {
  float median = 0.0f;
  if (!s.hasBaseline || !seatMedianCm(pings, median)) {
    s.occupiedRun = 0;
    s.emptyRun = 0;
    return s.occupied;
  }
  if (median <= s.baselineCm - SEAT_DROP_CM) {
    s.emptyRun = 0;
    if (s.occupiedRun < SEAT_READINGS_IN_A_ROW) s.occupiedRun++;
    if (s.occupiedRun >= SEAT_READINGS_IN_A_ROW) s.occupied = true;
  } else {
    s.occupiedRun = 0;
    if (s.emptyRun < SEAT_READINGS_IN_A_ROW) s.emptyRun++;
    if (s.emptyRun >= SEAT_READINGS_IN_A_ROW) s.occupied = false;
  }
  return s.occupied;
}

// --- end seat detection ----------------------------------------------------

// ---------------------------------------------------------------------------
// Alert levels (level table and "Leaving a level" in docs/firmware.md,
// "Firmware behavior"). Temperature thresholds only for now; minutes-to-danger
// is added later.
//
// Decisions not in the doc (pinned by tests in test/logic_test.cpp):
// - OCCUPANT is sticky like WARNING and EMERGENCY: an empty seat never lowers it.
// - Ignition wins over cancel when both are active.
// - Cancel is read as held, not edge-triggered; debouncing is the sketch's job.
// ---------------------------------------------------------------------------

static const uint32_t OCCUPANT_AFTER_MS = 30000UL;
static const float WARNING_TEMP_F = 95.0f;
static const float EMERGENCY_TEMP_F = 104.0f;

enum AlertLevel : uint8_t {
  LEVEL_IDLE,
  LEVEL_ARMED,
  LEVEL_OCCUPANT,
  LEVEL_WARNING,
  LEVEL_EMERGENCY,
};

// One reading of the box's inputs, taken each loop.
struct AlertInputs {
  bool ignitionOn;     // ignition jumper plugged in
  bool cancelPressed;  // physical cancel button held
  bool seatOccupied;   // seat-detection result
  float tempF;         // cabin temperature; NaN never raises a level
  uint32_t nowMs;      // millis(); wraparound is handled
};

struct AlertState {
  AlertLevel level;
  bool seatTimerRunning;
  uint32_t occupiedSinceMs;
};

inline void alertInit(AlertState &s) {
  s.level = LEVEL_IDLE;
  s.seatTimerRunning = false;
  s.occupiedSinceMs = 0;
}

inline const char *alertLevelName(AlertLevel level) {
  switch (level) {
    case LEVEL_IDLE: return "IDLE";
    case LEVEL_ARMED: return "ARMED";
    case LEVEL_OCCUPANT: return "OCCUPANT";
    case LEVEL_WARNING: return "WARNING";
    case LEVEL_EMERGENCY: return "EMERGENCY";
  }
  return "IDLE";
}

// Advances the level from one set of inputs and returns it.
// Only the ignition (-> IDLE) and the cancel button (-> ARMED) lower a level.
// Otherwise levels only climb: a cooling cabin or an empty seat never lowers one.
inline AlertLevel alertStep(AlertState &s, const AlertInputs &in) {
  if (in.ignitionOn) {
    s.level = LEVEL_IDLE;
    s.seatTimerRunning = false;
    return s.level;
  }
  if (in.cancelPressed) {
    s.level = LEVEL_ARMED;
    s.seatTimerRunning = false;
    return s.level;
  }

  if (s.level == LEVEL_IDLE) {
    s.level = LEVEL_ARMED;
  }

  if (s.level == LEVEL_ARMED) {
    if (!in.seatOccupied) {
      s.seatTimerRunning = false;
    } else {
      if (!s.seatTimerRunning) {
        s.seatTimerRunning = true;
        s.occupiedSinceMs = in.nowMs;
      }
      if ((uint32_t)(in.nowMs - s.occupiedSinceMs) >= OCCUPANT_AFTER_MS) {
        s.level = LEVEL_OCCUPANT;
        s.seatTimerRunning = false;
      }
    }
  }

  // From OCCUPANT up, the seat no longer matters; only heat climbs the level.
  if (s.level >= LEVEL_OCCUPANT && s.level < LEVEL_EMERGENCY) {
    if (in.tempF >= EMERGENCY_TEMP_F) {
      s.level = LEVEL_EMERGENCY;
    } else if (in.tempF >= WARNING_TEMP_F && s.level < LEVEL_WARNING) {
      s.level = LEVEL_WARNING;
    }
  }

  return s.level;
}

// --- end alert levels ------------------------------------------------------

// ---------------------------------------------------------------------------
// Sensor conversions and timing ("Firmware behavior" and "Temperature
// simulation" in docs/firmware.md). Pure math; the sketch does the reads.
//
// Decisions not in the doc (pinned by tests in test/logic_test.cpp):
// - The 2 s status period is due on the very first call, then every period
//   after the previous due time (no drift), and survives millis() wraparound.
//   If the loop fell more than one period behind, it resyncs to `now` instead
//   of firing a burst of catch-up lines.
// - The cancel button counts as pressed only after its raw reading has been
//   steady for CANCEL_DEBOUNCE_MS; release is debounced the same way.
// ---------------------------------------------------------------------------

static const uint32_t STATUS_PERIOD_MS = 2000UL;

// LM35: 10 mV per degree C on a 5 V, 10-bit ADC.
static const float ADC_REF_V = 5.0f;
static const float ADC_MAX = 1023.0f;

// Joystick simulation constants from docs/firmware.md "Temperature simulation".
static const float SIM_START_F = 80.0f;
static const float SIM_MIN_F = 60.0f;
static const float SIM_MAX_F = 140.0f;
static const float SIM_MAX_RATE_F_PER_S = 0.5f;
static const int16_t SIM_JOY_CENTER = 512;
static const int16_t SIM_JOY_DEAD_ZONE = 50;

static const uint32_t CANCEL_DEBOUNCE_MS = 30UL;

// Average LM35 ADC reading -> degrees F.
inline float lm35AdcToF(float avgAdc) {
  float tempC = avgAdc * ADC_REF_V / ADC_MAX * 100.0f;
  return tempC * 9.0f / 5.0f + 32.0f;
}

// One simulation step: joystick X reading (0-1023) applied for `elapsedMs`.
// Right warms, left cools, the dead zone holds; result is clamped.
inline float simTempStep(float simF, int16_t joyAdc, uint32_t elapsedMs) {
  int16_t offset = joyAdc - SIM_JOY_CENTER;
  if (offset > -SIM_JOY_DEAD_ZONE && offset < SIM_JOY_DEAD_ZONE) offset = 0;
  float seconds = elapsedMs / 1000.0f;
  simF += (offset / 512.0f) * SIM_MAX_RATE_F_PER_S * seconds;
  if (simF < SIM_MIN_F) simF = SIM_MIN_F;
  if (simF > SIM_MAX_F) simF = SIM_MAX_F;
  return simF;
}

struct Periodic {
  bool started;
  uint32_t lastMs;
};

inline void periodicInit(Periodic &p) {
  p.started = false;
  p.lastMs = 0;
}

// True when a new period has started; call every loop with millis().
inline bool periodicDue(Periodic &p, uint32_t nowMs, uint32_t periodMs) {
  if (!p.started) {
    p.started = true;
    p.lastMs = nowMs;
    return true;
  }
  uint32_t elapsed = nowMs - p.lastMs;
  if (elapsed < periodMs) return false;
  p.lastMs = (elapsed < 2 * periodMs) ? p.lastMs + periodMs : nowMs;
  return true;
}

struct Debouncer {
  bool stable;       // debounced state
  bool lastRaw;
  uint32_t changedMs;  // when lastRaw last changed
};

inline void debounceInit(Debouncer &d, bool raw, uint32_t nowMs) {
  d.stable = raw;
  d.lastRaw = raw;
  d.changedMs = nowMs;
}

// Feeds one raw reading; returns the debounced state.
inline bool debounceUpdate(Debouncer &d, bool raw, uint32_t nowMs) {
  if (raw != d.lastRaw) {
    d.lastRaw = raw;
    d.changedMs = nowMs;
  } else if (raw != d.stable && (uint32_t)(nowMs - d.changedMs) >= CANCEL_DEBOUNCE_MS) {
    d.stable = raw;
  }
  return d.stable;
}

// --- end sensor conversions and timing -------------------------------------

// ---------------------------------------------------------------------------
// No-baseline fault indicator, humidity age limit.
//
// Decisions not in the doc (pinned by tests in test/logic_test.cpp):
// - The seat baseline is taken only at power-up with the seat empty (doc,
//   "Seat detection"); there is no automatic retry, because a later retry could
//   learn an occupied seat as "empty" and never alarm. If the power-up baseline
//   fails, the box cannot reach OCCUPANT until it is power-cycled with the seat
//   empty, and it shows a fault until then.
// - While there is no baseline and the level is below OCCUPANT, the RGB LED
//   shows a fault code: magenta (red + blue, a color no level uses), two short
//   flashes every FAULT_CYCLE_MS. From OCCUPANT up the level pattern always
//   wins and the fault code is off.
// - A good humidity reading is reused for at most HUMIDITY_MAX_AGE_MS; after
//   that there is no valid humidity and the caller sends its placeholder.
//   Out-of-range (outside 0-100 %) or NaN readings are ignored.
// ---------------------------------------------------------------------------

static const uint32_t FAULT_CYCLE_MS = 2000UL;
static const uint32_t FAULT_FLASH_MS = 100UL;
static const uint32_t FAULT_SECOND_FLASH_AT_MS = 300UL;

// Whether the no-baseline fault code should show at all. Alarm levels win.
inline bool seatFaultActive(const SeatDetector &s, AlertLevel level) {
  return !s.hasBaseline && level < LEVEL_OCCUPANT;
}

// Whether the fault code's magenta is lit at `nowMs` (two short flashes per
// cycle). Only meaningful while seatFaultActive is true.
inline bool seatFaultLedOn(uint32_t nowMs) {
  uint32_t phase = nowMs % FAULT_CYCLE_MS;
  if (phase < FAULT_FLASH_MS) return true;
  return phase >= FAULT_SECOND_FLASH_AT_MS && phase < FAULT_SECOND_FLASH_AT_MS + FAULT_FLASH_MS;
}

static const uint32_t HUMIDITY_MAX_AGE_MS = 30000UL;

struct HumidityHold {
  bool have;
  float value;
  uint32_t atMs;  // when `value` was read
};

inline void humidityInit(HumidityHold &h) {
  h.have = false;
  h.value = 0.0f;
  h.atMs = 0;
}

// Feeds one DHT11 reading; bad readings leave the last good one in place.
inline void humidityUpdate(HumidityHold &h, float reading, uint32_t nowMs) {
  if (!(reading >= 0.0f && reading <= 100.0f)) return;  // false for NaN too
  h.have = true;
  h.value = reading;
  h.atMs = nowMs;
}

// True (and sets `out`) while the last good reading is at most
// HUMIDITY_MAX_AGE_MS old. Once expired it stays expired until a new good
// reading, even if millis() later wraps around to look fresh.
inline bool humidityCurrent(HumidityHold &h, uint32_t nowMs, float &out) {
  if (!h.have) return false;
  if ((uint32_t)(nowMs - h.atMs) > HUMIDITY_MAX_AGE_MS) {
    h.have = false;
    return false;
  }
  out = h.value;
  return true;
}

// --- end fault indicator, humidity age -------------------------------------

// ---------------------------------------------------------------------------
// Status line ("Data format and Wi-Fi" in docs/firmware.md). Field names,
// order, and types follow the doc. `light` is pending approval, so it is left
// out. `motion`, `minsToDanger`, and `battery` are sent as null until their
// tickets land.
//
// No snprintf: avr-libc's printf family has no %f, so numbers are written by
// hand. tempF has one decimal; humidity and distanceCm are rounded integers.
// The server requires tempF, humidity, and distanceCm to be numbers, so a
// non-finite value there makes statusFormat fail (returns 0) instead of
// sending a bad line; the sketch keeps last good values (humidity: a
// placeholder once too old) to avoid that.
// ---------------------------------------------------------------------------

static const uint16_t STATUS_LINE_MAX = 192;  // buffer size incl. terminator

struct StatusFields {
  AlertLevel level;
  float tempF;
  float humidity;
  bool presence;
  float distanceCm;
};

struct StrBuf {
  char *buf;
  uint16_t cap;
  uint16_t len;
  bool ok;
};

inline void sbPutc(StrBuf &b, char c) {
  if (!b.ok) return;
  if (b.len + 1 >= b.cap) {  // keep room for the terminator
    b.ok = false;
    return;
  }
  b.buf[b.len++] = c;
}

inline void sbPuts(StrBuf &b, const char *s) {
  while (*s) sbPutc(b, *s++);
}

inline void sbPutUint(StrBuf &b, uint32_t v) {
  char tmp[10];
  uint8_t n = 0;
  do {
    tmp[n++] = (char)('0' + v % 10);
    v /= 10;
  } while (v > 0);
  while (n > 0) sbPutc(b, tmp[--n]);
}

// Largest magnitude the number writers accept; far beyond any sensor value.
static const float STATUS_NUM_LIMIT = 100000.0f;

inline bool statusNumOk(float v) {
  return v > -STATUS_NUM_LIMIT && v < STATUS_NUM_LIMIT;  // false for NaN too
}

// Rounded to the nearest integer, halves away from zero.
inline void sbPutRounded(StrBuf &b, float v) {
  if (!statusNumOk(v)) {
    b.ok = false;
    return;
  }
  uint32_t r = (uint32_t)(fabsf(v) + 0.5f);
  if (v < 0 && r != 0) sbPutc(b, '-');
  sbPutUint(b, r);
}

// One decimal place, rounded, e.g. 96.4 or -3.5.
inline void sbPutFixed1(StrBuf &b, float v) {
  if (!statusNumOk(v)) {
    b.ok = false;
    return;
  }
  uint32_t tenths = (uint32_t)(fabsf(v) * 10.0f + 0.5f);
  if (v < 0 && tenths != 0) sbPutc(b, '-');
  sbPutUint(b, tenths / 10);
  sbPutc(b, '.');
  sbPutc(b, (char)('0' + tenths % 10));
}

// Writes one JSON status line (no newline) into `out`. Returns its length, or
// 0 if it didn't fit or a required number was not finite (out is then "").
inline uint16_t statusFormat(char *out, uint16_t cap, const StatusFields &f) {
  if (cap == 0) return 0;
  StrBuf b = {out, cap, 0, true};
  sbPuts(b, "{\"state\":\"");
  sbPuts(b, alertLevelName(f.level));
  sbPuts(b, "\",\"tempF\":");
  sbPutFixed1(b, f.tempF);
  sbPuts(b, ",\"humidity\":");
  sbPutRounded(b, f.humidity);
  sbPuts(b, ",\"presence\":");
  sbPuts(b, f.presence ? "true" : "false");
  sbPuts(b, ",\"distanceCm\":");
  sbPutRounded(b, f.distanceCm);
  sbPuts(b, ",\"motion\":null,\"minsToDanger\":null,\"battery\":null}");
  if (!b.ok) {
    out[0] = '\0';
    return 0;
  }
  out[b.len] = '\0';
  return b.len;
}

// --- end status line -------------------------------------------------------

#endif  // ECHO_LOGIC_H
