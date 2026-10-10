// Laptop tests for firmware/mega/logic.h. Run with the logic-test row in
// CLAUDE.md "Checks". No framework: add a test function, list it in main().
// Any failed CHECK makes the program exit non-zero.

#include <stdio.h>
#include <math.h>

#include "logic.h"

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond)                                                   \
  do {                                                                \
    g_checks++;                                                       \
    if (!(cond)) {                                                    \
      g_failures++;                                                   \
      printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                 \
  } while (0)

// ---------------------------------------------------------------------------
// Seat detection
// ---------------------------------------------------------------------------

static const float EMPTY_CM = 60.0f;
static const float OCCUPIED_CM = EMPTY_CM - SEAT_DROP_CM - 5.0f;

static void fill(float *a, uint8_t n, float cm) {
  for (uint8_t i = 0; i < n; i++) a[i] = cm;
}

// Detector with a baseline of exactly `cm`.
static SeatDetector seatWithBaseline(float cm) {
  SeatDetector s;
  float samples[SEAT_BASELINE_SAMPLES];
  fill(samples, SEAT_BASELINE_SAMPLES, cm);
  seatSetBaseline(s, samples);
  return s;
}

// Feeds `count` readings whose pings are all `cm`; returns the last result.
static bool feed(SeatDetector &s, float cm, int count) {
  float pings[SEAT_PINGS_PER_READING];
  fill(pings, SEAT_PINGS_PER_READING, cm);
  bool occ = s.occupied;
  for (int i = 0; i < count; i++) occ = seatUpdate(s, pings);
  return occ;
}

static void test_seat_baseline_is_average_of_samples() {
  SeatDetector s;
  float samples[SEAT_BASELINE_SAMPLES];
  for (uint8_t i = 0; i < SEAT_BASELINE_SAMPLES; i++) {
    samples[i] = (i % 2 == 0) ? 58.0f : 62.0f;
  }
  CHECK(seatSetBaseline(s, samples));
  CHECK(s.hasBaseline);
  CHECK(fabsf(s.baselineCm - 60.0f) < 0.001f);
  CHECK(!s.occupied);
}

// Pins the values in docs/firmware.md "Seat detection" with literals, so a
// changed constant fails here instead of silently moving every other test.
static void test_seat_constants_match_doc() {
  CHECK(SEAT_BASELINE_SAMPLES == 20);
  CHECK(SEAT_PINGS_PER_READING == 5);
  CHECK(SEAT_DROP_CM == 10.0f);
  CHECK(SEAT_READINGS_IN_A_ROW == 3);
}

static void test_seat_flip_with_literals() {
  SeatDetector s = seatWithBaseline(60.0f);
  CHECK(!feed(s, 50.0f, 2));
  CHECK(feed(s, 50.0f, 1));

  SeatDetector t = seatWithBaseline(60.0f);
  CHECK(!feed(t, 50.5f, 50));
}

static void test_seat_baseline_is_mean_not_median() {
  SeatDetector s;
  float samples[SEAT_BASELINE_SAMPLES];
  fill(samples, SEAT_BASELINE_SAMPLES, 60.0f);
  samples[SEAT_BASELINE_SAMPLES - 1] = 80.0f;
  CHECK(seatSetBaseline(s, samples));
  CHECK(fabsf(s.baselineCm - 61.0f) < 0.001f);
}

static void test_seat_baseline_ignores_failed_samples() {
  SeatDetector s;
  float samples[SEAT_BASELINE_SAMPLES];
  fill(samples, SEAT_BASELINE_SAMPLES, EMPTY_CM);
  samples[0] = 0.0f;     // timeout
  samples[1] = 900.0f;   // out of range
  CHECK(seatSetBaseline(s, samples));
  CHECK(fabsf(s.baselineCm - EMPTY_CM) < 0.001f);
}

static void test_seat_baseline_needs_majority_valid() {
  SeatDetector s;
  float samples[SEAT_BASELINE_SAMPLES];
  fill(samples, SEAT_BASELINE_SAMPLES, 0.0f);
  for (uint8_t i = 0; i + 1 < SEAT_MIN_VALID_BASELINE; i++) samples[i] = EMPTY_CM;
  CHECK(!seatSetBaseline(s, samples));
  CHECK(!s.hasBaseline);
  // Without a baseline even a very short distance never marks the seat.
  CHECK(!feed(s, 5.0f, SEAT_READINGS_IN_A_ROW * 3));
}

static void test_seat_median_of_pings() {
  float out = -1.0f;
  float pings[SEAT_PINGS_PER_READING] = {70.0f, 40.0f, 41.0f, 3.0f, 42.0f};
  CHECK(seatMedianCm(pings, out));
  CHECK(fabsf(out - 41.0f) < 0.001f);

  // Failed pings are dropped, not sorted in as short distances.
  float withZeros[SEAT_PINGS_PER_READING] = {0.0f, 0.0f, 60.0f, 61.0f, 59.0f};
  CHECK(seatMedianCm(withZeros, out));
  CHECK(fabsf(out - 60.0f) < 0.001f);

  // Even count of valid pings: mean of the middle two.
  float oneBad[SEAT_PINGS_PER_READING] = {0.0f, 50.0f, 60.0f, 70.0f, 80.0f};
  CHECK(seatMedianCm(oneBad, out));
  CHECK(fabsf(out - 65.0f) < 0.001f);

  // Too few valid pings: no reading.
  float mostlyBad[SEAT_PINGS_PER_READING] = {0.0f, 0.0f, 0.0f, 40.0f, 40.0f};
  out = -1.0f;
  CHECK(!seatMedianCm(mostlyBad, out));
  CHECK(out == -1.0f);
}

static void test_seat_ping_validity() {
  CHECK(!seatPingValid(0.0f));
  CHECK(!seatPingValid(-1.0f));
  CHECK(!seatPingValid(NAN));
  CHECK(!seatPingValid(SEAT_PING_MAX_CM + 1.0f));
  CHECK(seatPingValid(EMPTY_CM));
}

static void test_seat_empty_stays_empty() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(!feed(s, EMPTY_CM, 50));
  // Small wobble under the drop threshold also stays empty.
  CHECK(!feed(s, EMPTY_CM - SEAT_DROP_CM + 1.0f, 50));
}

static void test_seat_one_noisy_ping_does_not_flip() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  // One very short ping in every reading: the median rejects it.
  float pings[SEAT_PINGS_PER_READING];
  fill(pings, SEAT_PINGS_PER_READING, EMPTY_CM);
  pings[2] = 5.0f;
  for (int i = 0; i < 50; i++) CHECK(!seatUpdate(s, pings));
}

static void test_seat_short_run_of_drops_does_not_flip() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  // One fewer occupied reading than needed, then empty, then again: never flips.
  for (int round = 0; round < 5; round++) {
    CHECK(!feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW - 1));
    CHECK(!feed(s, EMPTY_CM, 1));
  }
}

static void test_seat_sustained_drop_flips() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(!feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW - 1));
  CHECK(feed(s, OCCUPIED_CM, 1));
  CHECK(feed(s, OCCUPIED_CM, 20));
}

static void test_seat_drop_threshold_is_inclusive() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(feed(s, EMPTY_CM - SEAT_DROP_CM, SEAT_READINGS_IN_A_ROW));

  SeatDetector t = seatWithBaseline(EMPTY_CM);
  CHECK(!feed(t, EMPTY_CM - SEAT_DROP_CM + 0.5f, SEAT_READINGS_IN_A_ROW * 3));
}

static void test_seat_failed_pings_never_flip() {
  // All-timeout readings: no reading, so the empty seat stays empty...
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(!feed(s, 0.0f, 50));
  CHECK(!feed(s, NAN, 50));
  CHECK(!feed(s, SEAT_PING_MAX_CM + 100.0f, 50));

  // ...and an occupied seat stays occupied.
  SeatDetector o = seatWithBaseline(EMPTY_CM);
  CHECK(feed(o, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW));
  CHECK(feed(o, 0.0f, 50));
}

static void test_seat_failed_reading_breaks_the_run() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(!feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW - 1));
  CHECK(!feed(s, 0.0f, 1));  // no reading: run restarts
  CHECK(!feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW - 1));
  CHECK(feed(s, OCCUPIED_CM, 1));
}

static void test_seat_returns_to_empty_symmetrically() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW));
  // A single empty-looking reading doesn't clear it.
  CHECK(feed(s, EMPTY_CM, SEAT_READINGS_IN_A_ROW - 1));
  CHECK(feed(s, OCCUPIED_CM, 1));
  CHECK(feed(s, EMPTY_CM, SEAT_READINGS_IN_A_ROW - 1));
  CHECK(!feed(s, EMPTY_CM, 1));
}

static void test_seat_new_baseline_resets_state() {
  SeatDetector s = seatWithBaseline(EMPTY_CM);
  CHECK(feed(s, OCCUPIED_CM, SEAT_READINGS_IN_A_ROW));
  float samples[SEAT_BASELINE_SAMPLES];
  fill(samples, SEAT_BASELINE_SAMPLES, EMPTY_CM);
  CHECK(seatSetBaseline(s, samples));
  CHECK(!s.occupied);
}

// ---------------------------------------------------------------------------
// Alert levels
// ---------------------------------------------------------------------------

#define CHECK_LEVEL(actual, expected)                                        \
  do {                                                                       \
    g_checks++;                                                              \
    AlertLevel a_ = (actual), e_ = (expected);                               \
    if (a_ != e_) {                                                          \
      printf("FAIL %s:%d: got %s, want %s\n", __FILE__, __LINE__,            \
             alertLevelName(a_), alertLevelName(e_));                        \
      g_failures++;                                                            \
    }                                                                        \
  } while (0)

// Pins the values in docs/firmware.md "Firmware behavior" with literals, so a
// changed constant fails here instead of silently moving every other test.
static void test_alert_constants_match_doc() {
  CHECK(OCCUPANT_AFTER_MS == 30000UL);
  CHECK(WARNING_TEMP_F == 95.0f);
  CHECK(EMERGENCY_TEMP_F == 104.0f);
}

static const float COOL_F = 80.0f;

static AlertInputs carOff(bool occupied, float tempF, uint32_t nowMs) {
  AlertInputs in;
  in.ignitionOn = false;
  in.cancelPressed = false;
  in.seatOccupied = occupied;
  in.tempF = tempF;
  in.nowMs = nowMs;
  return in;
}

// Ignition off, seat occupied long enough: ends in OCCUPANT at time `t`.
static uint32_t reachOccupant(AlertState &s, uint32_t start = 0) {
  alertInit(s);
  alertStep(s, carOff(true, COOL_F, start));
  uint32_t t = start + OCCUPANT_AFTER_MS;
  alertStep(s, carOff(true, COOL_F, t));
  return t;
}

static void test_starts_idle_and_ignition_on_stays_idle() {
  AlertState s;
  alertInit(s);
  CHECK_LEVEL(s.level, LEVEL_IDLE);
  AlertInputs in = carOff(true, 120.0f, 0);
  in.ignitionOn = true;
  CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
  in.nowMs = 60000;
  CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
}

static void test_ignition_off_arms() {
  AlertState s;
  alertInit(s);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, 0)), LEVEL_ARMED);
}

static void test_occupant_needs_seat_occupied_for_dwell() {
  AlertState s;
  alertInit(s);
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, 1000)), LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, 1000 + OCCUPANT_AFTER_MS - 1)),
              LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, 1000 + OCCUPANT_AFTER_MS)),
              LEVEL_OCCUPANT);
}

static void test_empty_seat_while_armed_restarts_dwell() {
  AlertState s;
  alertInit(s);
  alertStep(s, carOff(true, COOL_F, 0));
  alertStep(s, carOff(false, COOL_F, OCCUPANT_AFTER_MS - 2000));
  alertStep(s, carOff(true, COOL_F, OCCUPANT_AFTER_MS - 1000));
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, OCCUPANT_AFTER_MS)), LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, 2 * OCCUPANT_AFTER_MS - 1000)),
              LEVEL_OCCUPANT);
}

static void test_dwell_survives_millis_wraparound() {
  AlertState s;
  uint32_t start = 0xFFFFFFFFUL - 5000;
  reachOccupant(s, start);
  CHECK_LEVEL(s.level, LEVEL_OCCUPANT);
}

static void test_heat_without_occupant_does_not_alarm() {
  AlertState s;
  alertInit(s);
  CHECK_LEVEL(alertStep(s, carOff(false, 120.0f, 0)), LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOff(false, 120.0f, 10 * OCCUPANT_AFTER_MS)),
              LEVEL_ARMED);
}

static void test_occupant_to_warning_to_emergency() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOff(true, WARNING_TEMP_F - 0.1f, t += 2000)),
              LEVEL_OCCUPANT);
  CHECK_LEVEL(alertStep(s, carOff(true, WARNING_TEMP_F, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOff(true, EMERGENCY_TEMP_F - 0.1f, t += 2000)),
              LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOff(true, EMERGENCY_TEMP_F, t += 2000)),
              LEVEL_EMERGENCY);
}

static void test_occupant_jumps_straight_to_emergency() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOff(true, EMERGENCY_TEMP_F + 5.0f, t + 2000)),
              LEVEL_EMERGENCY);
}

static void test_nan_temperature_does_not_raise() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOff(true, NAN, t + 2000)), LEVEL_OCCUPANT);
}

static void test_warning_stays_when_cooling_or_seat_empty() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  alertStep(s, carOff(true, WARNING_TEMP_F + 1.0f, t += 2000));
  CHECK_LEVEL(alertStep(s, carOff(true, COOL_F, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, t += 600000)), LEVEL_WARNING);
}

static void test_emergency_stays_when_cooling_or_seat_empty() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  alertStep(s, carOff(true, EMERGENCY_TEMP_F + 1.0f, t += 2000));
  CHECK_LEVEL(alertStep(s, carOff(true, WARNING_TEMP_F, t += 2000)), LEVEL_EMERGENCY);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, t += 2000)), LEVEL_EMERGENCY);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, t += 600000)), LEVEL_EMERGENCY);
}

static void test_occupant_stays_when_seat_empty() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOff(false, COOL_F, t + 2000)), LEVEL_OCCUPANT);
}

static void test_cancel_returns_to_armed_from_every_alarm_level() {
  for (int target = LEVEL_OCCUPANT; target <= LEVEL_EMERGENCY; target++) {
    AlertState s;
    uint32_t t = reachOccupant(s);
    float hot = target == LEVEL_EMERGENCY ? EMERGENCY_TEMP_F
              : target == LEVEL_WARNING   ? WARNING_TEMP_F
                                          : COOL_F;
    CHECK_LEVEL(alertStep(s, carOff(true, hot, t += 2000)), (AlertLevel)target);
    AlertInputs in = carOff(true, hot, t += 2000);
    in.cancelPressed = true;
    CHECK_LEVEL(alertStep(s, in), LEVEL_ARMED);
  }
}

static void test_after_cancel_occupied_seat_needs_full_dwell_again() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  alertStep(s, carOff(true, EMERGENCY_TEMP_F, t += 2000));
  AlertInputs in = carOff(true, EMERGENCY_TEMP_F, t += 2000);
  in.cancelPressed = true;
  alertStep(s, in);
  CHECK_LEVEL(alertStep(s, carOff(true, EMERGENCY_TEMP_F, t += 2000)), LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOff(true, EMERGENCY_TEMP_F, t + OCCUPANT_AFTER_MS)),
              LEVEL_EMERGENCY);
}

static void test_ignition_on_returns_to_idle_from_every_level() {
  for (int target = LEVEL_ARMED; target <= LEVEL_EMERGENCY; target++) {
    AlertState s;
    uint32_t t = 0;
    if (target == LEVEL_ARMED) {
      alertInit(s);
      alertStep(s, carOff(false, COOL_F, t));
    } else {
      t = reachOccupant(s);
      float hot = target == LEVEL_EMERGENCY ? EMERGENCY_TEMP_F
                : target == LEVEL_WARNING   ? WARNING_TEMP_F
                                            : COOL_F;
      alertStep(s, carOff(true, hot, t += 2000));
    }
    CHECK_LEVEL(s.level, (AlertLevel)target);
    AlertInputs in = carOff(true, EMERGENCY_TEMP_F, t += 2000);
    in.ignitionOn = true;
    CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
  }
}

static void test_ignition_beats_cancel() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  AlertInputs in = carOff(true, COOL_F, t + 2000);
  in.ignitionOn = true;
  in.cancelPressed = true;
  CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
}

// ---------------------------------------------------------------------------

int main() {
  test_seat_constants_match_doc();
  test_seat_flip_with_literals();
  test_seat_baseline_is_mean_not_median();
  test_seat_baseline_is_average_of_samples();
  test_seat_baseline_ignores_failed_samples();
  test_seat_baseline_needs_majority_valid();
  test_seat_median_of_pings();
  test_seat_ping_validity();
  test_seat_empty_stays_empty();
  test_seat_one_noisy_ping_does_not_flip();
  test_seat_short_run_of_drops_does_not_flip();
  test_seat_sustained_drop_flips();
  test_seat_drop_threshold_is_inclusive();
  test_seat_failed_pings_never_flip();
  test_seat_failed_reading_breaks_the_run();
  test_seat_returns_to_empty_symmetrically();
  test_seat_new_baseline_resets_state();
  test_alert_constants_match_doc();
  test_starts_idle_and_ignition_on_stays_idle();
  test_ignition_off_arms();
  test_occupant_needs_seat_occupied_for_dwell();
  test_empty_seat_while_armed_restarts_dwell();
  test_dwell_survives_millis_wraparound();
  test_heat_without_occupant_does_not_alarm();
  test_occupant_to_warning_to_emergency();
  test_occupant_jumps_straight_to_emergency();
  test_nan_temperature_does_not_raise();
  test_warning_stays_when_cooling_or_seat_empty();
  test_emergency_stays_when_cooling_or_seat_empty();
  test_occupant_stays_when_seat_empty();
  test_cancel_returns_to_armed_from_every_alarm_level();
  test_after_cancel_occupied_seat_needs_full_dwell_again();
  test_ignition_on_returns_to_idle_from_every_level();
  test_ignition_beats_cancel();

  printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
