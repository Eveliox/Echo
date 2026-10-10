---
name: ship
description: Pushes Echo's local commits safely. Runs precommit-review on the outgoing commits, stops on FIX FIRST, runs the smoke check, shows exactly what will go out, and pushes only after Eve types yes. Never force-pushes, never commits, and never pushes past a failing check.
disable-model-invocation: true
---

Push the current branch's unpushed commits, but only if they're clean and Eve says yes. This is the only skill allowed to push. It never commits.

## Steps

1. **Where are we?**
   - `git rev-parse --abbrev-ref HEAD` gives the branch.
   - `git rev-parse --abbrev-ref @{u}` gives the upstream, if any.
   - If there are no commits, stop: "Nothing to ship."
2. **Sync check.** Run `git fetch origin` (read-only for your files).
   - If the branch has an upstream and is behind it (`git rev-list --count HEAD..@{u}` > 0), stop. Tell Eve to pull and resolve first. Never rebase, merge, or force anything.
3. **Range.** Use the first case that applies:
   1. The branch has an upstream: `@{u}..HEAD`.
   2. `origin/<branch>` exists: `origin/<branch>..HEAD`.
   3. Another remote-tracking branch exists (a new branch): `origin/<default>..HEAD`, where `<default>` comes from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `origin/main`.
   4. No remote-tracking refs at all (first push to an empty remote): the range is `--root`, meaning every commit on HEAD.

   List the commits with `git log --oneline <range>` (for `--root`, `git log --oneline HEAD`). If there are none, stop: "Nothing to ship."
4. **Uncommitted work.** If `git status --short` shows changes, warn that they won't be included. Don't commit them. The review in step 5 checks the commits themselves, so local changes can't mask a broken push.
5. **Review.** Run the `precommit-review` skill with the range (or `--root`). If it says FIX FIRST, print its findings and stop. If it says "Nothing to review.", stop and report that; something is wrong with the range.
6. **Smoke.** Run the `smoke` row from the Checks table in `CLAUDE.md`.
   - If it fails, print the failure and stop.
   - If it's `TODO`, say "smoke: SKIPPED (TODO)". That is not a pass, but it doesn't block the push.
7. **Show what goes out:**
   - `git log --oneline <range>`
   - `git diff --stat <range>`, or for `--root`, `git diff --stat $(git hash-object -t tree /dev/null) HEAD`

   Ask: "Push <N> commits to origin/<branch>? Type yes."
8. **Wait.** Only a literal `yes` proceeds. Anything else: stop, nothing pushed.
9. **Push.** Use `git push origin <branch>`, plus `-u` on the branch's first push. Never pass `--force`, `-f`, or `--force-with-lease`. If the push is rejected, stop and report; don't retry with force.
10. **Report.**

## Output

```
precommit-review: SHIP (<findings summary>)
smoke: <pass | SKIPPED (TODO)>
<N> commits → origin/<branch>:
  <sha> <subject>
  ...
<diffstat summary>
Push <N> commits to origin/<branch>? Type yes.
```

After the push:

```
Pushed <N> commits to origin/<branch> (<old>..<new>).
```
