// Echo ESP8266: checks the server URL from secrets.h before any POST. Plain
// C++ like line_reader.h (only <stdint.h>), tested in
// firmware/mega/test/logic_test.cpp.
//
// The URL must be "http://" plus an IPv4 address (optional ":port", optional
// path). A hostname is rejected because its DNS lookup would add another
// timeout to each POST and break the time budget in esp.ino; https is
// rejected because the sketch uses a plain WiFiClient.

#ifndef ECHO_SERVER_URL_H
#define ECHO_SERVER_URL_H

#include <stdint.h>

static inline bool serverUrlIsIpv4Http(const char *url) {
  if (url == 0) return false;
  const char *prefix = "http://";
  for (uint8_t i = 0; prefix[i] != '\0'; i++) {
    if (url[i] != prefix[i]) return false;
  }
  const char *p = url + 7;
  for (uint8_t part = 0; part < 4; part++) {
    if (part > 0) {
      if (*p != '.') return false;
      p++;
    }
    uint16_t value = 0;
    uint8_t digits = 0;
    while (*p >= '0' && *p <= '9') {
      if (++digits > 3) return false;
      value = value * 10 + (uint16_t)(*p - '0');
      p++;
    }
    if (digits == 0 || value > 255) return false;
  }
  return *p == '\0' || *p == ':' || *p == '/';
}

#endif  // ECHO_SERVER_URL_H
