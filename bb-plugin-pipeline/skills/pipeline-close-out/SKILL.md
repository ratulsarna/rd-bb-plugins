---
name: pipeline-close-out
description: Verify with fresh evidence, open a draft PR, and hand off.
---

# Pipeline: Close-out

## Process

1. **Fresh verification.** On the current tree, run the verification promised by the plan, the repository's required checks and tests, and an end-to-end smoke test of the changed behavior; capture real output. Broaden to subsystem or full-suite testing when repository rules, shared seams, or blast radius warrant it. If verification fails, stop here: report the failure with its output, no PR.
   For user-facing work, anything the user sees or interacts with, screen-record the smoke test showing the change working. The lead watches the final recording against the acceptance criteria before upload; if it does not show them, recapture. Upload only that file.
2. **Open a draft PR.** Push the branch and create the PR as a draft. Write the body per the `pr-descriptions` skill: what changed and why, behavior changes a reviewer must know, one line on verification. The detailed evidence (command output, QA detail, ledger entries, residual risks) goes in the chat report and the ticket, not the PR body.
   `bb pipeline report --column pr --pr <url> --working`
   User-facing work: the PR carries the video, attached with `gh pr create --attach <file>`. If the upload fails, say so in the report and give the user the local file path.
3. **Codex PR review loop.** Comment `@codex review` on the draft PR. Wait 7 minutes, then check for Codex's review. Silence is not a pass: if no review appears after repeated checks, tell the user instead of going on.
   Triage its findings by evidence and severity: the loop continues only on P1 or P2 correctness findings; P3s are batched as in review. Accepted fixes route by size:
   - a small fix: the owning worker, or the lead when a worker would add nothing, applies it; QA re-verifies a fix that touches behavior; then step 1 runs again before pushing.
   - a new seam or changed behavior: back through the review and QA gates in `pipeline-implement`, then close-out restarts from step 1.
   After accepted fixes, push and comment `@codex review` again; repeat until no unresolved P1 or P2 remains. A finding set aside is a ledger entry with the evidence; a repeat without new evidence is answered by that entry.
   `bb pipeline report --column pr_ready --needs-you "review clean; mark the PR ready and merge"`
   The draft PR is review-clean and waits for the user in `pr_ready`.
4. **Report to the user:** the draft PR link plus the same summary in chat, including the size line, the ledger entries, and how the PR review loop resolved. Then stop.
5. **Close the loop on the ticket.** Add the outcome and draft-PR link, then move its state per the team's convention. Close task-scoped workers once the PR review loop is green; Oracle stays for the session.

No AI attribution anywhere in git-facing text — commits, PR titles/bodies, branch names.
