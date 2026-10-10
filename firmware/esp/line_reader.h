// Echo ESP8266: assembles the Mega's serial bytes into lines and keeps only
// the ones worth forwarding. Pure decision code shared by the ESP sketch and
// the laptop tests (firmware/mega/test/logic_test.cpp). Plain C++ only, like
// firmware/mega/logic.h: no Arduino.h, no STL, only <stdint.h>.
//
// The ESP never decides anything about the box; this only filters noise
// (docs/firmware.md, "Mega to ESP8266 link", gotchas).
//
// Rules (pinned by tests):
// - A line ends at '\n'. Every '\r' is dropped, so "\r\n" and "\n" both work.
// - A line is kept only if it starts with '{' and ends with '}'. Boot noise,
//   "#" log lines, empty lines, and the tail of a line the ESP joined halfway
//   are dropped.
// - A line longer than LINE_READER_MAX_LEN is dropped whole, up to its '\n';
//   it is never cut short and forwarded.
// - A NUL byte drops the line it is in (it would truncate the C string).

#ifndef ECHO_LINE_READER_H
#define ECHO_LINE_READER_H

#include <stdint.h>

// Longest line kept, not counting the terminator. Room above the Mega's
// status line buffer so a field added later still fits.
static const uint16_t LINE_READER_MAX_LEN = 255;

struct LineReader {
  char buf[LINE_READER_MAX_LEN + 1];
  uint16_t len;
  bool bad;  // overlong or holds a NUL: drop at the next '\n'
};

static inline void lineReaderInit(LineReader &r) {
  r.len = 0;
  r.bad = false;
  r.buf[0] = '\0';
}

// Feeds one received byte. Returns true when it completes a line worth
// forwarding; the line is then in r.buf, NUL-terminated, without CR/LF, and
// stays valid until the next lineReaderFeed call.
static inline bool lineReaderFeed(LineReader &r, char c) {
  if (c == '\r') return false;
  if (c == '\n') {
    bool keep = !r.bad && r.len >= 2 && r.buf[0] == '{' && r.buf[r.len - 1] == '}';
    r.buf[keep ? r.len : 0] = '\0';
    r.len = 0;
    r.bad = false;
    return keep;
  }
  if (r.bad) return false;
  if (c == '\0' || r.len >= LINE_READER_MAX_LEN) {
    r.bad = true;
    r.len = 0;
    return false;
  }
  r.buf[r.len++] = c;
  return false;
}

// Newest kept line from a drain of the serial backlog. Feed every byte that
// is waiting through newestLineFeed, then forward n.buf if n.ready and clear
// it. Older complete lines in the same drain are overwritten (a stale status
// must not reach the server as a fresh heartbeat); a trailing partial line
// stays in the LineReader for the next drain and never clears n.
struct NewestLine {
  char buf[LINE_READER_MAX_LEN + 1];
  bool ready;
};

static inline void newestLineInit(NewestLine &n) {
  n.ready = false;
  n.buf[0] = '\0';
}

static inline void newestLineFeed(LineReader &r, NewestLine &n, char c) {
  if (!lineReaderFeed(r, c)) return;
  uint16_t i = 0;
  for (; r.buf[i] != '\0' && i < LINE_READER_MAX_LEN; i++) n.buf[i] = r.buf[i];
  n.buf[i] = '\0';
  n.ready = true;
}

#endif  // ECHO_LINE_READER_H
