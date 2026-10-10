// Echo ESP8266 NodeMCU: the box's Wi-Fi modem. Wiring, baud, and Wi-Fi setup:
// docs/firmware.md, "Mega to ESP8266 link" and "Data format and Wi-Fi".
// Reads the Mega's lines on Serial (RX pin) and POSTs each status line to the
// server as it arrives. It only forwards: it decides nothing about the box and
// sends nothing to the Mega except "#" log lines, which the Mega never acts on.
// Nothing here waits for Wi-Fi: lines that arrive while it is down are dropped
// and the next status (one every 2 s) goes out once it is back.
//
// Wi-Fi name, password, and server URL come from secrets.h (git-ignored; copy
// secrets.example.h). Without it the sketch still compiles, from the example's
// placeholders, so the build check works on a fresh checkout; it then never
// joins Wi-Fi and says so on the Serial Monitor.

#if __has_include("secrets.h")
#include "secrets.h"
#else
#warning "firmware/esp/secrets.h missing: building with placeholders from secrets.example.h; this ESP will not forward anything"
#include "secrets.example.h"
#define ECHO_USING_EXAMPLE_SECRETS 1
#endif

#include <ESP8266WiFi.h>
#include <ESP8266HTTPClient.h>

#include "line_reader.h"
#include "server_url.h"

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
  int code = http.POST((const uint8_t *)line, strlen(line));
  http.end();
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
    logLine("Wi-Fi down, dropping lines until it is back");
  }
  wasConnected = connected;
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
