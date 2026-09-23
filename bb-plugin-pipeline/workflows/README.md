# Pipeline

Pipeline turns an approved spec into a verified draft PR. This file owns roles, sizing, and the phase map; each phase document owns its phase.

Pipeline starts downstream of requirements: a spec sharp enough to plan against, filed as a ticket.

## Roles

- **Lead** — the parent agent running the flow: plans, orchestrates, gates, and talks to the user. An engineer first: it forms its own view of every decision, question, and round of findings before asking anyone to check it. The Oracle and the workers challenge that view and can overturn it; among the agents, the lead decides.
- **Oracle** — the lead's counterpart on design and decisions: proposes its own approach before it sees the lead's, challenges every claim with repo ground truth in hand, owns no deliverable, never writes code.
- **Workers** — everything else. Each phase document says what needs doing; the lead spawns what the moment needs, fresh, with only the context the job requires.

## The flows

Phases are documents stored on the BB server, read with `bb pipeline instructions <phase>`; `overview` is this document, and `--file <relative-path>` reads a supporting file under the phase. Kickoffs name the first phase to read; each phase's exit names the command that advances the run. Intake ends with the documented report that hands off to a separate lead. After the user approves a lead's phase transition, the lead reads the next phase and continues in its own thread; no separate slash command is needed.

**Intake:** a new card → `bb pipeline instructions intake` → ticket filed and tiered → approved handoff to a separate lead

**Feature:** approved spec → `bb pipeline instructions plan` → `bb pipeline instructions implement` → `bb pipeline instructions close-out`

**Bug:** `bb pipeline instructions debug` (RCA first) → the lead plans the fix on the evidence → `bb pipeline instructions implement` gates → `bb pipeline instructions close-out`

## Sizing

The user tiers the task during intake. The lead states the tier in one line and does not re-tier, except for a bug: its intake tier is provisional until the RCA stop, when the user tiers the diagnosed fix.

| Tier | Looks like | Flow |
|---|---|---|
| **Trivial** | Typo, one-liner, pure plumbing | Lead does it inline. Verify by exercising the changed behavior, not just tests. Short ticket filed at kickoff. Brief implementation walkthrough before close-out. No workers. |
| **Small** | Single-seam change, clear intent, low blast radius | Confirm intent in chat only if ambiguous. Short ticket at kickoff. A quick plan sanity-checked with Oracle — a round-trip, not a plan doc. One implementation worker. Reviewer passes, implementation walkthrough, then QA on the diff. Close out. |
| **Standard** | Multi-seam feature, new behavior, real design surface | Full flow: spec → plan → implement → close-out. |

Bugs get their final tier after the RCA; you cannot size what you have not diagnosed. Smaller tiers skip the plan walkthrough, but retain the implementation walkthrough in `bb pipeline instructions implement`: the user reviews what was built before QA and close-out.

## Non-negotiables

1. Every piece of work traces to a ticket; a few words filed at kickoff is enough.
2. The ticket is intent, not law. A requirement that is ambiguous, contradictory, or costs more than it is worth goes to the user with evidence, alternatives, and a recommendation. Update the ticket after the user decides.
3. Every plan and engineering decision goes through the Oracle before it becomes work, including changes of direction mid-flight. No decision becomes work silently.
4. Evidence before claims, at every gate.
5. Root cause before fixes.
6. Every non-trivial diff gets two independent reviewer passes, and user-facing behavior gets one QA smoke of the acceptance criteria; triviality is judged by consequence and risk, not diff size. Anything beyond that smoke is named in the plan, so the user sees it in the walkthrough before it runs.
7. Never non-trivial work on main without explicit consent.
8. Stop at a draft PR. Ready-for-review, merge, release, and external posting need the user's explicit go.
9. After code reviews clear, walk the user through the implementation one step at a time and wait for their final go before QA. `bb pipeline instructions implement` owns this gate and its rework rules.

## Artifacts

Working files live at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`, out of the repo:

- `run.md` — the lead's run card, created at kickoff before any plan and updated at every gate and every waiver:

  ```
  ticket: #NNNN            tier: trivial | small | standard
  base branch: <name>      work branch: <name>
  scope: <platforms, variants, device at hand>
  deadline: <none | date, reason>
  phase: plan | implement | close-out
  gates: oracle R1 R2 | review R1 (<harness>, <harness>) | walkthrough awaiting user | qa not started | bot pending
  walkthrough: commit <sha> | step N/M | awaiting user / approved
  waived: qa (user, date, reason)
  owed: <what is still due>
  ```

  Keep the implementation walkthrough's step outline beneath the run card so a resumed lead can continue at the recorded step. Record the user's final approval with the reviewed commit.

  Ticket, base branch, scope, and deadline are facts only the user holds: read them from the user's message, or ask once in the first reply. After a compaction, read this file before anything else, then the phase named on its phase line with `bb pipeline instructions <phase>`. If the path is lost, take the newest directory under `~/.ai/artifacts/<project>/`.
- `plan.md` — the implementation plan.
- `implementation-ledger.md` — material implementation decisions, deviations, trade-offs, open questions, and invalid-finding records; maintained by the implementer, audited by the lead.
- `rca.md` — reproduction, evidence chain, and root cause for bugs.

## Board

The card lives on the pipeline board. Report every column change and every stop for the user with `bb pipeline report` before the turn ends; the lines carry `--working` unless they state `--needs-you`:

| Phase | Moment | Report |
|---|---|---|
| intake | initial question | `--needs-you "<question in one line>"` |
| intake | each grill question | `--needs-you "<question in one line>"` |
| intake | tier question | `--needs-you "<question in one line>"` |
| intake | ready-to-plan question or no | `--needs-you "<question in one line>"` |
| plan | start of understand | `--column planning` |
| plan | any question to the user in understand or grill | `--needs-you "<question in one line>"` |
| plan | Shape done, plan.md settled, before the first walkthrough step | `--column plan_ready --needs-you "plan ready; walkthrough step 1 of M"` |
| plan | each later walkthrough step | `--needs-you "walkthrough step N of M"` (column stays plan_ready) |
| debug | RCA done, before any fix | `--needs-you "root cause found; tier the fix"` (column stays planning) |
| debug | user tiers the diagnosed fix | `--tier <t>` (column stays planning) |
| implement | start (right after the go on the last walkthrough step; no separate stop) | `--column implementing` |
| implement | review passes start | `--column reviewing` |
| implement | when findings send it back to the worker | `--column implementing` |
| implement | each implementation walkthrough step, after code reviews clear | `--column reviewing --needs-you "implementation walkthrough; step N of M"` |
| implement | walkthrough changes return to the worker | `--column implementing` |
| implement | QA starts | `--column qa` |
| implement | when QA sends it back | `--column implementing` |
| close-out | draft PR opened | `--column pr --pr <url>` |
| close-out | external review handoff | `bb pipeline review-wait`; end the turn |
| close-out | delivered feedback triaged | `bb pipeline review-wait --handled <batch-id>`; end the turn |
| any | lead stops for the user for another reason | `--needs-you "<why>"` |

Small and trivial tiers skip the plan walkthrough. Every tier reports its implementation walkthrough; small changes may need only one step.
