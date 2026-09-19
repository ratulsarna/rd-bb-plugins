---
name: pipeline-implement
description: Build an approved plan through workers, then review and QA the landed change.
---

# Pipeline: Implement

## Dispatch

`bb pipeline report --column implementing --working`

A worker whose job has a template in `templates/` starts from it: read the file at dispatch time and fill only its `<<blanks>>`. A statement about what the code does today ("X already does Y") carries the file:line you opened at dispatch. If you have not opened it, hand it to the worker as something to check, not as a fact.

- Work happens on a work branch off the base branch in `run.md`.
- Never run parallel workers over the same files.

## Execution

- Continuous: no user approvals between tasks. Short milestone updates only.
- Workers own implementation decisions and tests. Answer their questions with the why, not just the answer. Check on a worker by reading its thread. Steer it only when it is going well off track, sparingly and with patience: a worker that is thinking is not stalled.
- A worker's "done" is a claim. Read the diff against the plan, and the evidence, before advancing to gates.
- Worker-raised questions resolve against the code and the plan. When the answer is a decision, put it to the Oracle session from planning; every objection ends in evidence that it does not hold or a change, and a reply without a read list is not a round. The user only for product or UX judgment.

## Review configuration

Which harnesses review, with what model and effort, and the review prompt every pass runs come from the environment's guidance. If it names none, ask the user once. If a binding is unavailable or the harness reports a different effective model or effort, stop and ask; never fall back silently.

## Implementation ledger

The lead keeps `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/implementation-ledger.md` with two kinds of entry: a deviation from the plan the lead agreed to, with why; and a review or QA finding set aside, with the evidence. Nothing else goes in it. Close-out reports from it, and a repeated finding without new evidence is answered by its entry, not by a new round.

## Change-level gates

One cycle over the landed change, where reviewers and QA see the whole picture:

1. **Size line, then two stranger reviews.** First, one size line from `git diff --stat` against the base: files, lines added and removed, production lines against test lines, new types or files. It goes in the close-out report. A change much larger than the plan said, or tests that outweigh the code they cover, is a step 3 trigger. Then two reviews, each a fresh session on a different harness per the environment's bindings. Each pass gets the review prompt the environment names, rendered for the exact full-branch diff scope, and nothing else: no ticket, no plan, no prior findings. If a reviewer misreads the diff's intent, fix the artifact (code comments, commit messages), not the reviewer's packet. Reviewers judge the code; whether it does what the ticket asked is the lead's and QA's question. Keep passes independent until both return.
   `bb pipeline report --column reviewing --working`
2. **Triage by severity.** Reconcile findings by evidence. The loop continues only on P1 or P2 correctness findings. P3 and polish are batched, judged together on whether each fix is worth its cost in code, and the ones worth taking ride along with required fixes in at most one round; a P3 alone never buys a round. A finding is set aside only when evidence shows it invalid, recorded in the ledger; a recurring finding without new evidence is resolved by that record, not by a new round.
3. **Step back** when any of these fire: round 3 of this loop is about to start; the same finding across two rounds contests the approach; a reviewer cites how sibling code handles the same concern; the size line is out of range.

   Between the agents: stop fixing. The lead rethinks, which choice the findings trace back to, whether the approach is wrong, and what shape the problem needs, and writes that down as a short note with the round history. A fresh Oracle session from `templates/oracle.md` gets the note, the plan, the diff, and the history, and one question: is this diagnosis right, and is that the shape the problem needs. Act on the answer. The rethought change is reviewed again; the round count carries on. One rethink per loop.

   Told to the user, work goes on: after the rethink, what the rounds found, what the fresh Oracle said, and what changed.

   Asked of the user, work waits: a trigger firing a second time, with the round history. A choice made to satisfy a requirement, contested by two reviewers or across two rounds: whether the requirement stands, with what keeping it costs and a recommendation.
4. **Re-review in proportion.** Fixes route to the owning worker. The scope of the next round is set by the triage count, not by what a reviewer said in prose:
   - one harness returned zero accepted P1 or P2 in the last full pass: one pass on one harness, diff scope the commits since that full pass, same payload as any pass;
   - both harnesses returned accepted P1 or P2: two full passes, as in step 1;
   - the fix commits touch only comments or docs: a lead read of the delta, no pass.
   Every pass is a fresh session; prior findings stay with the lead, not the reviewer.
   When findings send it back to the worker: `bb pipeline report --column implementing --working`
5. **QA worker** from `templates/qa.md`, after reviews clear. Give it the flows as the plan named them, not implementation reasoning. It designs its own steps within that and exercises real behavior, with whatever real-system tools are reachable. Findings are blocking: the owning worker fixes, the same QA session re-runs, and QA never changes code. A pass with any criterion not reached is partial, not clear: the unreached criteria run again after the blocker is fixed, or the user waives them, recorded in `run.md`.
   `bb pipeline report --column qa --working`
   When QA sends it back: `bb pipeline report --column implementing --working`
6. **Acceptance.** The lead maps the verified behavior back to the ticket; code review does not substitute for this judgment.

**Exit:** all gates clear → `pipeline-close-out`.
