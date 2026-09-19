# Pipeline

Pipeline turns an approved spec into a verified draft PR. This file owns roles, sizing, and the phase map; each skill owns its phase.

Pipeline starts downstream of requirements: a spec sharp enough to plan against, filed as a ticket.

## Roles

- **Lead** — the parent agent running the flow: plans, orchestrates, gates, and talks to the user. An engineer first: it forms its own view of every decision, question, and round of findings before asking anyone to check it. The Oracle and the workers challenge that view and can overturn it; among the agents, the lead decides.
- **Oracle** — the lead's counterpart on design and decisions: proposes its own approach before it sees the lead's, challenges every claim with repo ground truth in hand, owns no deliverable, never writes code.
- **Workers** — everything else. Each skill says what needs doing; the lead spawns what the moment needs, fresh, with only the context the job requires.

## The flows

**Feature:** approved spec → `pipeline-plan` → `pipeline-implement` → `pipeline-close-out`

**Bug:** `pipeline-debug` (RCA first) → the lead plans the fix on the evidence → `pipeline-implement` gates → `pipeline-close-out`

## Sizing

The user tiers the task during intake. The lead states the tier in one line and does not re-tier, except for a bug: its intake tier is provisional until the RCA stop, when the user tiers the diagnosed fix.

| Tier | Looks like | Flow |
|---|---|---|
| **Trivial** | Typo, one-liner, pure plumbing | Lead does it inline. Verify by exercising the changed behavior, not just tests. Short ticket filed at kickoff. No workers. |
| **Small** | Single-seam change, clear intent, low blast radius | Confirm intent in chat only if ambiguous. Short ticket at kickoff. A quick plan sanity-checked with Oracle — a round-trip, not a plan doc. One implementation worker. Reviewer passes + QA on the diff. Close out. |
| **Standard** | Multi-seam feature, new behavior, real design surface | Full flow: spec → plan → implement → close-out. |

Bugs get their final tier after the RCA; you cannot size what you have not diagnosed. Smaller tiers drop the user touchpoints, not the gates: the short ticket and the draft PR carry the record.

## Non-negotiables

1. Every piece of work traces to a ticket; a few words filed at kickoff is enough.
2. The ticket is intent, not law. A requirement that is ambiguous, contradictory, or costs more than it is worth goes to the user with evidence, alternatives, and a recommendation. Update the ticket after the user decides.
3. Every plan and engineering decision goes through the Oracle before it becomes work, including changes of direction mid-flight. No decision becomes work silently.
4. Evidence before claims, at every gate.
5. Root cause before fixes.
6. Every non-trivial diff gets two independent reviewer passes, and user-facing behavior gets one QA smoke of the acceptance criteria; triviality is judged by consequence and risk, not diff size. Anything beyond that smoke is named in the plan, so the user sees it in the walkthrough before it runs.
7. Never non-trivial work on main without explicit consent.
8. Stop at a draft PR. Ready-for-review, merge, release, and external posting need the user's explicit go.

## Artifacts

Working files live at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`, out of the repo:

- `run.md` — the lead's run card, created at kickoff before any plan and updated at every gate and every waiver. Eight lines:

  ```
  ticket: #NNNN            tier: trivial | small | standard
  base branch: <name>      work branch: <name>
  scope: <platforms, variants, device at hand>
  deadline: <none | date, reason>
  phase: plan | implement | close-out
  gates: oracle R1 R2 | review R1 (<harness>, <harness>) | qa R1 blocked | bot pending
  waived: qa (user, date, reason)
  owed: <what is still due>
  ```

  Ticket, base branch, scope, and deadline are facts only the user holds: read them from the user's message, or ask once in the first reply. After a compaction, read this file before anything else, then the skill named on its phase line. If the path is lost, take the newest directory under `~/.ai/artifacts/<project>/`.
- `plan.md` — the implementation plan.
- `implementation-ledger.md` — material implementation decisions, deviations, trade-offs, open questions, and invalid-finding records; maintained by the implementer, audited by the lead.
- `rca.md` — reproduction, evidence chain, and root cause for bugs.

## Board

The card lives on the pipeline board. Report every column change and every stop for the user with `bb pipeline report` before the turn ends; the lines carry `--working` unless they state `--needs-you`:

| Skill | Moment | Report |
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
| implement | QA starts | `--column qa` |
| implement | when QA sends it back | `--column implementing` |
| close-out | draft PR opened | `--column pr --pr <url>` |
| close-out | draft PR review-clean, waiting for the user | `--column pr_ready --needs-you "review clean; mark the PR ready and merge"` |
| any | lead stops for the user for another reason | `--needs-you "<why>"` |

Small and trivial tiers skip the walkthrough, so the walkthrough reports do not occur on those flows.
