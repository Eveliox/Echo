---
name: implement-ticket
description: Implements one GitHub issue end to end. Hands the ticket to the developer agent, optionally has the read-only reviewer verify the diff, then always runs the test-gate agent. Leaves changes uncommitted.
argument-hint: <issue#> [--verify | --no-verify]
disable-model-invocation: true
---

Implement GitHub issue `$ARGUMENTS`. The first argument is the issue number; the optional flags are `--verify` and `--no-verify`.

## Steps

1. **Fetch the ticket** with `gh issue view <N> --json number,title,body,labels,state`. If gh isn't logged in, stop and say to run `gh auth login`. If the issue is closed, ask before continuing. If the body has no acceptance criteria (checkboxes or an "Acceptance criteria" section), stop and ask Eve for them; test-gate needs them.
2. **Check the working tree** with `git status --short`. If there are uncommitted changes, list them and ask whether to continue, so the ticket's diff stays separable.
3. **Implement.** Spawn the `developer` agent with the full ticket (number, title, body). Tell it to follow `CLAUDE.md` and report in its standard format.
4. **Verify (optional).** Run the `reviewer` agent on the uncommitted diff when either:
   - `--verify` was passed, or
   - the diff touches a path listed under "Safety-critical paths" in `CLAUDE.md`, and `--no-verify` was not passed.

   Ask it for correctness bugs and Hardware-rule violations, ranked by severity with file:line, without running checks (test-gate does that next). If it reports a high-severity issue, send it to the developer agent for one fix pass before the gate.
5. **Gate. Always run this step.** Spawn the `test-gate` agent in `ticket` mode with the full ticket text.
6. **If test-gate rejects,** do one fix round: send its "Fix first" list to the developer agent (continue the same agent if possible, otherwise spawn a new one with the ticket and the findings), then run test-gate again. If it still rejects, stop and report; don't loop further.
7. **Report.** Never commit, push, or stage.

## Output

```
#<N> <title>: <implemented | partial | blocked>
Changed: <file (+/−)> ...
Verify (reviewer): <ran: N findings, fixed M | skipped: reason>
TEST-GATE: <APPROVE|REJECT> (<criteria covered>, <regressions>, <tampering>)
Needs hardware: <manual steps for the hardware teammate, if any>
Not committed. Suggested message: "<area>: <summary> (#<N>)"
```

If the gate rejected twice, replace the last two lines with test-gate's output and the developer's open risks.
