---
name: precommit-review
description: Read-only review of Echo's uncommitted changes, or of a commit range if given. Checks correctness bugs, Hardware-rule violations, missing tests for new behavior, secrets (API keys, Twilio credentials, Wi-Fi passwords), and leftover debug code, then runs the checks. Verdict SHIP or FIX FIRST with findings ranked by severity. Use before committing. Never edits code.
argument-hint: "[commit range like origin/main..HEAD, or --root]"
context: fork
agent: reviewer
---

Review the Echo changes and give a verdict. Change nothing.

## Scope

- If a range `A..B` was given (`$ARGUMENTS`), review `git diff A..B` and `git log --oneline A..B`.
- If `--root` was given (every commit, used for a first push), review `git diff $(git hash-object -t tree /dev/null) HEAD` and `git log --oneline HEAD`.
- Otherwise review uncommitted work: `git diff HEAD` (or `git diff` plus `git diff --cached` if there are no commits yet) and every untracked file from `git ls-files --others --exclude-standard`.
- If the scope is empty, print `Nothing to review.` and stop.

Read the changed files in full where the diff alone isn't enough to judge.

## What to check

1. **Correctness bugs:** logic errors, off-by-one, unit mix-ups (°F vs °C, ms vs s), null handling for every status field `docs/firmware.md` says can be null, and races in timers.
2. **Hardware rules** from `CLAUDE.md`, all of them. In particular:
   - any change to the status JSON fields compared with `docs/firmware.md`;
   - anything over Wi-Fi that could lower or silence an alarm;
   - `analogWrite` on pins 9 or 10;
   - `Arduino.h` or STL includes in `logic.h`.
3. **Missing tests:** new or changed behavior with no test that would catch it breaking.
4. **Secrets:**
   - Twilio Account SIDs (`AC` + 32 hex) and API keys (`SK` + 32 hex);
   - auth tokens (32 hex next to "token");
   - Google API keys (`AIza`);
   - Telegram bot tokens (`digits:` + 35 characters);
   - any `.env` file;
   - SSID or password string literals in `firmware/esp/`.

   A secret is always HIGH.
5. **Debug leftovers:** `console.log` / `print` debugging, `debugger`, `.only`, `// DEBUG` / `// TODO remove`, large commented-out blocks, and hardcoded test phone numbers. Debug prints on the Mega's USB serial are fine; any extra write on the serial port that carries the JSON line to the ESP8266 (see `docs/firmware.md`) is HIGH, because it corrupts the status message.
6. **Checks:** run every Checks row in `CLAUDE.md` except `smoke`, exactly as written. A `TODO` row is SKIPPED.
   - With no range, run them in the repo.
   - With a range or `--root`, run them against the commits, not the working tree: export the range's end commit with `git archive <end> | tar -x -C "${TMPDIR:-/tmp}/echo-review-<sha>"` and run each row as `cd <that folder> && <command>`. This way uncommitted local changes can't make a broken commit pass.

## Verdict

FIX FIRST if there's any HIGH finding, any secret, or any non-TODO check failing. Otherwise SHIP.

## Output

```
<SHIP | FIX FIRST>
1. HIGH  <file:line>  <what's wrong and what breaks>. <fix in a few words>
2. MED   ...
3. LOW   ...
Checks: <row ✓|✗|SKIPPED> ...
```

Severity: HIGH breaks the demo, safety, or leaks a secret. MED is a likely bug or a missing test. LOW is cleanup. If there are no findings, print `No findings.` under the verdict.
