// Laptop tests for firmware/mega/logic.h. Run with the logic-test row in
// CLAUDE.md "Checks". No framework: add a test function, list it in main().
// Any failed CHECK makes the program exit non-zero.

#include <stdio.h>
#include <math.h>
#include <string.h>

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

  printf("%d checks, %d failures\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
