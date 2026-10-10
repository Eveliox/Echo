// Echo ESP8266: checks the box token from secrets.h at compile time. Plain
// C++ like line_reader.h (no headers needed), tested in
// firmware/mega/test/logic_test.cpp.
//
// The ESP sends the token in the X-Echo-Token header of every POST; the
// server compares it to ECHO_BOX_TOKEN in server/.env (server/auth.js).
// A usable token is non-empty, is not the placeholder from
// secrets.example.h, and uses only 0-9, A-Z, a-z, '_' and '-'. Anything else
// can differ between the two sides: the server's .env parser strips matching
// quotes (' " `) and may cut at '#', a backslash is literal in .env but an
// escape in the C string, and the server trims spaces. A hex token passes.

#ifndef ECHO_BOX_TOKEN_H
#define ECHO_BOX_TOKEN_H

// Must equal the ECHO_BOX_TOKEN placeholder in secrets.example.h (a test
// checks that the example's value is rejected).
#define BOX_TOKEN_PLACEHOLDER "your-box-token"

static constexpr bool boxTokenIsUsable(const char *token) {
  if (token == nullptr || token[0] == '\0') return false;
  const char *placeholder = BOX_TOKEN_PLACEHOLDER;
  bool samePlaceholder = true;
  int i = 0;
  for (; token[i] != '\0'; i++) {
    char c = token[i];
    bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
              (c >= 'a' && c <= 'z') || c == '_' || c == '-';
    if (!ok) return false;
    if (samePlaceholder && placeholder[i] != c) samePlaceholder = false;
  }
  if (samePlaceholder && placeholder[i] == '\0') return false;
  return true;
}

#endif  // ECHO_BOX_TOKEN_H
