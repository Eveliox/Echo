// Laptop tests for firmware/mega/logic.h. Run with the logic-test row in
// CLAUDE.md "Checks". No framework: add a test function, list it in main().
// Any failed CHECK makes the program exit non-zero.

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

#include "logic.h"
// The ESP8266's line filter is tested here too, so the logic-test row covers
// it; its header is plain C++ like logic.h.
#include "../../esp/line_reader.h"
#include "../../esp/server_url.h"
#include "../../esp/box_token.h"
#include "../../esp/wifi_watchdog.h"
// The template, not the real (git-ignored) secrets.h: pins that its token
// placeholder is one the ESP build refuses.
#include "../../esp/secrets.example.h"

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
  in.minsToDanger = NAN;
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
// Sensor conversions and timing
// ---------------------------------------------------------------------------

static bool near(float a, float b, float tol = 0.01f) { return fabsf(a - b) < tol; }

static void test_timing_constants_match_doc() {
  CHECK(STATUS_PERIOD_MS == 2000UL);
  CHECK(SIM_START_F == 80.0f);
  CHECK(SIM_MIN_F == 60.0f);
  CHECK(SIM_MAX_F == 140.0f);
  CHECK(SIM_MAX_RATE_F_PER_S == 0.5f);
  CHECK(SIM_JOY_DEAD_ZONE == 50);
}

static void test_lm35_conversion() {
  CHECK(near(lm35AdcToF(0.0f), 32.0f));
  // 0.25 V = 25 C = 77 F.
  CHECK(near(lm35AdcToF(0.25f / 5.0f * 1023.0f), 77.0f));
  // 0.40 V = 40 C = 104 F.
  CHECK(near(lm35AdcToF(0.40f / 5.0f * 1023.0f), 104.0f));
}

static void test_sim_dead_zone_holds() {
  CHECK(near(simTempStep(80.0f, 512, 2000), 80.0f));
  CHECK(near(simTempStep(80.0f, 512 + 49, 2000), 80.0f));
  CHECK(near(simTempStep(80.0f, 512 - 49, 2000), 80.0f));
  CHECK(simTempStep(80.0f, 512 + 50, 2000) > 80.0f);
}

static void test_sim_full_push_warms_half_degree_per_second() {
  // Full right (1023) is just under +512 offset; 2 s -> about +1 F.
  CHECK(near(simTempStep(80.0f, 1024, 2000), 81.0f));
  CHECK(near(simTempStep(80.0f, 0, 2000), 79.0f));
  // 80 F to 104 F in about 48 s of full push, stepped every 2 s.
  float f = 80.0f;
  for (int i = 0; i < 24; i++) f = simTempStep(f, 1024, 2000);
  CHECK(near(f, 104.0f));
}

static void test_sim_clamps() {
  CHECK(near(simTempStep(139.9f, 1024, 60000), SIM_MAX_F));
  CHECK(near(simTempStep(60.1f, 0, 60000), SIM_MIN_F));
}

static void test_periodic_first_call_then_every_period() {
  Periodic p;
  periodicInit(p);
  CHECK(periodicDue(p, 5000, STATUS_PERIOD_MS));
  CHECK(!periodicDue(p, 5001, STATUS_PERIOD_MS));
  CHECK(!periodicDue(p, 6999, STATUS_PERIOD_MS));
  CHECK(periodicDue(p, 7000, STATUS_PERIOD_MS));
  // Late by 300 ms: next one is still on the 2 s grid (no drift).
  CHECK(periodicDue(p, 9300, STATUS_PERIOD_MS));
  CHECK(!periodicDue(p, 10999, STATUS_PERIOD_MS));
  CHECK(periodicDue(p, 11000, STATUS_PERIOD_MS));
}

static void test_periodic_resyncs_after_long_stall() {
  Periodic p;
  periodicInit(p);
  CHECK(periodicDue(p, 0, STATUS_PERIOD_MS));
  CHECK(periodicDue(p, 10000, STATUS_PERIOD_MS));
  // No burst of catch-up lines.
  CHECK(!periodicDue(p, 10001, STATUS_PERIOD_MS));
  CHECK(periodicDue(p, 12000, STATUS_PERIOD_MS));
}

static void test_periodic_survives_wraparound() {
  Periodic p;
  periodicInit(p);
  uint32_t t = 0xFFFFFFFFUL - 999;
  CHECK(periodicDue(p, t, STATUS_PERIOD_MS));
  CHECK(!periodicDue(p, t + 1999, STATUS_PERIOD_MS));
  CHECK(periodicDue(p, t + 2000, STATUS_PERIOD_MS));
}

static void test_debounce_ignores_bounce() {
  Debouncer d;
  debounceInit(d, false, 0);
  // Bouncing contact: never steady long enough.
  for (uint32_t t = 1; t < 200; t += 5) CHECK(!debounceUpdate(d, (t / 5) % 2 == 0, t));
}

static void test_debounce_press_and_release() {
  Debouncer d;
  debounceInit(d, false, 0);
  CHECK(!debounceUpdate(d, true, 100));
  CHECK(!debounceUpdate(d, true, 100 + CANCEL_DEBOUNCE_MS - 1));
  CHECK(debounceUpdate(d, true, 100 + CANCEL_DEBOUNCE_MS));
  CHECK(debounceUpdate(d, true, 5000));  // held stays pressed
  CHECK(debounceUpdate(d, false, 6000));
  CHECK(!debounceUpdate(d, false, 6000 + CANCEL_DEBOUNCE_MS));
}

// ---------------------------------------------------------------------------
// Fault indicator, humidity age limit
// ---------------------------------------------------------------------------

// Pins the no-retry decision's consequence: with a failed power-up baseline the
// seat never reads occupied, so the fault code is the only way to notice.
static void test_seat_without_baseline_never_occupied() {
  SeatDetector s;
  seatInit(s);
  CHECK(!feed(s, OCCUPIED_CM, 10));
  CHECK(!s.hasBaseline);
}

static void test_fault_active_only_without_baseline() {
  SeatDetector none;
  seatInit(none);
  SeatDetector ok = seatWithBaseline(EMPTY_CM);
  CHECK(seatFaultActive(none, LEVEL_IDLE));
  CHECK(seatFaultActive(none, LEVEL_ARMED));
  CHECK(!seatFaultActive(ok, LEVEL_IDLE));
  CHECK(!seatFaultActive(ok, LEVEL_ARMED));
}

static void test_fault_alarm_levels_win() {
  SeatDetector none;
  seatInit(none);
  CHECK(!seatFaultActive(none, LEVEL_OCCUPANT));
  CHECK(!seatFaultActive(none, LEVEL_WARNING));
  CHECK(!seatFaultActive(none, LEVEL_EMERGENCY));
}

static void test_fault_led_two_short_flashes_per_cycle() {
  uint32_t base = 10 * FAULT_CYCLE_MS;
  CHECK(seatFaultLedOn(base));
  CHECK(seatFaultLedOn(base + FAULT_FLASH_MS - 1));
  CHECK(!seatFaultLedOn(base + FAULT_FLASH_MS));
  CHECK(!seatFaultLedOn(base + FAULT_SECOND_FLASH_AT_MS - 1));
  CHECK(seatFaultLedOn(base + FAULT_SECOND_FLASH_AT_MS));
  CHECK(!seatFaultLedOn(base + FAULT_SECOND_FLASH_AT_MS + FAULT_FLASH_MS));
  CHECK(!seatFaultLedOn(base + FAULT_CYCLE_MS - 1));
  CHECK(seatFaultLedOn(base + FAULT_CYCLE_MS));
  // Mostly dark: lit 2 x FAULT_FLASH_MS per cycle, so it reads as a code,
  // not as a steady or evenly blinking level color.
  uint32_t lit = 0;
  for (uint32_t t = 0; t < FAULT_CYCLE_MS; t++) lit += seatFaultLedOn(base + t) ? 1 : 0;
  CHECK(lit == 2 * FAULT_FLASH_MS);
}

static void test_humidity_starts_invalid() {
  HumidityHold h;
  humidityInit(h);
  float v = -1.0f;
  CHECK(!humidityCurrent(h, 0, v));
  CHECK(v == -1.0f);
}

static void test_humidity_repeats_last_good_until_age_limit() {
  HumidityHold h;
  humidityInit(h);
  humidityUpdate(h, 41.0f, 1000);
  float v = 0.0f;
  CHECK(humidityCurrent(h, 1000, v) && v == 41.0f);
  humidityUpdate(h, NAN, 3000);  // failed read keeps the old value
  CHECK(humidityCurrent(h, 1000 + HUMIDITY_MAX_AGE_MS, v) && v == 41.0f);
  CHECK(!humidityCurrent(h, 1000 + HUMIDITY_MAX_AGE_MS + 1, v));
  // Expired stays expired, even back at an earlier-looking time.
  CHECK(!humidityCurrent(h, 1000, v));
  // A new good reading is valid again.
  humidityUpdate(h, 55.0f, 50000);
  CHECK(humidityCurrent(h, 50000, v) && v == 55.0f);
}

static void test_humidity_ignores_out_of_range() {
  HumidityHold h;
  humidityInit(h);
  float v = 0.0f;
  humidityUpdate(h, -1.0f, 0);
  humidityUpdate(h, 100.5f, 0);
  humidityUpdate(h, INFINITY, 0);
  CHECK(!humidityCurrent(h, 0, v));
  humidityUpdate(h, 0.0f, 0);
  CHECK(humidityCurrent(h, 0, v) && v == 0.0f);
  humidityUpdate(h, 100.0f, 0);
  CHECK(humidityCurrent(h, 0, v) && v == 100.0f);
}

static void test_humidity_age_survives_wraparound() {
  HumidityHold h;
  humidityInit(h);
  uint32_t t = 0xFFFFFFFFUL - 999;
  humidityUpdate(h, 40.0f, t);
  float v = 0.0f;
  CHECK(humidityCurrent(h, t + HUMIDITY_MAX_AGE_MS, v) && v == 40.0f);  // wrapped
  CHECK(!humidityCurrent(h, t + HUMIDITY_MAX_AGE_MS + 1, v));
}


// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

static StatusFields sampleFields() {
  StatusFields f;
  f.level = LEVEL_WARNING;
  f.tempF = 96.4f;
  f.humidity = 41.0f;
  f.presence = true;
  f.distanceCm = 38.0f;
  f.minsToDanger = NAN;
  f.battery = BATTERY_NULL;
  return f;
}

static void test_status_line_exact_format() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  uint16_t n = statusFormat(buf, sizeof buf, f);
  const char *want =
      "{\"state\":\"WARNING\",\"tempF\":96.4,\"humidity\":41,\"presence\":true,"
      "\"distanceCm\":38,\"motion\":null,\"minsToDanger\":null,\"battery\":null}";
  CHECK(strcmp(buf, want) == 0);
  CHECK(n == strlen(want));
  if (strcmp(buf, want) != 0) printf("  got  %s\n  want %s\n", buf, want);
}

static void test_status_line_has_doc_fields_in_order_without_light() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  statusFormat(buf, sizeof buf, f);
  const char *order[] = {"\"state\":", "\"tempF\":", "\"humidity\":", "\"presence\":",
                         "\"distanceCm\":", "\"motion\":", "\"minsToDanger\":",
                         "\"battery\":"};
  const char *prev = buf;
  for (unsigned i = 0; i < sizeof order / sizeof order[0]; i++) {
    const char *at = strstr(buf, order[i]);
    CHECK(at != NULL && at >= prev);
    if (at) prev = at;
  }
  CHECK(strstr(buf, "light") == NULL);
  CHECK(buf[0] == '{');  // the ESP drops lines that don't start with {
  CHECK(strchr(buf, '\n') == NULL);
}

static void test_status_line_every_state_name() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  const char *names[] = {"IDLE", "ARMED", "OCCUPANT", "WARNING", "EMERGENCY"};
  for (int l = LEVEL_IDLE; l <= LEVEL_EMERGENCY; l++) {
    f.level = (AlertLevel)l;
    CHECK(statusFormat(buf, sizeof buf, f) > 0);
    char want[32];
    snprintf(want, sizeof want, "{\"state\":\"%s\",", names[l]);
    CHECK(strncmp(buf, want, strlen(want)) == 0);
  }
}

static void test_status_line_number_rounding() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  f.tempF = 80.0f;
  f.humidity = 40.6f;
  f.presence = false;
  f.distanceCm = 61.4f;
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"tempF\":80.0,") != NULL);
  CHECK(strstr(buf, "\"humidity\":41,") != NULL);
  CHECK(strstr(buf, "\"presence\":false,") != NULL);
  CHECK(strstr(buf, "\"distanceCm\":61,") != NULL);

  f.tempF = 103.96f;  // rounds up across the decimal
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"tempF\":104.0,") != NULL);

  f.tempF = -3.45f;
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"tempF\":-3.5,") != NULL);

  f.tempF = -0.01f;  // no "-0.0"
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"tempF\":0.0,") != NULL);
}

static void test_status_line_rejects_non_finite_required_numbers() {
  char buf[STATUS_LINE_MAX];
  float bad[] = {NAN, INFINITY, -INFINITY, 1e9f};
  for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) {
    StatusFields f = sampleFields();
    f.tempF = bad[i];
    CHECK(statusFormat(buf, sizeof buf, f) == 0 && buf[0] == '\0');
    f = sampleFields();
    f.humidity = bad[i];
    CHECK(statusFormat(buf, sizeof buf, f) == 0 && buf[0] == '\0');
    f = sampleFields();
    f.distanceCm = bad[i];
    CHECK(statusFormat(buf, sizeof buf, f) == 0 && buf[0] == '\0');
  }
}

static void test_status_line_never_overflows() {
  StatusFields f = sampleFields();
  f.level = LEVEL_EMERGENCY;
  f.tempF = -99999.9f;
  f.humidity = -99999.0f;
  f.distanceCm = -99999.0f;
  char big[STATUS_LINE_MAX];
  uint16_t full = statusFormat(big, sizeof big, f);
  CHECK(full > 0 && full < STATUS_LINE_MAX);

  // Every too-small buffer fails cleanly and writes nothing past cap.
  for (uint16_t cap = 1; cap <= full; cap++) {
    char small[STATUS_LINE_MAX + 4];
    memset(small, 'x', sizeof small);
    CHECK(statusFormat(small, cap, f) == 0);
    CHECK(small[0] == '\0');
    for (uint16_t i = cap; i < sizeof small; i++) CHECK(small[i] == 'x');
  }
  char exact[STATUS_LINE_MAX];
  CHECK(statusFormat(exact, full + 1, f) == full);
}

// ---------------------------------------------------------------------------
// Battery
// ---------------------------------------------------------------------------

// A0 ADC reading for a pack at `packV`, through the diode and the divider,
// written with the doc's literals rather than the header's constants.
static float adcForPack(float packV) { return (packV - 0.7f) / 2.0f / 5.0f * 1023.0f; }

// Pins the doc's empty/full pack voltages and the divider (docs/firmware.md,
// "Power") with literals.
static void test_battery_constants_match_doc() {
  CHECK(BATTERY_EMPTY_V == 7.0f);
  CHECK(BATTERY_FULL_V == 9.0f);
  CHECK(BATTERY_DIVIDER_RATIO == 2.0f);  // 10k over 10k
  CHECK(BATTERY_DIODE_DROP_V == 0.7f);
  CHECK(BATTERY_NO_PACK_V > 0.0f && BATTERY_NO_PACK_V < 7.0f - 1.0f);
  CHECK(ADC_REF_V == 5.0f && ADC_MAX == 1023.0f);
}

static void test_battery_adc_to_pack_volts() {
  // Full ADC scale: 5 V at A0 = 10 V at VIN = 10.7 V at the pack.
  CHECK(near(batteryAdcToPackV(1023.0f), 10.7f));
  // Half scale: 2.5 V at A0 = 5 V at VIN = 5.7 V at the pack.
  CHECK(near(batteryAdcToPackV(511.5f), 5.7f));
  CHECK(near(batteryAdcToPackV(adcForPack(7.0f)), 7.0f));
  CHECK(near(batteryAdcToPackV(adcForPack(9.0f)), 9.0f));
}

static void test_battery_percent_maps_doc_voltages() {
  CHECK(batteryPercent(7.0f) == 0);
  CHECK(batteryPercent(9.0f) == 100);
  CHECK(batteryPercent(8.0f) == 50);
  CHECK(batteryPercent(7.5f) == 25);
  CHECK(batteryPercent(8.76f) == 88);
  CHECK(batteryFromAdc(adcForPack(7.0f)) == 0);
  CHECK(batteryFromAdc(adcForPack(8.0f)) == 50);
  CHECK(batteryFromAdc(adcForPack(9.0f)) == 100);
}

static void test_battery_percent_clamps() {
  CHECK(batteryPercent(6.0f) == 0);   // a weak pack, still connected
  CHECK(batteryPercent(6.99f) == 0);
  CHECK(batteryPercent(9.01f) == 100);
  CHECK(batteryPercent(9.6f) == 100);  // fresh alkalines read above 9 V
  CHECK(batteryPercent(12.0f) == 100);
  CHECK(batteryPercent(INFINITY) == 100);
  CHECK(batteryFromAdc(1023.0f) == 100);  // A0 at the rail
}

static void test_battery_percent_rounds_to_nearest() {
  CHECK(batteryPercent(7.026f) == 1);  // 1.3 %
  CHECK(batteryPercent(7.034f) == 2);  // 1.7 %
  CHECK(batteryPercent(8.986f) == 99);  // 99.3 %
  CHECK(batteryPercent(8.994f) == 100);  // 99.7 %
}

// No pack (laptop USB only): A0 near 0, or VIN back-fed a few volts, must be
// null, never a false "battery empty" 0 %.
static void test_battery_no_pack_is_null() {
  CHECK(batteryFromAdc(0.0f) == BATTERY_NULL);
  CHECK(batteryFromAdc(5.0f) == BATTERY_NULL);
  CHECK(batteryPercent(0.7f) == BATTERY_NULL);
  CHECK(batteryPercent(4.0f) == BATTERY_NULL);
  CHECK(batteryPercent(5.0f) == BATTERY_NULL);  // VIN back-fed to about 4.3 V
  CHECK(batteryPercent(BATTERY_NO_PACK_V - 0.01f) == BATTERY_NULL);
  CHECK(batteryPercent(BATTERY_NO_PACK_V) == 0);  // inclusive: a pack, empty
  CHECK(batteryPercent(NAN) == BATTERY_NULL);
  CHECK(batteryPercent(-INFINITY) == BATTERY_NULL);
  CHECK(batteryFromAdc(adcForPack(4.0f)) == BATTERY_NULL);
}

// BATTERY_DIVIDER_WIRED false: always null, whatever the floating A0 reads.
static void test_battery_status_null_without_divider() {
  float adcs[] = {0.0f, adcForPack(8.0f), 1023.0f};
  for (unsigned i = 0; i < sizeof adcs / sizeof adcs[0]; i++) {
    CHECK(batteryStatus(false, adcs[i]) == BATTERY_NULL);
  }
  CHECK(batteryStatus(true, adcForPack(8.0f)) == 50);
  CHECK(batteryStatus(true, adcForPack(9.0f)) == 100);
  CHECK(batteryStatus(true, 0.0f) == BATTERY_NULL);
}

static void test_status_line_battery_number_or_null() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  f.battery = 88;
  uint16_t n = statusFormat(buf, sizeof buf, f);
  const char *want =
      "{\"state\":\"WARNING\",\"tempF\":96.4,\"humidity\":41,\"presence\":true,"
      "\"distanceCm\":38,\"motion\":null,\"minsToDanger\":null,\"battery\":88}";
  CHECK(strcmp(buf, want) == 0);
  CHECK(n == strlen(want));
  if (strcmp(buf, want) != 0) printf("  got  %s\n  want %s\n", buf, want);

  f.battery = 0;
  CHECK(statusFormat(buf, sizeof buf, f) > 0);
  CHECK(strstr(buf, "\"battery\":0}") != NULL);
  f.battery = 100;
  CHECK(statusFormat(buf, sizeof buf, f) > 0);
  CHECK(strstr(buf, "\"battery\":100}") != NULL);

  int8_t nulls[] = {BATTERY_NULL, -128, 101, 127};
  for (unsigned i = 0; i < sizeof nulls / sizeof nulls[0]; i++) {
    f.battery = nulls[i];
    CHECK(statusFormat(buf, sizeof buf, f) > 0);
    CHECK(strstr(buf, "\"battery\":null}") != NULL);
  }

  // The longest possible line, with a battery number, still fits.
  f.level = LEVEL_EMERGENCY;
  f.tempF = -99999.9f;
  f.humidity = -99999.0f;
  f.distanceCm = -99999.0f;
  f.minsToDanger = 99999.9f;
  f.battery = 100;
  n = statusFormat(buf, sizeof buf, f);
  CHECK(n > 0 && n < STATUS_LINE_MAX);
}

// ---------------------------------------------------------------------------
// Local alarm: LED, buzzer, LCD
// ---------------------------------------------------------------------------

static bool sameColor(RgbColor a, RgbColor b) {
  return a.r == b.r && a.g == b.g && a.b == b.b;
}

// Pins the doc's colors and siren range with literals (docs/firmware.md,
// "Firmware behavior").
static void test_alarm_constants_match_doc() {
  CHECK(RGB_BLUE.r == 0 && RGB_BLUE.g == 0 && RGB_BLUE.b == 255);
  CHECK(RGB_YELLOW.r == 255 && RGB_YELLOW.g == 120 && RGB_YELLOW.b == 0);
  CHECK(RGB_RED.r == 255 && RGB_RED.g == 0 && RGB_RED.b == 0);
  CHECK(CHIRP_PERIOD_MS == 5000UL);
  CHECK(BEEP_PERIOD_MS == 1000UL);
  CHECK(SIREN_LOW_HZ == 600 && SIREN_HIGH_HZ == 1200);
  CHECK(LCD_COLS == 16 && LCD_ROWS == 2);
}

static void test_level_clock_restarts_on_level_change_only() {
  LevelClock c;
  levelClockInit(c, LEVEL_IDLE, 100);
  CHECK(levelClockElapsed(c, 600) == 500);
  levelClockUpdate(c, LEVEL_IDLE, 700);
  CHECK(levelClockElapsed(c, 700) == 600);
  levelClockUpdate(c, LEVEL_ARMED, 1000);
  CHECK(levelClockElapsed(c, 1000) == 0);
  CHECK(levelClockElapsed(c, 1250) == 250);
  // Wraparound.
  levelClockUpdate(c, LEVEL_OCCUPANT, 0xFFFFFF00UL);
  CHECK(levelClockElapsed(c, 0x00000100UL) == 0x200UL);
}

static void test_led_idle_and_warning_solid() {
  for (uint32_t t = 0; t < 3 * LED_BLINK_PERIOD_MS; t += 7) {
    CHECK(sameColor(levelLedColor(LEVEL_IDLE, t), RGB_BLUE));
    CHECK(sameColor(levelLedColor(LEVEL_WARNING, t), RGB_YELLOW));
  }
}

// Blinking level: lit from entry for half of each period, dark the other half,
// and never any other color.
static void checkBlink(AlertLevel level, RgbColor color, uint32_t period) {
  uint32_t lit = 0;
  for (uint32_t t = 0; t < 4 * period; t++) {
    RgbColor c = levelLedColor(level, t);
    CHECK(sameColor(c, color) || sameColor(c, RGB_OFF));
    if (sameColor(c, color)) lit++;
  }
  CHECK(lit == 2 * period);
  CHECK(sameColor(levelLedColor(level, 0), color));
  CHECK(sameColor(levelLedColor(level, period / 2 - 1), color));
  CHECK(sameColor(levelLedColor(level, period / 2), RGB_OFF));
  CHECK(sameColor(levelLedColor(level, period - 1), RGB_OFF));
  CHECK(sameColor(levelLedColor(level, period), color));
}

static void test_led_blinks_and_flashes() {
  checkBlink(LEVEL_ARMED, RGB_BLUE, LED_BLINK_PERIOD_MS);
  checkBlink(LEVEL_OCCUPANT, RGB_YELLOW, LED_BLINK_PERIOD_MS);
  checkBlink(LEVEL_EMERGENCY, RGB_RED, LED_FLASH_PERIOD_MS);
  // "Flashing" reads faster than "blinking".
  CHECK(LED_FLASH_PERIOD_MS < LED_BLINK_PERIOD_MS);
}

static void test_led_fault_code_replaces_idle_and_armed_only() {
  SeatDetector noBase;
  seatInit(noBase);
  uint32_t base = 10 * FAULT_CYCLE_MS;
  AlertLevel low[] = {LEVEL_IDLE, LEVEL_ARMED};
  for (unsigned i = 0; i < 2; i++) {
    for (uint32_t t = 0; t < FAULT_CYCLE_MS; t++) {
      RgbColor c = alarmLedColor(noBase, low[i], t, base + t);
      // Exactly the old fault code: magenta when seatFaultLedOn, else dark.
      CHECK(sameColor(c, seatFaultLedOn(base + t) ? RGB_FAULT_MAGENTA : RGB_OFF));
    }
  }
  AlertLevel high[] = {LEVEL_OCCUPANT, LEVEL_WARNING, LEVEL_EMERGENCY};
  for (unsigned i = 0; i < 3; i++) {
    for (uint32_t t = 0; t < FAULT_CYCLE_MS; t += 3) {
      CHECK(sameColor(alarmLedColor(noBase, high[i], t, base + t), levelLedColor(high[i], t)));
    }
  }
  // With a baseline the level color always shows.
  SeatDetector ok = seatWithBaseline(EMPTY_CM);
  for (uint32_t t = 0; t < FAULT_CYCLE_MS; t += 3) {
    CHECK(sameColor(alarmLedColor(ok, LEVEL_IDLE, t, base + t), RGB_BLUE));
  }
}

static void test_rgb_common_anode_inverts() {
  CHECK(rgbPinValue(0, false) == 0);
  CHECK(rgbPinValue(120, false) == 120);
  CHECK(rgbPinValue(255, false) == 255);
  CHECK(rgbPinValue(0, true) == 255);
  CHECK(rgbPinValue(120, true) == 135);
  CHECK(rgbPinValue(255, true) == 0);
}

static void test_buzzer_silent_when_idle_or_armed() {
  for (uint32_t t = 0; t < 2 * CHIRP_PERIOD_MS; t++) {
    CHECK(buzzerHz(LEVEL_IDLE, t) == 0);
    CHECK(buzzerHz(LEVEL_ARMED, t) == 0);
  }
}

// One short sound of `hz` at the start of every `period`, silent otherwise.
static void checkPulses(AlertLevel level, uint16_t hz, uint32_t period, uint32_t len) {
  CHECK(len > 0 && len < period / 2);
  uint32_t sounding = 0;
  for (uint32_t t = 0; t < 3 * period; t++) {
    uint16_t f = buzzerHz(level, t);
    CHECK(f == 0 || f == hz);
    if (f != 0) sounding++;
  }
  CHECK(sounding == 3 * len);
  CHECK(buzzerHz(level, 0) == hz);
  CHECK(buzzerHz(level, len - 1) == hz);
  CHECK(buzzerHz(level, len) == 0);
  CHECK(buzzerHz(level, period - 1) == 0);
  CHECK(buzzerHz(level, period) == hz);
}

static void test_buzzer_occupant_chirp_and_warning_beep() {
  checkPulses(LEVEL_OCCUPANT, CHIRP_HZ, CHIRP_PERIOD_MS, CHIRP_MS);
  checkPulses(LEVEL_WARNING, BEEP_HZ, BEEP_PERIOD_MS, BEEP_MS);
}

static void test_buzzer_emergency_siren_sweeps_up_and_down() {
  CHECK(buzzerHz(LEVEL_EMERGENCY, 0) == 600);
  CHECK(buzzerHz(LEVEL_EMERGENCY, SIREN_PERIOD_MS / 2) == 1200);
  CHECK(buzzerHz(LEVEL_EMERGENCY, SIREN_PERIOD_MS) == 600);
  uint16_t prev = buzzerHz(LEVEL_EMERGENCY, 0);
  for (uint32_t t = 1; t < 3 * SIREN_PERIOD_MS; t++) {
    uint16_t f = buzzerHz(LEVEL_EMERGENCY, t);
    CHECK(f >= SIREN_LOW_HZ && f <= SIREN_HIGH_HZ);  // never silent
    uint32_t phase = t % SIREN_PERIOD_MS;
    if (phase == 0) {
      CHECK(f <= prev);
    } else if (phase <= SIREN_PERIOD_MS / 2) {
      CHECK(f >= prev);  // rising
    } else {
      CHECK(f <= prev);  // falling
    }
    // Changes only on a step boundary, and smoothly.
    if (t % SIREN_STEP_MS != 0) CHECK(f == prev);
    CHECK(f - prev <= 20 && prev - f <= 20);
    prev = f;
  }
}

static void test_lcd_line1_level_and_temp() {
  char line[LCD_LINE_BUF];
  lcdLine1(line, LEVEL_WARNING, 96.4f);
  CHECK(strcmp(line, "WARNING    96.4F") == 0);
  lcdLine1(line, LEVEL_EMERGENCY, 104.0f);
  CHECK(strcmp(line, "EMERGENCY 104.0F") == 0);
  lcdLine1(line, LEVEL_IDLE, 80.0f);
  CHECK(strcmp(line, "IDLE       80.0F") == 0);
  lcdLine1(line, LEVEL_ARMED, 79.96f);
  CHECK(strcmp(line, "ARMED      80.0F") == 0);
  lcdLine1(line, LEVEL_OCCUPANT, -5.04f);
  CHECK(strcmp(line, "OCCUPANT   -5.0F") == 0);
  lcdLine1(line, LEVEL_OCCUPANT, NAN);
  CHECK(strcmp(line, "OCCUPANT   --.-F") == 0);
}

// Every combination is exactly 16 characters, so overwriting needs no clear.
static void test_lcd_lines_always_exactly_16_chars() {
  float temps[] = {-1e9f, -100.0f, -99.9f, 0.0f, 9.9f, 99.9f, 140.0f, 999.9f, 1000.0f, NAN, INFINITY};
  float mins[] = {NAN, -1.0f, 0.0f, 2.1f, 99.99f, 999.9f, 999.95f, 1e9f, INFINITY};
  AlertLevel levels[] = {LEVEL_IDLE, LEVEL_ARMED, LEVEL_OCCUPANT, LEVEL_WARNING, LEVEL_EMERGENCY};
  for (unsigned l = 0; l < 5; l++) {
    for (unsigned i = 0; i < sizeof temps / sizeof temps[0]; i++) {
      char buf[LCD_LINE_BUF + 4];
      memset(buf, 'x', sizeof buf);
      lcdLine1(buf, levels[l], temps[i]);
      CHECK(strlen(buf) == LCD_COLS);
      CHECK(strncmp(buf, alertLevelName(levels[l]), strlen(alertLevelName(levels[l]))) == 0);
      for (unsigned k = LCD_LINE_BUF; k < sizeof buf; k++) CHECK(buf[k] == 'x');
    }
    for (unsigned i = 0; i < sizeof mins / sizeof mins[0]; i++) {
      for (int sim = 0; sim < 2; sim++) {
        for (uint32_t now = 0; now < SIM_LCD_PERIOD_MS; now += SIM_LCD_PERIOD_MS / 4) {
          char buf[LCD_LINE_BUF + 4];
          memset(buf, 'x', sizeof buf);
          lcdLine2(buf, levels[l], mins[i], sim == 1, now);
          CHECK(strlen(buf) == LCD_COLS);
          for (unsigned k = LCD_LINE_BUF; k < sizeof buf; k++) CHECK(buf[k] == 'x');
        }
      }
    }
  }
}

static void test_lcd_line2_per_level() {
  char line[LCD_LINE_BUF];
  lcdLine2(line, LEVEL_IDLE, NAN, false, 0);
  CHECK(strcmp(line, "CAR ON          ") == 0);
  lcdLine2(line, LEVEL_ARMED, NAN, false, 0);
  CHECK(strcmp(line, "SEAT EMPTY      ") == 0);
  lcdLine2(line, LEVEL_OCCUPANT, 7.5f, false, 0);
  CHECK(strcmp(line, "SEAT OCCUPIED   ") == 0);
  lcdLine2(line, LEVEL_WARNING, 7.5f, false, 0);
  CHECK(strcmp(line, "DANGER IN 7.5m  ") == 0);
  lcdLine2(line, LEVEL_EMERGENCY, 2.1f, false, 0);
  CHECK(strcmp(line, "DANGER IN 2.1m  ") == 0);
  lcdLine2(line, LEVEL_EMERGENCY, 0.0f, false, 0);
  CHECK(strcmp(line, "DANGER IN 0.0m  ") == 0);
  lcdLine2(line, LEVEL_WARNING, 123.44f, false, 0);
  CHECK(strcmp(line, "DANGER IN 123.4m") == 0);
}

// Unknown minutes to danger (null) shows a placeholder.
static void test_lcd_line2_unknown_and_huge_minutes() {
  char line[LCD_LINE_BUF];
  lcdLine2(line, LEVEL_WARNING, NAN, false, 0);
  CHECK(strcmp(line, "DANGER IN --.-m ") == 0);
  lcdLine2(line, LEVEL_EMERGENCY, -0.5f, false, 0);
  CHECK(strcmp(line, "DANGER IN --.-m ") == 0);
  lcdLine2(line, LEVEL_WARNING, 999.94f, false, 0);
  CHECK(strcmp(line, "DANGER IN 999.9m") == 0);
  lcdLine2(line, LEVEL_WARNING, 999.95f, false, 0);
  CHECK(strcmp(line, "DANGER IN >999m ") == 0);
  lcdLine2(line, LEVEL_WARNING, INFINITY, false, 0);
  CHECK(strcmp(line, "DANGER IN >999m ") == 0);
}

static void test_lcd_shows_sim_when_simulating() {
  char line[LCD_LINE_BUF];
  uint32_t half = SIM_LCD_PERIOD_MS / 2;
  AlertLevel levels[] = {LEVEL_IDLE, LEVEL_ARMED, LEVEL_OCCUPANT, LEVEL_WARNING, LEVEL_EMERGENCY};
  for (unsigned l = 0; l < 5; l++) {
    // Simulating: SIM shows in the second half of every cycle.
    lcdLine2(line, levels[l], 2.1f, true, 5 * SIM_LCD_PERIOD_MS + half);
    CHECK(strcmp(line, "SIMULATED TEMP  ") == 0);
    lcdLine2(line, levels[l], 2.1f, true, 5 * SIM_LCD_PERIOD_MS + SIM_LCD_PERIOD_MS - 1);
    CHECK(strstr(line, "SIM") != NULL);
    // The level text still shows in the first half.
    lcdLine2(line, levels[l], 2.1f, true, 5 * SIM_LCD_PERIOD_MS + half - 1);
    char plain[LCD_LINE_BUF];
    lcdLine2(plain, levels[l], 2.1f, false, 0);
    CHECK(strcmp(line, plain) == 0);
    // Not simulating: never SIM.
    for (uint32_t t = 0; t < 2 * SIM_LCD_PERIOD_MS; t += 50) {
      lcdLine2(line, levels[l], 2.1f, false, t);
      CHECK(strstr(line, "SIM") == NULL);
    }
  }
  // SIM is on screen for a good share of the time, not a brief blip.
  CHECK(half >= 1000UL);
}


// ---------------------------------------------------------------------------
// Minutes to danger
// ---------------------------------------------------------------------------

// Pins the values in docs/firmware.md "Minutes to danger" and the level table
// with literals.
static void test_mins_constants_match_doc() {
  CHECK(MINS_TO_DANGER_SAMPLES == 60);
  CHECK(DANGER_TEMP_F == 104.0f);
  CHECK(MIN_WARMING_RATE_F_PER_MIN == 0.05f);
  CHECK(WARNING_MINS == 10.0f);
  CHECK(EMERGENCY_MINS == 5.0f);
  // 60 samples, one per status period, is the doc's 2 minutes.
  CHECK(MINS_TO_DANGER_SAMPLES * STATUS_PERIOD_MS == 120000UL);
}

// Adds `n` samples every 2 s from `startMs`: first + i * stepF.
static uint32_t addRamp(TempHistory &h, uint32_t startMs, float first, float stepF, int n) {
  uint32_t t = startMs;
  for (int i = 0; i < n; i++, t += 2000) tempHistoryAdd(h, first + i * stepF, t);
  return t;
}

static void test_mins_null_until_two_minutes_of_samples() {
  TempHistory h;
  tempHistoryInit(h);
  // 0.1 F every 2 s = 3 F per minute.
  addRamp(h, 0, 80.0f, 0.1f, 59);
  CHECK(isnan(tempHistoryRateFPerMin(h)));
  CHECK(isnan(tempHistoryMinsToDanger(h, 85.8f)));
  tempHistoryAdd(h, 85.9f, 59 * 2000);
  CHECK(near(tempHistoryRateFPerMin(h), 3.0f, 0.001f));
  // (104 - 85.9) / 3 = 6.033..., rounded to 0.1.
  CHECK(near(tempHistoryMinsToDanger(h, 85.9f), 6.0f, 0.0001f));
}

static void test_mins_doc_formula_with_literals() {
  TempHistory h;
  tempHistoryInit(h);
  // 1 F every 2 s = 30 F per minute; (104 - 95) / 30 = 0.3.
  addRamp(h, 0, 36.0f, 1.0f, 60);
  CHECK(near(tempHistoryRateFPerMin(h), 30.0f, 0.01f));
  CHECK(near(tempHistoryMinsToDanger(h, 95.0f), 0.3f, 0.0001f));
  // 0.06 F per minute from 80 F: (104 - 80) / 0.06 = 400.
  tempHistoryInit(h);
  addRamp(h, 0, 79.9410f, 0.002f, 60);
  CHECK(near(tempHistoryRateFPerMin(h), 0.06f, 0.0005f));
  float m = tempHistoryMinsToDanger(h, 80.0f);
  CHECK(m > 395.0f && m < 405.0f);
  // Always a multiple of 0.1 (what the status line and LCD show).
  CHECK(near(m * 10.0f, floorf(m * 10.0f + 0.5f), 0.01f));
}

static void test_mins_null_below_minimum_rate() {
  TempHistory h;
  // Flat.
  tempHistoryInit(h);
  addRamp(h, 0, 90.0f, 0.0f, 60);
  CHECK(isnan(tempHistoryMinsToDanger(h, 90.0f)));
  // 0.04 F per minute: below 0.05.
  tempHistoryInit(h);
  addRamp(h, 0, 90.0f, 0.04f / 30.0f, 60);
  CHECK(isnan(tempHistoryMinsToDanger(h, 90.0f)));
  // Cooling.
  tempHistoryInit(h);
  addRamp(h, 0, 100.0f, -0.5f, 60);
  CHECK(isnan(tempHistoryMinsToDanger(h, 70.5f)));
  // 0.06 F per minute: above 0.05, so a number.
  tempHistoryInit(h);
  addRamp(h, 0, 90.0f, 0.06f / 30.0f, 60);
  CHECK(tempHistoryMinsToDanger(h, 90.0f) > 0.0f);
}

static void test_mins_zero_at_or_above_danger_temp() {
  TempHistory h;
  tempHistoryInit(h);
  // No samples at all, or a flat or cooling cabin: still 0 at 104 F and up.
  CHECK(tempHistoryMinsToDanger(h, 104.0f) == 0.0f);
  CHECK(tempHistoryMinsToDanger(h, 120.0f) == 0.0f);
  addRamp(h, 0, 110.0f, -0.1f, 60);
  CHECK(tempHistoryMinsToDanger(h, 104.0f) == 0.0f);
  CHECK(isnan(tempHistoryMinsToDanger(h, 103.9f)));
  CHECK(isnan(tempHistoryMinsToDanger(h, NAN)));
}

static void test_mins_skips_nan_samples() {
  TempHistory clean, gappy;
  tempHistoryInit(clean);
  tempHistoryInit(gappy);
  addRamp(clean, 0, 80.0f, 0.1f, 60);
  uint32_t t = 0;
  for (int i = 0; i < 60; i++, t += 2000) {
    tempHistoryAdd(gappy, NAN, t + 1000);
    tempHistoryAdd(gappy, INFINITY, t + 1000);
    tempHistoryAdd(gappy, 80.0f + i * 0.1f, t);
  }
  CHECK(gappy.count == MINS_TO_DANGER_SAMPLES);
  CHECK(tempHistoryMinsToDanger(gappy, 85.9f) == tempHistoryMinsToDanger(clean, 85.9f));
  // Only NaN readings: never enough samples.
  TempHistory none;
  tempHistoryInit(none);
  for (int i = 0; i < 200; i++) tempHistoryAdd(none, NAN, i * 2000);
  CHECK(none.count == 0);
  CHECK(isnan(tempHistoryMinsToDanger(none, 90.0f)));
}

static void test_mins_window_is_the_last_60_samples() {
  TempHistory h;
  tempHistoryInit(h);
  uint32_t t = addRamp(h, 0, 70.0f, 0.0f, 100);  // old flat readings
  addRamp(h, t, 80.0f, 0.1f, 60);
  CHECK(near(tempHistoryRateFPerMin(h), 3.0f, 0.001f));
  CHECK(near(tempHistoryMinsToDanger(h, 85.9f), 6.0f, 0.0001f));
}

static void test_mins_uses_sample_times_and_survives_wraparound() {
  // Uneven spacing, temperature linear in time at 3 F per minute.
  TempHistory h;
  tempHistoryInit(h);
  uint32_t t = 0xFFFFFFFFUL - 30000;  // wraps partway through
  for (int i = 0; i < 60; i++) {
    uint32_t dt = (i % 3 == 0) ? 3000 : 1500;
    t += dt;
    tempHistoryAdd(h, 80.0f + (uint32_t)(t - (0xFFFFFFFFUL - 30000)) / 20000.0f, t);
  }
  CHECK(near(tempHistoryRateFPerMin(h), 3.0f, 0.001f));
  // Every sample at the same time: no line, so null.
  TempHistory same;
  tempHistoryInit(same);
  for (int i = 0; i < 60; i++) tempHistoryAdd(same, 80.0f + i, 5000);
  CHECK(isnan(tempHistoryMinsToDanger(same, 90.0f)));
}

static AlertInputs carOffMins(float tempF, float mins, uint32_t nowMs) {
  AlertInputs in = carOff(true, tempF, nowMs);
  in.minsToDanger = mins;
  return in;
}

static void test_mins_raise_warning_and_emergency_from_occupant() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 10.1f, t += 2000)), LEVEL_OCCUPANT);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 10.0f, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 5.1f, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 5.0f, t += 2000)), LEVEL_EMERGENCY);

  // Straight from OCCUPANT to EMERGENCY.
  t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 2.1f, t += 2000)), LEVEL_EMERGENCY);
  t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 0.0f, t += 2000)), LEVEL_EMERGENCY);
}

static void test_mins_null_or_negative_never_raises() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, NAN, t += 2000)), LEVEL_OCCUPANT);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, -1.0f, t += 2000)), LEVEL_OCCUPANT);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, -INFINITY, t += 2000)), LEVEL_OCCUPANT);
}

static void test_mins_only_from_occupant_up() {
  AlertState s;
  alertInit(s);
  AlertInputs in = carOffMins(COOL_F, 1.0f, 0);
  in.ignitionOn = true;
  CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
  // Armed, seat empty or not yet held long enough: minutes don't matter.
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 1.0f, 2000)), LEVEL_ARMED);
  AlertInputs empty = carOffMins(COOL_F, 0.0f, 4000);
  empty.seatOccupied = false;
  CHECK_LEVEL(alertStep(s, empty), LEVEL_ARMED);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 1.0f, 6000)), LEVEL_ARMED);
  // Once the hold is done, the same step goes straight up.
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 1.0f, 6000 + OCCUPANT_AFTER_MS)),
              LEVEL_EMERGENCY);
}

static void test_mins_levels_still_only_climb() {
  AlertState s;
  uint32_t t = reachOccupant(s);
  alertStep(s, carOffMins(COOL_F, 8.0f, t += 2000));
  CHECK_LEVEL(s.level, LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, NAN, t += 2000)), LEVEL_WARNING);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 60.0f, t += 2000)), LEVEL_WARNING);
  alertStep(s, carOffMins(COOL_F, 4.0f, t += 2000));
  CHECK_LEVEL(s.level, LEVEL_EMERGENCY);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, NAN, t += 2000)), LEVEL_EMERGENCY);
  CHECK_LEVEL(alertStep(s, carOffMins(COOL_F, 60.0f, t += 2000)), LEVEL_EMERGENCY);
  // Cancel and ignition still clear it.
  AlertInputs in = carOffMins(COOL_F, 1.0f, t += 2000);
  in.cancelPressed = true;
  CHECK_LEVEL(alertStep(s, in), LEVEL_ARMED);
  in.cancelPressed = false;
  in.ignitionOn = true;
  CHECK_LEVEL(alertStep(s, in), LEVEL_IDLE);
}

// The box end to end: two minutes of flat readings, the seat held, then a
// hair-dryer ramp. WARNING and EMERGENCY start on whichever condition comes
// first, here the minutes, well below 95 F.
static void test_mins_box_run_starts_alarm_on_first_condition() {
  TempHistory h;
  tempHistoryInit(h);
  AlertState s;
  alertInit(s);
  uint32_t t = 0;
  float temp = 80.0f;
  int warningAt = -1, emergencyAt = -1;
  float warningTemp = 0.0f, emergencyTemp = 0.0f;
  for (int i = 0; i < 120; i++, t += 2000) {
    bool seated = i >= 60;
    if (i >= 76) temp += 1.2f;  // 36 F per minute
    tempHistoryAdd(h, temp, t);
    float mins = tempHistoryMinsToDanger(h, temp);
    // Null or >= 0, and 0 at or above the danger temperature.
    CHECK(isnan(mins) || mins >= 0.0f);
    if (temp >= DANGER_TEMP_F) CHECK(mins == 0.0f);
    if (i < 59) CHECK(isnan(mins));
    AlertInputs in = carOff(seated, temp, t);
    in.minsToDanger = mins;
    AlertLevel before = s.level;
    alertStep(s, in);
    bool warnCond = temp >= WARNING_TEMP_F || (mins >= 0.0f && mins <= WARNING_MINS);
    bool emerCond = temp >= EMERGENCY_TEMP_F || (mins >= 0.0f && mins <= EMERGENCY_MINS);
    if (before >= LEVEL_OCCUPANT && before < LEVEL_WARNING) {
      // The first step that meets a condition is the one that climbs.
      CHECK((s.level >= LEVEL_WARNING) == (warnCond || emerCond));
    }
    if (before >= LEVEL_OCCUPANT && before < LEVEL_EMERGENCY) {
      CHECK((s.level == LEVEL_EMERGENCY) == emerCond);
    }
    if (warningAt < 0 && s.level >= LEVEL_WARNING) { warningAt = i; warningTemp = temp; }
    if (emergencyAt < 0 && s.level == LEVEL_EMERGENCY) { emergencyAt = i; emergencyTemp = temp; }
  }
  CHECK(warningAt > 0 && emergencyAt > warningAt);
  CHECK(warningTemp < WARNING_TEMP_F);
  CHECK(emergencyTemp < EMERGENCY_TEMP_F);
  CHECK_LEVEL(s.level, LEVEL_EMERGENCY);
}

static void test_status_line_mins_to_danger_number_or_null() {
  char buf[STATUS_LINE_MAX];
  StatusFields f = sampleFields();
  f.minsToDanger = 7.5f;
  uint16_t n = statusFormat(buf, sizeof buf, f);
  // The doc's example line, without the pending `light` and the unwired fields.
  const char *want =
      "{\"state\":\"WARNING\",\"tempF\":96.4,\"humidity\":41,\"presence\":true,"
      "\"distanceCm\":38,\"motion\":null,\"minsToDanger\":7.5,\"battery\":null}";
  CHECK(strcmp(buf, want) == 0);
  CHECK(n == strlen(want));
  if (strcmp(buf, want) != 0) printf("  got  %s\n  want %s\n", buf, want);

  f.minsToDanger = 0.0f;
  CHECK(statusFormat(buf, sizeof buf, f) > 0);
  CHECK(strstr(buf, "\"minsToDanger\":0.0,") != NULL);
  f.minsToDanger = 6.0333f;
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"minsToDanger\":6.0,") != NULL);
  f.minsToDanger = 412.3f;
  statusFormat(buf, sizeof buf, f);
  CHECK(strstr(buf, "\"minsToDanger\":412.3,") != NULL);

  // Unknown or unwritable: null, and the line is still sent.
  float nulls[] = {NAN, -0.1f, -INFINITY, INFINITY, 1e9f};
  for (unsigned i = 0; i < sizeof nulls / sizeof nulls[0]; i++) {
    f.minsToDanger = nulls[i];
    CHECK(statusFormat(buf, sizeof buf, f) > 0);
    CHECK(strstr(buf, "\"minsToDanger\":null,") != NULL);
  }

  // The longest possible line still fits.
  f.level = LEVEL_EMERGENCY;
  f.tempF = -99999.9f;
  f.humidity = -99999.0f;
  f.distanceCm = -99999.0f;
  f.minsToDanger = 99999.9f;
  n = statusFormat(buf, sizeof buf, f);
  CHECK(n > 0 && n < STATUS_LINE_MAX);
}

static void test_lcd_line2_shows_computed_minutes() {
  TempHistory h;
  tempHistoryInit(h);
  addRamp(h, 0, 80.0f, 0.1f, 60);
  char line[LCD_LINE_BUF];
  lcdLine2(line, LEVEL_WARNING, tempHistoryMinsToDanger(h, 85.9f), false, 0);
  CHECK(strcmp(line, "DANGER IN 6.0m  ") == 0);
  lcdLine2(line, LEVEL_EMERGENCY, tempHistoryMinsToDanger(h, 104.0f), false, 0);
  CHECK(strcmp(line, "DANGER IN 0.0m  ") == 0);
}

// The smoke check's synthetic recording, replayed through this file's box
// code: one temperature sample and one alertStep per line, 2 s apart (IDLE
// lines mean the ignition is in). Every line's minsToDanger and state must be
// exactly what the box would send. The path is relative to this file, so
// logic-test must run from the repo root (as the Checks row does).
static void test_recording_matches_box_logic() {
  char path[512];
  const char *self = __FILE__;
  const char *slash = strrchr(self, '/');
  int dirLen = slash ? (int)(slash - self) : 0;
  snprintf(path, sizeof path, "%.*s%s../../../simulator/recordings/synthetic-ignition-off-to-emergency.jsonl",
           dirLen, self, slash ? "/" : "");
  FILE *f = fopen(path, "r");
  CHECK(f != NULL);
  if (!f) {
    printf("  could not open %s\n", path);
    return;
  }
  TempHistory h;
  tempHistoryInit(h);
  AlertState s;
  alertInit(s);
  char line[512];
  int n = 0, numbers = 0, early = 0;
  while (fgets(line, sizeof line, f)) {
    if (line[0] != '{') continue;
    const char *st = strstr(line, "\"state\":\"");
    const char *tf = strstr(line, "\"tempF\":");
    const char *pr = strstr(line, "\"presence\":");
    const char *md = strstr(line, "\"minsToDanger\":");
    CHECK(st && tf && pr && md);
    if (!(st && tf && pr && md)) break;
    st += strlen("\"state\":\"");
    float temp = strtof(tf + strlen("\"tempF\":"), NULL);
    uint32_t now = (uint32_t)n * STATUS_PERIOD_MS;

    tempHistoryAdd(h, temp, now);
    float mins = tempHistoryMinsToDanger(h, temp);
    AlertInputs in = carOff(strncmp(pr + strlen("\"presence\":"), "true", 4) == 0, temp, now);
    in.ignitionOn = strncmp(st, "IDLE\"", 5) == 0;
    in.minsToDanger = mins;
    AlertLevel level = alertStep(s, in);

    char want[16];
    StrBuf b = {want, sizeof want, 0, true};
    if (isnan(mins)) {
      sbPuts(b, "null");
    } else {
      sbPutFixed1(b, mins);
      numbers++;
    }
    want[b.len] = '\0';
    const char *got = md + strlen("\"minsToDanger\":");
    bool sameMins = strncmp(got, want, b.len) == 0 && (got[b.len] == ',' || got[b.len] == '}');
    const char *name = alertLevelName(level);
    bool sameState = strncmp(st, name, strlen(name)) == 0 && st[strlen(name)] == '"';
    CHECK(sameMins);
    CHECK(sameState);
    if (!sameMins || !sameState) printf("  recording line %d: box sends %s, minsToDanger %s\n", n + 1, name, want);
    if (level >= LEVEL_WARNING && temp < WARNING_TEMP_F) early++;
    n++;
  }
  fclose(f);
  // The recording exercises numbers and minutes-started alarms, not only nulls.
  CHECK(n > MINS_TO_DANGER_SAMPLES);
  CHECK(numbers > 0);
  CHECK(early > 0);
}

// ---------------------------------------------------------------------------
// ESP8266 line reader (firmware/esp/line_reader.h)
// ---------------------------------------------------------------------------

// Feeds `bytes` (len bytes, may hold NULs) and counts completed kept lines;
// `last` gets a copy of the last one.
static int feedBytes(LineReader &r, const char *bytes, size_t len, char *last,
                     size_t lastCap) {
  int kept = 0;
  for (size_t i = 0; i < len; i++) {
    if (lineReaderFeed(r, bytes[i])) {
      kept++;
      snprintf(last, lastCap, "%s", r.buf);
    }
  }
  return kept;
}

static int feedStr(LineReader &r, const char *s, char *last, size_t lastCap) {
  return feedBytes(r, s, strlen(s), last, lastCap);
}

static void test_line_reader_keeps_json_line_without_crlf() {
  LineReader r;
  lineReaderInit(r);
  char last[LINE_READER_MAX_LEN + 1] = "";
  const char *line = "{\"state\":\"ARMED\",\"tempF\":80.0}";
  char withCrlf[64];
  snprintf(withCrlf, sizeof withCrlf, "%s\r\n", line);
  CHECK(feedStr(r, withCrlf, last, sizeof last) == 1);
  CHECK(strcmp(last, line) == 0);
  // Bare '\n' works too.
  CHECK(feedStr(r, "{\"a\":1}\n", last, sizeof last) == 1);
  CHECK(strcmp(last, "{\"a\":1}") == 0);
}

static void test_line_reader_returns_true_only_on_newline() {
  LineReader r;
  lineReaderInit(r);
  const char *s = "{\"a\":1}";
  for (size_t i = 0; i < strlen(s); i++) CHECK(!lineReaderFeed(r, s[i]));
  CHECK(!lineReaderFeed(r, '\r'));
  CHECK(lineReaderFeed(r, '\n'));
}

static void test_line_reader_drops_lines_not_starting_with_brace() {
  LineReader r;
  lineReaderInit(r);
  char last[LINE_READER_MAX_LEN + 1] = "";
  CHECK(feedStr(r, "# seat baseline failed: check the ultrasonic\r\n", last, sizeof last) == 0);
  CHECK(feedStr(r, " {\"a\":1}\n", last, sizeof last) == 0);
  CHECK(feedStr(r, "\n\r\n", last, sizeof last) == 0);
  CHECK(feedStr(r, "x{\"a\":1}\n", last, sizeof last) == 0);
  // ESP boot noise: 74880-baud garbage read at 115200, then a real line.
  const char noise[] = {(char)0xF0, (char)0x8C, 'r', (char)0xE2, '\n'};
  CHECK(feedBytes(r, noise, sizeof noise, last, sizeof last) == 0);
  CHECK(feedStr(r, "{\"a\":2}\n", last, sizeof last) == 1);
  CHECK(strcmp(last, "{\"a\":2}") == 0);
}

static void test_line_reader_drops_partial_lines() {
  LineReader r;
  lineReaderInit(r);
  char last[LINE_READER_MAX_LEN + 1] = "";
  // Joined halfway through a line: the tail is dropped, the next line kept.
  CHECK(feedStr(r, "F\":96.4,\"humidity\":41}\r\n{\"a\":3}\r\n", last, sizeof last) == 1);
  CHECK(strcmp(last, "{\"a\":3}") == 0);
  // Cut off before its closing brace.
  CHECK(feedStr(r, "{\"state\":\"WARN\n", last, sizeof last) == 0);
  CHECK(feedStr(r, "{\n", last, sizeof last) == 0);
}

static void test_line_reader_drops_nul_line() {
  LineReader r;
  lineReaderInit(r);
  char last[LINE_READER_MAX_LEN + 1] = "";
  const char withNul[] = {'{', '"', 'a', '\0', '}', '\n'};
  CHECK(feedBytes(r, withNul, sizeof withNul, last, sizeof last) == 0);
  CHECK(feedStr(r, "{\"a\":4}\n", last, sizeof last) == 1);
}

static void test_line_reader_length_cap() {
  char last[LINE_READER_MAX_LEN + 1] = "";
  char line[LINE_READER_MAX_LEN + 8];

  // Exactly the cap: kept whole.
  LineReader r;
  lineReaderInit(r);
  line[0] = '{';
  for (uint16_t i = 1; i < LINE_READER_MAX_LEN - 1; i++) line[i] = 'a';
  line[LINE_READER_MAX_LEN - 1] = '}';
  line[LINE_READER_MAX_LEN] = '\n';
  line[LINE_READER_MAX_LEN + 1] = '\0';
  CHECK(feedStr(r, line, last, sizeof last) == 1);
  CHECK(strlen(last) == LINE_READER_MAX_LEN);

  // One over the cap: dropped whole, never forwarded cut short, and the
  // reader recovers on the next line.
  lineReaderInit(r);
  line[0] = '{';
  for (uint16_t i = 1; i < LINE_READER_MAX_LEN; i++) line[i] = 'a';
  line[LINE_READER_MAX_LEN] = '}';
  line[LINE_READER_MAX_LEN + 1] = '\n';
  line[LINE_READER_MAX_LEN + 2] = '\0';
  last[0] = '\0';
  CHECK(feedStr(r, line, last, sizeof last) == 0);
  CHECK(last[0] == '\0');
  CHECK(feedStr(r, "{\"a\":5}\n", last, sizeof last) == 1);
  CHECK(strcmp(last, "{\"a\":5}") == 0);

  // A much longer run of bytes (no newline for a while) stays in bounds.
  lineReaderInit(r);
  for (int i = 0; i < 5000; i++) CHECK(!lineReaderFeed(r, i == 0 ? '{' : 'z'));
  CHECK(r.len <= LINE_READER_MAX_LEN);
  CHECK(!lineReaderFeed(r, '\n'));
}

static void test_line_reader_fits_mega_status_line() {
  // The longest line the Mega can send must fit under the ESP's cap.
  CHECK(STATUS_LINE_MAX - 1 <= LINE_READER_MAX_LEN);
}

// Feeds `s` as one drain of the serial backlog.
static void drain(LineReader &r, NewestLine &n, const char *s) {
  for (size_t i = 0; s[i] != '\0'; i++) newestLineFeed(r, n, s[i]);
}

static void test_newest_line_starts_empty() {
  NewestLine n;
  newestLineInit(n);
  CHECK(!n.ready);
}

static void test_newest_line_several_lines_keeps_only_last() {
  LineReader r;
  NewestLine n;
  lineReaderInit(r);
  newestLineInit(n);
  drain(r, n, "{\"a\":1}\r\n{\"a\":2}\r\n{\"a\":3}\r\n");
  CHECK(n.ready);
  CHECK(strcmp(n.buf, "{\"a\":3}") == 0);
}

static void test_newest_line_trailing_partial_kept_for_next_drain() {
  LineReader r;
  NewestLine n;
  lineReaderInit(r);
  newestLineInit(n);
  drain(r, n, "{\"a\":1}\r\n{\"a\":");
  CHECK(n.ready);
  CHECK(strcmp(n.buf, "{\"a\":1}") == 0);
  n.ready = false;  // forwarded
  drain(r, n, "2}\r\n");
  CHECK(n.ready);
  CHECK(strcmp(n.buf, "{\"a\":2}") == 0);
}

static void test_newest_line_bad_lines_never_replace_good() {
  LineReader r;
  NewestLine n;
  lineReaderInit(r);
  newestLineInit(n);
  // A bad line followed by a good one: the good one wins.
  drain(r, n, "# boot noise\r\n{\"a\":1}\r\n");
  CHECK(n.ready);
  CHECK(strcmp(n.buf, "{\"a\":1}") == 0);
  // A good line followed by bad ones: the good one is still there.
  newestLineInit(n);
  drain(r, n, "{\"a\":2}\r\n# log\r\n{\"cut\r\n");
  CHECK(n.ready);
  CHECK(strcmp(n.buf, "{\"a\":2}") == 0);
  // Only bad lines: nothing to forward.
  newestLineInit(n);
  drain(r, n, "# log\r\nnoise\r\n");
  CHECK(!n.ready);
}

static void test_newest_line_full_length_copied_whole() {
  LineReader r;
  NewestLine n;
  lineReaderInit(r);
  newestLineInit(n);
  char line[LINE_READER_MAX_LEN + 2];
  line[0] = '{';
  for (uint16_t i = 1; i < LINE_READER_MAX_LEN - 1; i++) line[i] = 'a';
  line[LINE_READER_MAX_LEN - 1] = '}';
  line[LINE_READER_MAX_LEN] = '\n';
  line[LINE_READER_MAX_LEN + 1] = '\0';
  drain(r, n, line);
  CHECK(n.ready);
  CHECK(strlen(n.buf) == LINE_READER_MAX_LEN);
  CHECK(strncmp(n.buf, line, LINE_READER_MAX_LEN) == 0);
}

// ---------------------------------------------------------------------------
// ESP8266 server URL check (firmware/esp/server_url.h)
// ---------------------------------------------------------------------------

static void test_server_url_accepts_ipv4_http() {
  CHECK(serverUrlIsIpv4Http("http://172.20.10.2:3000/status"));
  CHECK(serverUrlIsIpv4Http("http://192.168.1.10/status"));
  CHECK(serverUrlIsIpv4Http("http://10.0.0.1:3000"));
  CHECK(serverUrlIsIpv4Http("http://0.0.0.0"));
  CHECK(serverUrlIsIpv4Http("http://255.255.255.255:80/status"));
}

static void test_server_url_rejects_hostnames_and_bad_urls() {
  CHECK(!serverUrlIsIpv4Http("http://my-laptop.local:3000/status"));
  CHECK(!serverUrlIsIpv4Http("http://localhost:3000/status"));
  CHECK(!serverUrlIsIpv4Http("http://LAPTOP_IP:PORT/status"));
  CHECK(!serverUrlIsIpv4Http("http://1.2.3.4.example.com/status"));
  CHECK(!serverUrlIsIpv4Http("http://172.20.10/status"));
  CHECK(!serverUrlIsIpv4Http("http://256.1.1.1/status"));
  CHECK(!serverUrlIsIpv4Http("http://1.2.3.0004/status"));
  CHECK(!serverUrlIsIpv4Http("http://1..2.3/status"));
  CHECK(!serverUrlIsIpv4Http("https://172.20.10.2:3000/status"));
  CHECK(!serverUrlIsIpv4Http("172.20.10.2:3000/status"));
  CHECK(!serverUrlIsIpv4Http("http://"));
  CHECK(!serverUrlIsIpv4Http(""));
  CHECK(!serverUrlIsIpv4Http(0));
}

// ---------------------------------------------------------------------------
// ESP box token (box_token.h)
// ---------------------------------------------------------------------------

static void test_box_token_accepts_hex_and_allowed_chars() {
  CHECK(boxTokenIsUsable("3f9a0c1e7b2d4a6f8e0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d"));
  CHECK(boxTokenIsUsable("a"));
  CHECK(boxTokenIsUsable("Box_Token-1"));
  CHECK(boxTokenIsUsable("your-box-token2"));
  CHECK(boxTokenIsUsable("your-box-toke"));
  // Usable in a constant expression, as esp.ino's static_assert needs.
  static_assert(boxTokenIsUsable("deadbeef"), "hex token must be usable");
}

static void test_box_token_rejects_empty_placeholder_and_bad_chars() {
  CHECK(!boxTokenIsUsable(""));
  CHECK(!boxTokenIsUsable(nullptr));
  CHECK(!boxTokenIsUsable(BOX_TOKEN_PLACEHOLDER));
  CHECK(!boxTokenIsUsable("your-box-token"));
  CHECK(!boxTokenIsUsable(ECHO_BOX_TOKEN));  // secrets.example.h's value
  CHECK(strcmp(ECHO_BOX_TOKEN, BOX_TOKEN_PLACEHOLDER) == 0);
  CHECK(!boxTokenIsUsable("dead beef"));
  CHECK(!boxTokenIsUsable(" deadbeef"));
  CHECK(!boxTokenIsUsable("deadbeef\n"));
  CHECK(!boxTokenIsUsable("dead\tbeef"));
  CHECK(!boxTokenIsUsable("dead#beef"));
  CHECK(!boxTokenIsUsable("caf\xc3\xa9"));
  CHECK(!boxTokenIsUsable("\x7f"));
  // Characters the server's .env parsing could change (quotes stripped,
  // backslash literal there but an escape in C) or that aren't needed.
  CHECK(!boxTokenIsUsable("Box_Token-1!~"));
  CHECK(!boxTokenIsUsable("\"deadbeef\""));
  CHECK(!boxTokenIsUsable("'deadbeef'"));
  CHECK(!boxTokenIsUsable("`deadbeef`"));
  CHECK(!boxTokenIsUsable("dead\\beef"));
  CHECK(!boxTokenIsUsable("dead!beef"));
  CHECK(!boxTokenIsUsable("dead~beef"));
  static_assert(!boxTokenIsUsable("your-box-token"), "placeholder must fail");
}

// ---------------------------------------------------------------------------
// ESP8266 Wi-Fi watchdog (firmware/esp/wifi_watchdog.h)
// ---------------------------------------------------------------------------

static const uint32_t WD_STEP_MS = 100;  // a slow ESP loop

// Runs the watchdog from `from` up to (not including) `to` in WD_STEP_MS
// steps with a fixed Wi-Fi state, counting each action returned.
static void wdRun(WifiWatchdog &w, uint32_t from, uint32_t to, bool connected,
                  int &restarts, int &reboots) {
  for (uint32_t t = from; t != to; t += WD_STEP_MS) {
    WifiWatchdogAction a = wifiWatchdogUpdate(w, t, connected);
    if (a == WIFI_WATCHDOG_RESTART_WIFI) restarts++;
    if (a == WIFI_WATCHDOG_REBOOT) reboots++;
  }
}

static void test_wifi_watchdog_ladder_order() {
  CHECK(WIFI_WATCHDOG_RESTART_MS > 0);
  CHECK(WIFI_WATCHDOG_REBOOT_MS > WIFI_WATCHDOG_RESTART_MS);
  CHECK(WIFI_WATCHDOG_RESTART_MS % WD_STEP_MS == 0);
  CHECK(WIFI_WATCHDOG_REBOOT_MS % WD_STEP_MS == 0);
}

static void test_wifi_watchdog_quiet_while_connected() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  wdRun(w, 0, 10 * WIFI_WATCHDOG_REBOOT_MS, true, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
}

static void test_wifi_watchdog_restart_once_then_reboot() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  wdRun(w, 0, 5000, true, restarts, reboots);
  // Outage starts at 5000 ms.
  const uint32_t start = 5000;
  wdRun(w, start, start + WIFI_WATCHDOG_RESTART_MS, false, restarts, reboots);
  CHECK(restarts == 0);  // nothing before the restart time
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  wdRun(w, start + WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS,
        start + WIFI_WATCHDOG_REBOOT_MS, false, restarts, reboots);
  CHECK(restarts == 0);  // exactly one Wi-Fi restart per outage
  CHECK(reboots == 0);   // no reboot before the reboot time
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
  // Not asked again on the very next loop.
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS + WD_STEP_MS,
                           false) == WIFI_WATCHDOG_NONE);
}

static void test_wifi_watchdog_never_joined_since_boot() {
  // Boot counts as the start of an outage (e.g. the hotspot is off).
  WifiWatchdog w;
  wifiWatchdogInit(w, 1234);
  CHECK(wifiWatchdogUpdate(w, 1234 + WIFI_WATCHDOG_RESTART_MS - 1, false) ==
        WIFI_WATCHDOG_NONE);
  CHECK(wifiWatchdogUpdate(w, 1234 + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  CHECK(wifiWatchdogUpdate(w, 1234 + WIFI_WATCHDOG_REBOOT_MS - 1, false) ==
        WIFI_WATCHDOG_NONE);
  CHECK(wifiWatchdogUpdate(w, 1234 + WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
}

static void test_wifi_watchdog_reconnect_resets_ladder() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  // Down long enough for the Wi-Fi restart, then it rejoins.
  wdRun(w, 0, WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS, false, restarts, reboots);
  CHECK(restarts == 1);
  CHECK(wifiWatchdogUpdate(w, WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS, true) ==
        WIFI_WATCHDOG_NONE);
  // A new outage gets the whole ladder again, timed from its own start,
  // including a fresh Wi-Fi restart and no reboot carried over.
  const uint32_t start = 2 * WIFI_WATCHDOG_REBOOT_MS;
  restarts = 0;
  wdRun(w, WIFI_WATCHDOG_RESTART_MS + 2 * WD_STEP_MS, start, true, restarts,
        reboots);
  wdRun(w, start, start + WIFI_WATCHDOG_RESTART_MS, false, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  wdRun(w, start + WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS,
        start + WIFI_WATCHDOG_REBOOT_MS, false, restarts, reboots);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
}

static void test_wifi_watchdog_blips_never_trigger() {
  // Outages just shorter than the restart time, separated by one connected
  // loop, never add up to an action.
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  uint32_t t = 0;
  for (int i = 0; i < 20; i++) {
    wdRun(w, t, t + WIFI_WATCHDOG_RESTART_MS - WD_STEP_MS, false, restarts,
          reboots);
    t += WIFI_WATCHDOG_RESTART_MS - WD_STEP_MS;
    CHECK(wifiWatchdogUpdate(w, t, true) == WIFI_WATCHDOG_NONE);
    t += WD_STEP_MS;
  }
  CHECK(t > 2 * WIFI_WATCHDOG_REBOOT_MS);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
}

static void test_wifi_watchdog_survives_millis_wraparound() {
  // An outage that starts just before millis() wraps to 0.
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  const uint32_t start = 0xFFFFFFFFUL - 5000UL;
  CHECK(wifiWatchdogUpdate(w, start - WD_STEP_MS, true) == WIFI_WATCHDOG_NONE);
  int restarts = 0, reboots = 0;
  wdRun(w, start, start + WIFI_WATCHDOG_RESTART_MS, false, restarts, reboots);
  CHECK(restarts == 0);  // the wrap is not mistaken for a long outage
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  wdRun(w, start + WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS,
        start + WIFI_WATCHDOG_REBOOT_MS, false, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
}


static void test_wifi_watchdog_link_second_ladder_if_reboot_did_not_happen() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  CHECK(wifiWatchdogUpdate(w, WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
  const uint32_t t = WIFI_WATCHDOG_REBOOT_MS;
  int restarts = 0, reboots = 0;
  wdRun(w, t + WD_STEP_MS, t + WIFI_WATCHDOG_RESTART_MS, false, restarts,
        reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, t + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  wdRun(w, t + WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS,
        t + WIFI_WATCHDOG_REBOOT_MS, false, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, t + WIFI_WATCHDOG_REBOOT_MS, false) ==
        WIFI_WATCHDOG_REBOOT);
}

static void test_wifi_watchdog_connected_exactly_at_threshold() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  CHECK(wifiWatchdogUpdate(w, WIFI_WATCHDOG_RESTART_MS, true) ==
        WIFI_WATCHDOG_NONE);
  // The outage is over: the next one is timed from its own start.
  const uint32_t start = WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS;
  CHECK(wifiWatchdogUpdate(w, start, false) == WIFI_WATCHDOG_NONE);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_RESTART_MS - 1, false) ==
        WIFI_WATCHDOG_NONE);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS - 1, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  CHECK(wifiWatchdogUpdate(w, start + WIFI_WATCHDOG_REBOOT_MS, true) ==
        WIFI_WATCHDOG_NONE);
  CHECK(!w.down);
  CHECK(!w.restarted);
}

static void test_wifi_watchdog_coarse_step_past_reboot() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  CHECK(wifiWatchdogUpdate(w, WIFI_WATCHDOG_REBOOT_MS * 3, false) ==
        WIFI_WATCHDOG_REBOOT);
  CHECK(w.cause == WIFI_WATCHDOG_CAUSE_LINK);
}

// --- POSTs failing while Wi-Fi reads connected ---

static const uint32_t WD_POST_MS = 2000;  // one status every 2 s

// Connected loops from `from` up to (not including) `to`, one POST result
// every WD_POST_MS, counting actions.
static void wdPosts(WifiWatchdog &w, uint32_t from, uint32_t to,
                    WifiPostResult post, int &restarts, int &reboots) {
  for (uint32_t t = from; t != to; t += WD_POST_MS) {
    WifiWatchdogAction a = wifiWatchdogUpdate(w, t, true, post);
    if (a == WIFI_WATCHDOG_RESTART_WIFI) restarts++;
    if (a == WIFI_WATCHDOG_REBOOT) reboots++;
  }
}

static void test_wifi_post_constants_order() {
  CHECK(WIFI_WATCHDOG_POST_RESTART_MS > 0);
  CHECK(WIFI_WATCHDOG_POST_REBOOT_MS > WIFI_WATCHDOG_POST_RESTART_MS);
  CHECK(WIFI_WATCHDOG_POST_GAP_MS > WD_POST_MS);
  CHECK(WIFI_WATCHDOG_POST_RESTART_MS % WD_POST_MS == 0);
  CHECK(WIFI_WATCHDOG_POST_REBOOT_MS % WD_POST_MS == 0);
}

static void test_wifi_post_result_from_code() {
  CHECK(wifiPostResultFromCode(200) == WIFI_POST_OK);
  CHECK(wifiPostResultFromCode(401) == WIFI_POST_OK);
  CHECK(wifiPostResultFromCode(404) == WIFI_POST_OK);
  CHECK(wifiPostResultFromCode(500) == WIFI_POST_OK);
  CHECK(wifiPostResultFromCode(-1) == WIFI_POST_FAIL);   // connection refused
  CHECK(wifiPostResultFromCode(-11) == WIFI_POST_FAIL);  // read timeout
  CHECK(wifiPostResultFromCode(0) == WIFI_POST_FAIL);
}

static void test_wifi_post_restart_then_reboot() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  wdPosts(w, 0, 10000, WIFI_POST_OK, restarts, reboots);
  // First failed POST at 10 s starts the streak.
  const uint32_t s = 10000;
  wdPosts(w, s, s + WIFI_WATCHDOG_POST_RESTART_MS, WIFI_POST_FAIL, restarts,
          reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, s + WIFI_WATCHDOG_POST_RESTART_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_RESTART_WIFI);
  CHECK(w.cause == WIFI_WATCHDOG_CAUSE_POSTS);
  wdPosts(w, s + WIFI_WATCHDOG_POST_RESTART_MS + WD_POST_MS,
          s + WIFI_WATCHDOG_POST_REBOOT_MS, WIFI_POST_FAIL, restarts, reboots);
  CHECK(restarts == 0);  // once per streak
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, s + WIFI_WATCHDOG_POST_REBOOT_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_REBOOT);
  CHECK(w.cause == WIFI_WATCHDOG_CAUSE_POSTS);
  // If the reboot didn't happen, a full second ladder follows.
  const uint32_t t = s + WIFI_WATCHDOG_POST_REBOOT_MS;
  wdPosts(w, t + WD_POST_MS, t + WIFI_WATCHDOG_POST_RESTART_MS,
          WIFI_POST_FAIL, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, t + WIFI_WATCHDOG_POST_RESTART_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_RESTART_WIFI);
  wdPosts(w, t + WIFI_WATCHDOG_POST_RESTART_MS + WD_POST_MS,
          t + WIFI_WATCHDOG_POST_REBOOT_MS, WIFI_POST_FAIL, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, t + WIFI_WATCHDOG_POST_REBOOT_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_REBOOT);
}

static void test_wifi_post_any_http_code_resets_streak() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  uint32_t t = 0;
  // Fail for just under the restart time, one answered POST, repeat.
  for (int i = 0; i < 10; i++) {
    wdPosts(w, t, t + WIFI_WATCHDOG_POST_RESTART_MS, WIFI_POST_FAIL, restarts,
            reboots);
    t += WIFI_WATCHDOG_POST_RESTART_MS;
    // e.g. a 401 or 500: wifiPostResultFromCode gives OK.
    CHECK(wifiWatchdogUpdate(w, t, true, wifiPostResultFromCode(500)) ==
          WIFI_WATCHDOG_NONE);
    CHECK(!w.failing);
    t += WD_POST_MS;
  }
  CHECK(t > WIFI_WATCHDOG_POST_REBOOT_MS * 2);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  // OK exactly when the restart would be due: NONE, and the streak resets.
  wdPosts(w, t, t + WIFI_WATCHDOG_POST_RESTART_MS, WIFI_POST_FAIL, restarts,
          reboots);
  CHECK(wifiWatchdogUpdate(w, t + WIFI_WATCHDOG_POST_RESTART_MS, true,
                           WIFI_POST_OK) == WIFI_WATCHDOG_NONE);
  CHECK(w.failingMs == 0);
  CHECK(restarts == 0);
}

static void test_wifi_post_no_escalation_without_attempts() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  // Connected, Mega silent (no POSTs) for a long time.
  wdPosts(w, 0, 10 * WIFI_WATCHDOG_POST_REBOOT_MS, WIFI_POST_NONE, restarts,
          reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  // One failed POST, then silence, then single failed POSTs far apart: each
  // gap counts at most WIFI_WATCHDOG_POST_GAP_MS.
  uint32_t t = 10 * WIFI_WATCHDOG_POST_REBOOT_MS;
  const uint32_t apart = 10 * 60000UL;
  for (int i = 0; i < 5; i++) {
    CHECK(wifiWatchdogUpdate(w, t, true, WIFI_POST_FAIL) == WIFI_WATCHDOG_NONE);
    wdPosts(w, t + WD_POST_MS, t + apart, WIFI_POST_NONE, restarts, reboots);
    t += apart;
  }
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(w.failingMs == 4 * WIFI_WATCHDOG_POST_GAP_MS);
}

static void test_wifi_post_streak_survives_its_own_wifi_restart() {
  // The Wi-Fi restart from the POST ladder drops and rejoins the link; the
  // streak must carry on to the reboot instead of restarting Wi-Fi forever.
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  wdPosts(w, 0, WIFI_WATCHDOG_POST_RESTART_MS, WIFI_POST_FAIL, restarts,
          reboots);
  CHECK(wifiWatchdogUpdate(w, WIFI_WATCHDOG_POST_RESTART_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_RESTART_WIFI);
  // Link down for 4 s while it rejoins (no POSTs), then connected again.
  uint32_t t = WIFI_WATCHDOG_POST_RESTART_MS + WD_POST_MS;
  wdRun(w, t, t + 4000, false, restarts, reboots);
  t += 4000;
  CHECK(wifiWatchdogUpdate(w, t, true) == WIFI_WATCHDOG_NONE);
  CHECK(!w.down);    // the link ladder reset on reconnect
  CHECK(w.failing);  // the POST streak did not
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  // Keep failing until the accumulated streak reaches the reboot.
  uint32_t n = 0;
  WifiWatchdogAction a = WIFI_WATCHDOG_NONE;
  while (a == WIFI_WATCHDOG_NONE && n < 1000) {
    t += WD_POST_MS;
    n++;
    a = wifiWatchdogUpdate(w, t, true, WIFI_POST_FAIL);
  }
  CHECK(a == WIFI_WATCHDOG_REBOOT);
  // Last failed POST before the restart was at 60 s; the next at 68 s, so the
  // 8 s gap across the rejoin counted as WIFI_WATCHDOG_POST_GAP_MS (5 s).
  // Then 2 s per POST from 65 s of streak to >= 180 s: 58 POSTs.
  static_assert(WIFI_WATCHDOG_POST_RESTART_MS == 60000UL &&
                    WIFI_WATCHDOG_POST_REBOOT_MS == 180000UL &&
                    WIFI_WATCHDOG_POST_GAP_MS == 5000UL,
                "update the expected time below with the constants");
  CHECK(t == 68000UL + 58UL * WD_POST_MS);
}

static void test_wifi_post_and_link_ladders_together() {
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  int restarts = 0, reboots = 0;
  // 40 s of failed POSTs (below the POST restart), then the link drops.
  wdPosts(w, 0, 40000, WIFI_POST_FAIL, restarts, reboots);
  CHECK(restarts == 0);
  const uint32_t d = 40000;
  // The link ladder runs on its own clock from the drop.
  wdRun(w, d, d + WIFI_WATCHDOG_RESTART_MS, false, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(wifiWatchdogUpdate(w, d + WIFI_WATCHDOG_RESTART_MS, false) ==
        WIFI_WATCHDOG_RESTART_WIFI);
  CHECK(w.cause == WIFI_WATCHDOG_CAUSE_LINK);
  // A POST result while disconnected (can't really happen) is ignored.
  CHECK(wifiWatchdogUpdate(w, d + WIFI_WATCHDOG_RESTART_MS + WD_STEP_MS, false,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_NONE);
  // Back after 50 s down: the POST streak was paused, not grown by the outage.
  const uint32_t back = d + 50000;
  CHECK(wifiWatchdogUpdate(w, back, true) == WIFI_WATCHDOG_NONE);
  CHECK(w.failing);
  CHECK(w.failingMs < 40000);
  // First failed POST after rejoin adds one capped gap; the POST restart
  // comes once 60 s of failing has accumulated in total.
  CHECK(wifiWatchdogUpdate(w, back + WD_POST_MS, true, WIFI_POST_FAIL) ==
        WIFI_WATCHDOG_NONE);
  CHECK(w.failingMs == 40000 - WD_POST_MS + WIFI_WATCHDOG_POST_GAP_MS);
  restarts = 0;
  uint32_t t = back + WD_POST_MS;
  WifiWatchdogAction a = WIFI_WATCHDOG_NONE;
  while (a == WIFI_WATCHDOG_NONE && t < back + 60000) {
    t += WD_POST_MS;
    a = wifiWatchdogUpdate(w, t, true, WIFI_POST_FAIL);
  }
  CHECK(a == WIFI_WATCHDOG_RESTART_WIFI);
  CHECK(w.cause == WIFI_WATCHDOG_CAUSE_POSTS);
  CHECK(w.failingMs >= WIFI_WATCHDOG_POST_RESTART_MS);
  CHECK(w.failingMs < WIFI_WATCHDOG_POST_RESTART_MS + WD_POST_MS);
}

static void test_wifi_post_coarse_step_and_wraparound() {
  // A streak that crosses the millis() wrap.
  WifiWatchdog w;
  wifiWatchdogInit(w, 0);
  const uint32_t s = 0xFFFFFFFFUL - 7000UL;
  int restarts = 0, reboots = 0;
  wdPosts(w, s, s + WIFI_WATCHDOG_POST_RESTART_MS, WIFI_POST_FAIL, restarts,
          reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, s + WIFI_WATCHDOG_POST_RESTART_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_RESTART_WIFI);
  wdPosts(w, s + WIFI_WATCHDOG_POST_RESTART_MS + WD_POST_MS,
          s + WIFI_WATCHDOG_POST_REBOOT_MS, WIFI_POST_FAIL, restarts, reboots);
  CHECK(restarts == 0);
  CHECK(reboots == 0);
  CHECK(wifiWatchdogUpdate(w, s + WIFI_WATCHDOG_POST_REBOOT_MS, true,
                           WIFI_POST_FAIL) == WIFI_WATCHDOG_REBOOT);
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
  test_timing_constants_match_doc();
  test_lm35_conversion();
  test_sim_dead_zone_holds();
  test_sim_full_push_warms_half_degree_per_second();
  test_sim_clamps();
  test_periodic_first_call_then_every_period();
  test_periodic_resyncs_after_long_stall();
  test_periodic_survives_wraparound();
  test_debounce_ignores_bounce();
  test_debounce_press_and_release();
  test_seat_without_baseline_never_occupied();
  test_fault_active_only_without_baseline();
  test_fault_alarm_levels_win();
  test_fault_led_two_short_flashes_per_cycle();
  test_humidity_starts_invalid();
  test_humidity_repeats_last_good_until_age_limit();
  test_humidity_ignores_out_of_range();
  test_humidity_age_survives_wraparound();
  test_status_line_exact_format();
  test_status_line_has_doc_fields_in_order_without_light();
  test_status_line_every_state_name();
  test_status_line_number_rounding();
  test_status_line_rejects_non_finite_required_numbers();
  test_status_line_never_overflows();
  test_battery_constants_match_doc();
  test_battery_adc_to_pack_volts();
  test_battery_percent_maps_doc_voltages();
  test_battery_percent_clamps();
  test_battery_percent_rounds_to_nearest();
  test_battery_no_pack_is_null();
  test_battery_status_null_without_divider();
  test_status_line_battery_number_or_null();
  test_alarm_constants_match_doc();
  test_level_clock_restarts_on_level_change_only();
  test_led_idle_and_warning_solid();
  test_led_blinks_and_flashes();
  test_led_fault_code_replaces_idle_and_armed_only();
  test_rgb_common_anode_inverts();
  test_buzzer_silent_when_idle_or_armed();
  test_buzzer_occupant_chirp_and_warning_beep();
  test_buzzer_emergency_siren_sweeps_up_and_down();
  test_lcd_line1_level_and_temp();
  test_lcd_lines_always_exactly_16_chars();
  test_lcd_line2_per_level();
  test_lcd_line2_unknown_and_huge_minutes();
  test_lcd_shows_sim_when_simulating();
  test_mins_constants_match_doc();
  test_mins_null_until_two_minutes_of_samples();
  test_mins_doc_formula_with_literals();
  test_mins_null_below_minimum_rate();
  test_mins_zero_at_or_above_danger_temp();
  test_mins_skips_nan_samples();
  test_mins_window_is_the_last_60_samples();
  test_mins_uses_sample_times_and_survives_wraparound();
  test_mins_raise_warning_and_emergency_from_occupant();
  test_mins_null_or_negative_never_raises();
  test_mins_only_from_occupant_up();
  test_mins_levels_still_only_climb();
  test_mins_box_run_starts_alarm_on_first_condition();
  test_status_line_mins_to_danger_number_or_null();
  test_lcd_line2_shows_computed_minutes();
  test_recording_matches_box_logic();
  test_line_reader_keeps_json_line_without_crlf();
  test_line_reader_returns_true_only_on_newline();
  test_line_reader_drops_lines_not_starting_with_brace();
  test_line_reader_drops_partial_lines();
  test_line_reader_drops_nul_line();
  test_line_reader_length_cap();
  test_line_reader_fits_mega_status_line();
  test_newest_line_starts_empty();
  test_newest_line_several_lines_keeps_only_last();
  test_newest_line_trailing_partial_kept_for_next_drain();
  test_newest_line_bad_lines_never_replace_good();
  test_newest_line_full_length_copied_whole();
  test_server_url_accepts_ipv4_http();
  test_server_url_rejects_hostnames_and_bad_urls();
  test_box_token_accepts_hex_and_allowed_chars();
  test_box_token_rejects_empty_placeholder_and_bad_chars();
  test_wifi_watchdog_ladder_order();
  test_wifi_watchdog_quiet_while_connected();
  test_wifi_watchdog_restart_once_then_reboot();
  test_wifi_watchdog_never_joined_since_boot();
  test_wifi_watchdog_reconnect_resets_ladder();
  test_wifi_watchdog_blips_never_trigger();
  test_wifi_watchdog_survives_millis_wraparound();
  test_wifi_watchdog_link_second_ladder_if_reboot_did_not_happen();
  test_wifi_watchdog_connected_exactly_at_threshold();
  test_wifi_watchdog_coarse_step_past_reboot();
  test_wifi_post_constants_order();
  test_wifi_post_result_from_code();
  test_wifi_post_restart_then_reboot();
  test_wifi_post_any_http_code_resets_streak();
  test_wifi_post_no_escalation_without_attempts();
  test_wifi_post_streak_survives_its_own_wifi_restart();
  test_wifi_post_and_link_ladders_together();
  test_wifi_post_coarse_step_and_wraparound();

  printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
