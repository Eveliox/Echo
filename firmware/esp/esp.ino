// Echo ESP8266 NodeMCU: the box's Wi-Fi modem. Wiring, baud, and Wi-Fi setup:
// docs/firmware.md, "Mega to ESP8266 link" and "Data format and Wi-Fi".
// Reads the Mega's lines on Serial (RX pin) and POSTs each status line to the
// server as it arrives. It only forwards: it decides nothing about the box and
// sends nothing to the Mega except "#" log lines, which the Mega never acts on.
// Nothing here waits for Wi-Fi: lines that arrive while it is down are dropped
// and the next status (one every 2 s) goes out once it is back.
//
// Wi-Fi name, password, server URL, and box token come from secrets.h
// (git-ignored; copy secrets.example.h). Without it the sketch still compiles,
// from the example's placeholders, so the build check works on a fresh
// checkout; it then never joins Wi-Fi and says so on the Serial Monitor.
// With a secrets.h, it must hold a usable ECHO_BOX_TOKEN or the build stops.

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "firmware/esp/secrets.h missing: building with placeholders from secrets.example.h; this ESP will not forward anything"
#include "secrets.example.h"
#define ECHO_USING_EXAMPLE_SECRETS 1
#endif

#include "box_token.h"

#ifndef ECHO_USING_EXAMPLE_SECRETS
#ifndef ECHO_BOX_TOKEN
#error "firmware/esp/secrets.h has no box token. Add the line  #define ECHO_BOX_TOKEN \"<hex-token>\"  with the same value as ECHO_BOX_TOKEN in server/.env (e.g. from: openssl rand -hex 24)"
// Only so the rest of the file compiles quietly and the line above is the
// one error shown; the build has already failed.
#define ECHO_BOX_TOKEN ""
#else
static_assert(boxTokenIsUsable(ECHO_BOX_TOKEN),
              "ECHO_BOX_TOKEN in firmware/esp/secrets.h is empty, still the example placeholder, or has a character other than 0-9 A-Z a-z _ -. Set  #define ECHO_BOX_TOKEN \"<hex-token>\"  to the same value as ECHO_BOX_TOKEN in server/.env (e.g. from: openssl rand -hex 24)");
#endif
#endif

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

#include "line_reader.h"
#include "server_url.h"
#include "wifi_watchdog.h"

const unsigned long SERIAL_BAUD = 115200UL;  // same as the Mega's Serial1

// Room for several status lines while a POST is in flight, so none are cut.
const size_t SERIAL_RX_BUFFER = 1024;

// Time budget for one forward(), against the Mega's 2 s status period, with
// T = HTTP_TIMEOUT_MS as the esp8266 core (3.1.2) applies it:
// - DNS: none. The URL must be an IP address (checked by server_url.h at
//   startup); a hostname would add up to T for the lookup.
// - TCP connect: up to T.
// - Sending headers and body: a few hundred bytes on a fresh connection fit
//   in the TCP send buffer, so they don't block. Only an out-of-memory stall
//   would wait (T per write, up to the Stream default of 1 s overall).
// - Response: up to T of silence before the first header line, and up to T
//   more if a line stalls midway (the wait restarts on each line received).
// - http.end() stops the connection, flushing for up to 300 ms
//   (WIFICLIENT_MAX_FLUSH_WAIT_MS), whatever T is.
// So with T = 300 ms: 300 + 300 + 300 + 300 = 1.2 s in the normal worst case.
// A server that keeps trickling header bytes is not bounded by this. If a
// POST does run past 2 s, the next pass forwards only the newest complete
// status (NewestLine), so an overrun skips a status but never sends a stale or
// garbled one. The server is on the same hotspot, so a healthy round trip
// takes tens of milliseconds.
const uint16_t HTTP_TIMEOUT_MS = 300;

// How often to log the Wi-Fi state while it is down.
const unsigned long WIFI_LOG_MS = 5000UL;

LineReader reader;
NewestLine newest;
WiFiClient wifiClient;
bool wasConnected = false;
unsigned long lastWifiLog = 0;
unsigned long forwarded = 0;
unsigned long failed = 0;
bool serverUrlOk = false;  // set in setup() from server_url.h
WifiWatchdog watchdog;      // when to kick Wi-Fi after an outage; see wifi_watchdog.h
// How the last POST went, for the watchdog on the next loop. A POST that is
// never sent (bad URL) stays NONE: rebooting would not fix the config.
WifiPostResult lastPost = WIFI_POST_NONE;

// Log lines start with '#', never '{', so nothing that reaches the Mega's RX1
// looks like a status line.
void logLine(const char *msg) {
  Serial.print(F("# esp: "));
  Serial.println(msg);
}

void forward(const char *line) {
  if (!serverUrlOk) {
    failed++;
    logLine("server URL must be http://<IPv4>:<port>/status, not a hostname; not posting");
    return;
  }
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setReuse(false);  // a fresh connection per POST
  if (!http.begin(wifiClient, ECHO_SERVER_URL)) {
    failed++;
    logLine("bad server URL in secrets.h");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  // Checked by the server against ECHO_BOX_TOKEN (server/auth.js). Never log it.
  http.addHeader("X-Echo-Token", ECHO_BOX_TOKEN);
  int code = http.POST((const uint8_t *)line, strlen(line));
  http.end();
  // Any HTTP status, even an error one, proves the link to the server works.
  lastPost = wifiPostResultFromCode(code);
  if (code == 200) {
    forwarded++;
  } else {
    failed++;
    char msg[64];
    snprintf(msg, sizeof msg, "POST failed: %d (%lu ok, %lu failed)", code,
             forwarded, failed);
    logLine(msg);
  }
}

void watchWifi() {
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected && !wasConnected) {
    char msg[64];
    snprintf(msg, sizeof msg, "Wi-Fi up, IP %s", WiFi.localIP().toString().c_str());
    logLine(msg);
  } else if (!connected && millis() - lastWifiLog >= WIFI_LOG_MS) {
    lastWifiLog = millis();
    char msg[80];
    snprintf(msg, sizeof msg,
             "Wi-Fi down (status %d, %lu failed), dropping lines until it is back",
             (int)WiFi.status(), failed);
    logLine(msg);
  }
  wasConnected = connected;

  // The core's auto-reconnect alone did not rejoin the hotspot on the bench,
  // and a hidden hotspot can leave it "connected" with every POST failing,
  // so escalate after either lasts too long (ladders and timings in
  // wifi_watchdog.h). Neither step waits for Wi-Fi to come back.
  WifiPostResult post = lastPost;
  lastPost = WIFI_POST_NONE;
  WifiWatchdogAction action = wifiWatchdogUpdate(watchdog, millis(), connected, post);
  if (action == WIFI_WATCHDOG_NONE) return;
  bool posts = watchdog.cause == WIFI_WATCHDOG_CAUSE_POSTS;
  unsigned long afterS =
      (action == WIFI_WATCHDOG_REBOOT
           ? (posts ? WIFI_WATCHDOG_POST_REBOOT_MS : WIFI_WATCHDOG_REBOOT_MS)
           : (posts ? WIFI_WATCHDOG_POST_RESTART_MS : WIFI_WATCHDOG_RESTART_MS)) /
      1000UL;
  char msg[96];
  snprintf(msg, sizeof msg, "%s %lu s (status %d, %lu failed): %s",
           posts ? "POSTs failing" : "Wi-Fi down", afterS, (int)WiFi.status(),
           failed,
           action == WIFI_WATCHDOG_REBOOT ? "rebooting ESP" : "restarting Wi-Fi");
  logLine(msg);
  switch (action) {
    case WIFI_WATCHDOG_RESTART_WIFI:
      // Radio off and back on, then join again. Each mode change waits for
      // the radio (normally ~100 ms, at most 1 s); this runs at most once per
      // outage or failing streak, and nothing is getting through meanwhile.
      WiFi.disconnect();
      WiFi.mode(WIFI_OFF);
      WiFi.mode(WIFI_STA);
      WiFi.setAutoReconnect(true);  // as in setup()
      WiFi.begin(ECHO_WIFI_SSID, ECHO_WIFI_PASSWORD);
      break;
    case WIFI_WATCHDOG_REBOOT:
      // The ESP holds no alarm state; the Mega keeps alarming without it.
      Serial.flush();  // let the log line out first (a few ms)
      ESP.restart();
      break;
    default:
      break;
  }
}

void setup() {
  Serial.setRxBufferSize(SERIAL_RX_BUFFER);
  Serial.begin(SERIAL_BAUD);
  lineReaderInit(reader);
  newestLineInit(newest);

#ifdef ECHO_USING_EXAMPLE_SECRETS
  logLine("no secrets.h: Wi-Fi off, nothing is forwarded");
#else
  serverUrlOk = serverUrlIsIpv4Http(ECHO_SERVER_URL);
  if (!serverUrlOk) {
    logLine("server URL must be http://<IPv4>:<port>/status, not a hostname; not posting");
  }
  // The core reconnects on its own in the background; begin() does not block.
  WiFi.persistent(false);  // don't write the hotspot password to flash
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ECHO_WIFI_SSID, ECHO_WIFI_PASSWORD);
  wifiWatchdogInit(watchdog, millis());
#endif
}

void loop() {
#ifndef ECHO_USING_EXAMPLE_SECRETS
  watchWifi();
#endif
  // Drain the whole backlog and forward only the newest complete line, so a
  // slow POST never makes later statuses reach the server stale. Capped at one
  // buffer's worth so a flood of noise can't starve the Wi-Fi stack.
  for (size_t i = 0; i < SERIAL_RX_BUFFER && Serial.available() > 0; i++) {
    newestLineFeed(reader, newest, (char)Serial.read());
  }
  if (!newest.ready) return;
  newest.ready = false;
#ifndef ECHO_USING_EXAMPLE_SECRETS
  if (WiFi.status() == WL_CONNECTED) forward(newest.buf);
#endif
}
