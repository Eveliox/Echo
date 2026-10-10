---
name: pm
description: Product check-in for Echo. Compares what's built against docs/brief.md, docs/firmware.md, and docs/backlog.md with the clock in mind, proposes new tickets, has the read-only reviewer verify each one, and posts to GitHub only after Eve approves.
disable-model-invocation: true
---

Find the most valuable gaps between the briefs and the repo, and propose tickets for them.

## Steps

1. **Read** `CLAUDE.md`, `docs/brief.md`, `docs/firmware.md`, `docs/backlog.md`, and the latest entry in `docs/notes.md`.
2. **Gather state:**
   - the repo tree and `git log --oneline -20`;
   - `gh issue list --state all --limit 100 --json number,title,state,labels`;
   - the current time from `date`.

   If gh isn't logged in, continue from `docs/backlog.md` alone and say so.
3. **Where are we on the clock?** Compare the time with the brief's timeline. Name the current block, the next milestone, and the time left to it.
4. **Gap analysis.** For each item the brief or firmware doc requires by the next milestone, decide:
   - whether it's built (cite file evidence);
   - whether it's ticketed (cite the issue #);
   - whether it matters for the demo.

   Only unbuilt, unticketed, demo-relevant gaps become proposals. Apply the brief's cut rule (the paragraph after its timeline) as written: check whether the slice works end to end, and don't paraphrase the rule.
5. **Draft up to 6 tickets** in the same format as `plan-slice`: area-prefixed title, owner, 2–4 testable acceptance criteria, "Proven by" checks or manual step, dependencies, and size.
6. **Verify.** Spawn the `reviewer` agent with the draft tickets. Ask it to check, for each one:
   - the gap is real (search the repo for an existing implementation);
   - it isn't a duplicate of an open or closed issue or a backlog entry;
   - each acceptance criterion can be proven by a check or a named manual step;
   - it fits the time left.

   It returns `KEEP` or `DROP: <reason with file:line or issue #>` for each ticket.
7. **Show** the status line, then the tickets with the reviewer's verdicts. Dropped tickets are shown with their reason, never posted. Ask: "Post <letters>? (yes / edit)". Stop and wait for a clear yes.
8. **On yes,** check `gh auth status`, then run `gh issue create` for each approved ticket (labels `hw`/`sw`), and append them to `docs/backlog.md` with their issue numbers.

## Output

```
<Day HH:MM>: <current block>. <time> to <next milestone>.
Slice: <closed>/<total> done; open: <#s>
A  <title>  <hw|sw>  ✓ verified
B  <title>  <hw|sw>  ✓ verified
C  <title>  <hw|sw>  ✗ dropped: <reason>
Post A and B? (yes / edit)
```

## Never

- Post issues before an explicit yes.
- Edit code.
- Commit or push.
