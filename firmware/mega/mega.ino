// Echo box: Arduino Mega 2560. Pins, thresholds, and levels: docs/firmware.md.
// Sensor reading, the status line, and the local alarm come in later tickets.

#include "logic.h"

AlertState alertState;

void setup() {
  alertInit(alertState);
}

void loop() {
}
