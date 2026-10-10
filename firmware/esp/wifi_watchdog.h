// Echo ESP8266: decides when Wi-Fi has been broken long enough to kick the
// radio. Plain C++ like line_reader.h (only <stdint.h>), tested in
// firmware/mega/test/logic_test.cpp. esp.ino calls wifiWatchdogUpdate() every
// loop with millis(), whether Wi-Fi is connected, and how the POST since the
// last call went, and carries out the action it returns.
//
// Why: on the bench (docs/notes.md, 2026-10-10) the ESP never rejoined the
// phone hotspot on its own after it dropped and came back; only RST did.
// The core's auto-reconnect stays on; this is the fallback when it gives up.
//
// Two ladders, each ending in the same two steps: restart Wi-Fi once (radio
// off and back on, then begin again), and later reboot the ESP (like RST).
//
// 1. Link down: Wi-Fi not connected for one unbroken outage. Restart at
//    WIFI_WATCHDOG_RESTART_MS, reboot at WIFI_WATCHDOG_REBOOT_MS. Any loop
//    that sees Wi-Fi connected ends the outage and resets this ladder, so
//    blips shorter than the restart time never trigger anything. Boot counts
//    as the start of an outage, so a join that never succeeds is covered.
//
// 2. POSTs failing while Wi-Fi reads connected. An iPhone hotspot that stops
//    broadcasting can keep the ESP associated while nothing reaches the
//    laptop, so every POST fails with a negative (transport) code. Any HTTP
//    status code, even 401/404/500, proves the link works and resets this
//    ladder. The streak only grows on attempted POSTs: each failed POST adds
//    the time since the previous failed one, at most WIFI_WATCHDOG_POST_GAP_MS,
//    so an idle or unplugged Mega (no statuses, no POSTs) never escalates.
//    Restart at WIFI_WATCHDOG_POST_RESTART_MS, reboot at
//    WIFI_WATCHDOG_POST_REBOOT_MS of accumulated failing.
//    How the two ladders fit together: while the link is down, ladder 1 runs
//    and ladder 2 is paused (no POSTs are made), not reset. A reconnect also
//    leaves ladder 2 alone, because ladder 2's own Wi-Fi restart drops and
//    rejoins the link; resetting there would repeat Wi-Fi restarts forever
//    and never reach the reboot. Only a real HTTP response (or a reboot)
//    clears it.
//    Known cost: the laptop on the hotspot with the server process stopped
//    also gives negative codes, so the ESP restarts Wi-Fi and reboots about
//    every WIFI_WATCHDOG_POST_REBOOT_MS until the server is back. Harmless:
//    the ESP holds no alarm state and the Mega alarms on its own.
//
// After a reboot is asked for, its ladder starts over, so if the reboot
// somehow doesn't happen it is asked for again only after a full ladder.
// After a real reboot, RAM is fresh and both ladders start from boot.
// Times use unsigned subtraction, so millis() wraparound is safe.

#ifndef ECHO_WIFI_WATCHDOG_H
#define ECHO_WIFI_WATCHDOG_H

#include <stdint.h>

// Decision, not from the docs: 30 s of no Wi-Fi is far past a hotspot blip
// or a normal join (a few seconds), and costs at most 15 statuses.
static const uint32_t WIFI_WATCHDOG_RESTART_MS = 30000UL;
// Decision, not from the docs: 60 s more gives the restarted radio several
// full join attempts before falling back to a reboot (90 s into the outage).
static const uint32_t WIFI_WATCHDOG_REBOOT_MS = 90000UL;
// Decision, not from the docs: POSTs can fail for a while for reasons a
// Wi-Fi restart won't fix (laptop busy, server restarting), so this ladder
// waits longer: 60 s of failing POSTs, then a reboot at 180 s.
static const uint32_t WIFI_WATCHDOG_POST_RESTART_MS = 60000UL;
static const uint32_t WIFI_WATCHDOG_POST_REBOOT_MS = 180000UL;
// Decision, not from the docs: the most one gap between failed POSTs adds to
// the streak. Statuses come every 2 s and a failed POST takes up to ~1.2 s
// (esp.ino's time budget), so real back-to-back failures are well under it.
static const uint32_t WIFI_WATCHDOG_POST_GAP_MS = 5000UL;

enum WifiWatchdogAction {
  WIFI_WATCHDOG_NONE = 0,
  WIFI_WATCHDOG_RESTART_WIFI,
  WIFI_WATCHDOG_REBOOT,
};

// What happened to the POST since the last update.
enum WifiPostResult {
  WIFI_POST_NONE = 0,  // no POST attempted
  WIFI_POST_OK,        // any HTTP status code came back
  WIFI_POST_FAIL,      // transport failure (negative http.POST code)
};

// Maps an http.POST() return code: any HTTP status (> 0), even 401/404/500,
// means the server answered; 0 or negative means it never did.
static inline WifiPostResult wifiPostResultFromCode(int code) {
  return code > 0 ? WIFI_POST_OK : WIFI_POST_FAIL;
}

// Which ladder asked for the last action (for the log line).
enum WifiWatchdogCause {
  WIFI_WATCHDOG_CAUSE_LINK = 0,
  WIFI_WATCHDOG_CAUSE_POSTS,
};

struct WifiWatchdog {
  // Ladder 1: link down.
  bool down;             // in an outage
  bool restarted;        // Wi-Fi restart already done in this outage
  uint32_t downSinceMs;  // when this outage started
  // Ladder 2: POSTs failing.
  bool failing;          // in a failed-POST streak
  bool postRestarted;    // Wi-Fi restart already done in this streak
  uint32_t lastFailMs;   // time of the latest failed POST
  uint32_t failingMs;    // accumulated failing time in this streak
  WifiWatchdogCause cause;
};

static inline void wifiWatchdogResetPosts(WifiWatchdog &w) {
  w.failing = false;
  w.postRestarted = false;
  w.lastFailMs = 0;
  w.failingMs = 0;
}

// Call once at boot with the current time.
static inline void wifiWatchdogInit(WifiWatchdog &w, uint32_t nowMs) {
  w.down = true;
  w.restarted = false;
  w.downSinceMs = nowMs;
  wifiWatchdogResetPosts(w);
  w.cause = WIFI_WATCHDOG_CAUSE_LINK;
}

static inline WifiWatchdogAction wifiWatchdogUpdate(
    WifiWatchdog &w, uint32_t nowMs, bool connected,
    WifiPostResult post = WIFI_POST_NONE) {
  if (!connected) {
    // Ladder 2 pauses: no POSTs while the link is down.
    if (!w.down) {
      w.down = true;
      w.restarted = false;
      w.downSinceMs = nowMs;
      return WIFI_WATCHDOG_NONE;
    }
    uint32_t outageMs = nowMs - w.downSinceMs;
    if (outageMs >= WIFI_WATCHDOG_REBOOT_MS) {
      w.restarted = false;
      w.downSinceMs = nowMs;
      w.cause = WIFI_WATCHDOG_CAUSE_LINK;
      return WIFI_WATCHDOG_REBOOT;
    }
    if (outageMs >= WIFI_WATCHDOG_RESTART_MS && !w.restarted) {
      w.restarted = true;
      w.cause = WIFI_WATCHDOG_CAUSE_LINK;
      return WIFI_WATCHDOG_RESTART_WIFI;
    }
    return WIFI_WATCHDOG_NONE;
  }

  w.down = false;
  w.restarted = false;

  if (post == WIFI_POST_OK) {
    wifiWatchdogResetPosts(w);
    return WIFI_WATCHDOG_NONE;
  }
  if (post != WIFI_POST_FAIL) return WIFI_WATCHDOG_NONE;

  if (!w.failing) {
    w.failing = true;
    w.postRestarted = false;
    w.failingMs = 0;
  } else {
    uint32_t gap = nowMs - w.lastFailMs;
    w.failingMs += gap < WIFI_WATCHDOG_POST_GAP_MS ? gap : WIFI_WATCHDOG_POST_GAP_MS;
  }
  w.lastFailMs = nowMs;

  if (w.failingMs >= WIFI_WATCHDOG_POST_REBOOT_MS) {
    // Start the streak over, from this failed POST.
    w.postRestarted = false;
    w.failingMs = 0;
    w.cause = WIFI_WATCHDOG_CAUSE_POSTS;
    return WIFI_WATCHDOG_REBOOT;
  }
  if (w.failingMs >= WIFI_WATCHDOG_POST_RESTART_MS && !w.postRestarted) {
    w.postRestarted = true;
    w.cause = WIFI_WATCHDOG_CAUSE_POSTS;
    return WIFI_WATCHDOG_RESTART_WIFI;
  }
  return WIFI_WATCHDOG_NONE;
}

#endif  // ECHO_WIFI_WATCHDOG_H
