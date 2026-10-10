---
name: plan-slice
description: Turns docs/brief.md and docs/firmware.md into the brief's first thin vertical slice, written as 6–12 tickets in docs/backlog.md, and opens them as GitHub issues only after Eve approves the list.
disable-model-invocation: true
---

Plan the first vertical slice and, after explicit approval, post it as GitHub issues.

## Steps

1. **Read** `CLAUDE.md`, `docs/brief.md`, and `docs/firmware.md`. Take the slice definition from the brief's "First vertical slice" line and the owners from its team table. Don't invent scope; anything outside the slice goes in a "Later" list.
2. **Look at what exists:** the repo tree and `git log --oneline -20`, so you don't ticket finished work.
3. **Write 6–12 tickets.** Each ticket is one reviewable change (roughly 1–3 hours) and has:
   - a title starting with its area (`mega:`, `esp:`, `server:`, `sim:`, `app:`);
   - an owner: hardware or software, per the brief's team table;
   - acceptance criteria: 2–4 checkboxes, each one something a test or a named manual hardware step can prove;
   - "Proven by": the Checks row(s) from `CLAUDE.md` that will cover it, or "manual hardware check";
   - dependencies (other ticket numbers) and a size (S or M).

   Order the tickets so the slice works end to end as early as possible. Thresholds, pins, and formats are referenced by doc section, not copied.
4. **Write the draft** to `docs/backlog.md`. If the file already exists, show what's there and ask before overwriting. Use this format:

   ```
   # Backlog
   ## Slice: <slice line from the brief>
   ### 1. <title>
   Owner: <hw|sw> · Size: <S|M> · Depends on: <#s or none> · Issue: (not posted)
   - [ ] <acceptance criterion>
   Proven by: <checks or manual step>
   ## Later
   - <item>
   ```
5. **Show the list** as a table (number, title, owner, proven by, size), then ask: "Post these N issues to <owner/repo>? (yes / edit)". Stop and wait. Any reply other than a clear yes means revise and ask again.
6. **Before posting,** check `gh auth status` and `git remote -v`. If either fails, stop and print the command Eve needs to run.
7. **On yes,** create labels if missing (`gh label create slice`, `hw`, `sw`; ignore "already exists"), then for each ticket run `gh issue create --title ... --body ... --label slice --label <hw|sw>`. The body holds the acceptance criteria, "Proven by", and dependencies.
8. **Record** each issue number in `docs/backlog.md` (`Issue: #N`) and print the final table with the numbers.

## Never

- Post issues before an explicit yes.
- Commit or push `docs/backlog.md`.
