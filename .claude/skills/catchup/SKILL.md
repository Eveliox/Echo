---
name: catchup
description: Start-of-session briefing for Echo. Reads the latest docs/notes.md entry, git status, the last 10 commits, and check results, then says in under 10 lines where work left off, what's half-done, and the next concrete step. Use when a session starts or the user asks where they left off. Read-only; changes nothing.
context: fork
agent: reviewer
---

Brief Eve on where the Echo work stands. Change nothing: no edits, no git state changes, no installs.

## Steps

1. **Notes.** Read the last `## ` entry in `docs/notes.md`. If the file is missing or empty, say "no notes yet".
2. **Git.** Run `git status --short --branch` and `git log --oneline -10`. If there are no commits, say so. If this isn't a git repo, say so and skip to step 3.
3. **Checks.** Read the Checks table in `CLAUDE.md` and run every row except `smoke`, exactly as written, from the repo root. Report a `TODO` row as SKIPPED, never as a pass. If a command is missing (for example `arduino-cli`), report `missing <tool>` for that row.
4. **Next step.** Pick one concrete next step:
   1. the notes' "Next" line, if still valid;
   2. otherwise fix the first failing check;
   3. otherwise the oldest open issue in `docs/backlog.md`.

## Output

Under 10 lines, nothing else:

```
Left off (<date/time of last note>): <one line>
Half-done: <uncommitted files with +/− counts, or "nothing uncommitted">
Recent: <last 1–3 commit subjects>
Checks: <row ✓|✗|SKIPPED|missing ...> (first failure at file:line, if any)
Next: <one concrete step, naming the file or issue #>
```
