// Challenger scenarios (#22, docs/brief.md "Challenger scenario"): parses one
// scenario and runs it through the real box logic in logic.h. Shared by the
// seed set in logic_test.cpp and the manual harness challenger_run.cpp, so
// seeds and generated scenarios are graded by identical code.
//
// Test-only plain C++ (no STL, no allocation); never part of the Mega build.
//
// Mapping (ticket #22):
// - Element i is status period i, at nowMs = i * STATUS_PERIOD_MS.
// - Ignition is off and cancel is not pressed at every step, so the very
//   first step moves IDLE -> ARMED (and may start the seat dwell timer).
// - presence[i] is AlertInputs.seatOccupied.
// - tempF[i] is added to a TempHistory, then minsToDanger comes from
//   tempHistoryMinsToDanger, the same order as the sketch and the recording
//   replay test.
// - The level after the last element is compared with `expected`.
//
// Line format (one scenario per line; the JS side does all JSON work):
//   name<TAB>EXPECTED<TAB>presence as 0/1 chars<TAB>comma-separated tempF

#ifndef ECHO_CHALLENGER_H
#define ECHO_CHALLENGER_H

#include <stdint.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "logic.h"

// Validation limits, read by simulator/challenger.js too (plain literals).
static const uint16_t CHALLENGER_MAX_STEPS = 600;  // 20 minutes of status periods
static const float CHALLENGER_MIN_TEMP_F = 0.0f;
static const float CHALLENGER_MAX_TEMP_F = 200.0f;
static const uint8_t CHALLENGER_NAME_MAX = 96;  // incl. terminator

struct ChallengerScenario {
  char name[CHALLENGER_NAME_MAX];
  AlertLevel expected;
  uint16_t steps;
  bool presence[CHALLENGER_MAX_STEPS];
  float tempF[CHALLENGER_MAX_STEPS];
};

struct ChallengerResult {
  AlertLevel finalLevel;
  int16_t firstStep[LEVEL_EMERGENCY + 1];  // step each level was first held; -1 never
  float lastTempF;
  float lastMinsToDanger;  // NaN means null
};

// Level name (exact, as in alertLevelName) -> level. False if unknown.
inline bool challengerLevelFromName(const char *s, size_t len, AlertLevel &out) {
  for (uint8_t l = LEVEL_IDLE; l <= LEVEL_EMERGENCY; l++) {
    const char *name = alertLevelName((AlertLevel)l);
    if (strlen(name) == len && strncmp(name, s, len) == 0) {
      out = (AlertLevel)l;
      return true;
    }
  }
  return false;
}

// Fills `sc` from the four fields (each `len` chars, not necessarily
// terminated). Returns NULL on success, else a short reason the scenario is
// invalid. Arrays must have equal length, 1..CHALLENGER_MAX_STEPS.
inline const char *challengerParseFields(ChallengerScenario &sc, const char *name, size_t nameLen,
                                         const char *expected, size_t expectedLen,
                                         const char *presence, size_t presenceLen,
                                         const char *temps, size_t tempsLen) {
  if (nameLen == 0) return "empty name";
  size_t copy = nameLen < (size_t)(CHALLENGER_NAME_MAX - 1) ? nameLen : (size_t)(CHALLENGER_NAME_MAX - 1);
  memcpy(sc.name, name, copy);
  sc.name[copy] = '\0';
  if (!challengerLevelFromName(expected, expectedLen, sc.expected)) return "expected is not a level name";
  if (presenceLen == 0) return "no steps";
  if (presenceLen > CHALLENGER_MAX_STEPS) return "too many steps";
  for (size_t i = 0; i < presenceLen; i++) {
    if (presence[i] != '0' && presence[i] != '1') return "presence must be 0/1";
    sc.presence[i] = presence[i] == '1';
  }
  sc.steps = (uint16_t)presenceLen;

  // Temperatures: copy to a terminated buffer so strtof can't run past the field.
  static char buf[CHALLENGER_MAX_STEPS * 24];
  if (tempsLen >= sizeof buf) return "tempF field too long";
  memcpy(buf, temps, tempsLen);
  buf[tempsLen] = '\0';
  uint16_t n = 0;
  const char *p = buf;
  while (true) {
    if (n >= sc.steps) return "presence and tempF lengths differ";
    if (*p == '\0' || *p == ',') return "bad tempF number";
    char *end = NULL;
    float t = strtof(p, &end);
    if (end == p) return "bad tempF number";
    if (!(t >= CHALLENGER_MIN_TEMP_F && t <= CHALLENGER_MAX_TEMP_F)) return "tempF out of range";
    sc.tempF[n++] = t;
    if (*end == '\0') break;
    if (*end != ',') return "bad tempF number";
    p = end + 1;
  }
  if (n != sc.steps) return "presence and tempF lengths differ";
  return NULL;
}

// Parses one line in the line format (trailing \r or \n allowed).
inline const char *challengerParseLine(ChallengerScenario &sc, const char *line) {
  size_t len = strlen(line);
  while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) len--;
  const char *field[4];
  size_t flen[4];
  const char *p = line;
  const char *stop = line + len;
  for (int f = 0; f < 4; f++) {
    const char *tab = p;
    while (tab < stop && *tab != '\t') tab++;
    if (f < 3 && tab == stop) return "needs 4 tab-separated fields";
    if (f == 3 && tab != stop) return "needs 4 tab-separated fields";
    field[f] = p;
    flen[f] = (size_t)(tab - p);
    p = tab + 1;
  }
  return challengerParseFields(sc, field[0], flen[0], field[1], flen[1], field[2], flen[2], field[3],
                               flen[3]);
}

// Runs the scenario through alertStep with the mapping above.
inline ChallengerResult challengerRun(const ChallengerScenario &sc) {
  ChallengerResult r;
  for (uint8_t l = LEVEL_IDLE; l <= LEVEL_EMERGENCY; l++) r.firstStep[l] = -1;
  AlertState s;
  alertInit(s);
  TempHistory h;
  tempHistoryInit(h);
  r.finalLevel = s.level;
  r.lastTempF = NAN;
  r.lastMinsToDanger = NAN;
  for (uint16_t i = 0; i < sc.steps; i++) {
    uint32_t now = (uint32_t)i * STATUS_PERIOD_MS;
    float t = sc.tempF[i];
    tempHistoryAdd(h, t, now);
    float mins = tempHistoryMinsToDanger(h, t);
    AlertInputs in;
    in.ignitionOn = false;
    in.cancelPressed = false;
    in.seatOccupied = sc.presence[i];
    in.tempF = t;
    in.minsToDanger = mins;
    in.nowMs = now;
    AlertLevel level = alertStep(s, in);
    if (r.firstStep[level] < 0) r.firstStep[level] = (int16_t)i;
    r.finalLevel = level;
    r.lastTempF = t;
    r.lastMinsToDanger = mins;
  }
  return r;
}

#endif  // ECHO_CHALLENGER_H
