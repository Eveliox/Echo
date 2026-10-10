// Template for firmware/esp/secrets.h, which is git-ignored and holds the real
// values. Copy this file to secrets.h next to it and fill in the three values.
// Never put real values in this file.
//
// The URL is the laptop's address on the hotspot plus the server's status
// route (docs/firmware.md, "Data format and Wi-Fi").
// It must be http:// plus an IP address, never a hostname: the ESP refuses
// to post to a hostname (see the time budget in esp.ino).

#ifndef ECHO_SECRETS_H
#define ECHO_SECRETS_H

#define ECHO_WIFI_SSID "your-hotspot-name"
#define ECHO_WIFI_PASSWORD "your-hotspot-password"
#define ECHO_SERVER_URL "http://LAPTOP_IP:PORT/status"

#endif  // ECHO_SECRETS_H
