// Template for firmware/esp/secrets.h, which is git-ignored and holds the real
// values. Copy this file to secrets.h next to it and fill in the four values.
// Never put real values in this file.
//
// The URL is the laptop's address on the hotspot plus the server's status
// route (docs/firmware.md, "Data format and Wi-Fi").
// It must be http:// plus an IP address, never a hostname: the ESP refuses
// to post to a hostname (see the time budget in esp.ino).
//
// The box token is sent in the X-Echo-Token header of every POST and must
// match ECHO_BOX_TOKEN in server/.env exactly. Use a hex token, e.g. from
// `openssl rand -hex 24`. Only 0-9, A-Z, a-z, '_' and '-' are allowed: the
// sketch does not compile with this placeholder, an empty token, or any other
// character (box_token.h).

#ifndef ECHO_SECRETS_H
#define ECHO_SECRETS_H

#define ECHO_WIFI_SSID "your-hotspot-name"
#define ECHO_WIFI_PASSWORD "your-hotspot-password"
#define ECHO_SERVER_URL "http://LAPTOP_IP:PORT/status"
#define ECHO_BOX_TOKEN "your-box-token"

#endif  // ECHO_SECRETS_H
