---
name: wrap-up
description: End-of-session handoff for Echo. Summarizes today's diff and commits, decisions, open questions, and the next step, appends a dated entry to docs/notes.md, and warns about uncommitted work. Use when the user says they're stopping or ending the session. Never commits or pushes.
---

Write the handoff the next session needs, then stop. The only file you may change is `docs/notes.md`, and only by appending. Never commit, push, stash, or stage.

## Steps

1. **When was the last entry?** Read the last `## ` heading in `docs/notes.md`. If the file doesn't exist, this is the first entry; create it with a `# Echo session notes` title line.
2. **What changed?**
   - `git status --short`
   - `git diff --stat HEAD`, or `git diff --stat` if there are no commits yet
   - `git log --oneline --since="<last entry time>"`, or `-10` if there's no previous entry
3. **What was decided?** From this conversation, pull out decisions (with the one-line reason), open questions (and who must answer them: Eve or the hardware teammate), and anything half-done.
4. **What's next?** One concrete step that names a file, issue, or check.
5. **Append** the entry to `docs/notes.md`. Use the local time from `date "+%Y-%m-%d %H:%M"` for the heading:

   ```
   ## <YYYY-MM-DD HH:MM>
   Done: <what landed this session; commit subjects or files>
   Decisions: <decision — why> ...
   Open questions: <question (who)> ...
   Half-done / uncommitted: <files, state>
   Next: <one concrete step>
   ```

   Leave out any line that would be empty. Keep the entry under 15 lines.
6. **Warn** if `git status` showed uncommitted or untracked work. List the files and say they aren't committed. Do not offer to commit.

## Output

Print the entry exactly as appended, then the warning (if any):

```
Appended to docs/notes.md:
<entry>
⚠ <N> uncommitted files: <paths>
```
