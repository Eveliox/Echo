// Manual Challenger harness (#22): grades a file of scenarios in the line
// format of challenger.h against the real logic.h. Never part of a Checks
// row; simulator/challenger.js builds it into a temp folder and runs it:
//   challenger_run <scenarios.tsv>
// Blank lines and lines starting with '#' are skipped. Prints each failure
// and invalid line, then one summary line:
//   challenger: N scenarios, P pass, F fail, I invalid
// Exit code: 0 all pass, 1 any fail or invalid, 2 the file can't be read.

#include <stdio.h>
#include <stdint.h>
#include <math.h>
#include <string.h>

#include "challenger.h"

static char g_line[CHALLENGER_MAX_STEPS * 24 + 512];
static ChallengerScenario g_sc;

// Reads one line into g_line. Returns false at end of file; sets `tooLong`
// (and skips the rest of the line) when it doesn't fit.
static bool readLine(FILE *f, bool &tooLong) {
  size_t n = 0;
  int c;
  tooLong = false;
  bool any = false;
  while ((c = getc(f)) != EOF) {
    any = true;
    if (c == '\n') break;
    if (n + 1 < sizeof g_line) {
      g_line[n++] = (char)c;
    } else {
      tooLong = true;
    }
  }
  g_line[n] = '\0';
  return any;
}

static void printTrace(const ChallengerResult &r, uint16_t steps) {
  printf("    levels:");
  for (uint8_t l = LEVEL_IDLE; l <= LEVEL_EMERGENCY; l++) {
    if (r.firstStep[l] >= 0) {
      printf(" %s@step%d(%lus)", alertLevelName((AlertLevel)l), r.firstStep[l],
             (unsigned long)((uint32_t)r.firstStep[l] * STATUS_PERIOD_MS / 1000UL));
    }
  }
  printf("\n    last step %u: tempF %.2f, minsToDanger ", (unsigned)(steps - 1), r.lastTempF);
  if (isnan(r.lastMinsToDanger)) {
    printf("null\n");
  } else {
    printf("%.1f\n", r.lastMinsToDanger);
  }
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: challenger_run <scenarios.tsv>\n");
    return 2;
  }
  FILE *f = fopen(argv[1], "r");
  if (!f) {
    fprintf(stderr, "challenger: can't read %s\n", argv[1]);
    return 2;
  }
  int total = 0, pass = 0, fail = 0, invalid = 0, lineNo = 0;
  bool tooLong;
  while (readLine(f, tooLong)) {
    lineNo++;
    if (g_line[0] == '\0' || g_line[0] == '#' || strcmp(g_line, "\r") == 0) continue;
    total++;
    const char *why = tooLong ? "line too long" : challengerParseLine(g_sc, g_line);
    if (why) {
      invalid++;
      printf("INVALID line %d: %s\n", lineNo, why);
      continue;
    }
    ChallengerResult r = challengerRun(g_sc);
    if (r.finalLevel == g_sc.expected) {
      pass++;
    } else {
      fail++;
      printf("FAIL \"%s\": expected %s, box ends in %s after %u steps\n", g_sc.name,
             alertLevelName(g_sc.expected), alertLevelName(r.finalLevel), (unsigned)g_sc.steps);
      printTrace(r, g_sc.steps);
    }
  }
  fclose(f);
  printf("challenger: %d scenarios, %d pass, %d fail, %d invalid\n", total, pass, fail, invalid);
  return (fail == 0 && invalid == 0) ? 0 : 1;
}
