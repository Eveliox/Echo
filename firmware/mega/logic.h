// Echo box logic: pure decision code shared by the Mega sketch and the laptop
// tests. Plain C++ only (see CLAUDE.md "Hardware rules for code"): no
// Arduino.h, no STL, no dynamic allocation; only <stdint.h> and <math.h>.
// Rules and numbers come from docs/firmware.md, "Firmware behavior".

#ifndef ECHO_LOGIC_H
#define ECHO_LOGIC_H

#include <stdint.h>

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

#endif  // ECHO_LOGIC_H
