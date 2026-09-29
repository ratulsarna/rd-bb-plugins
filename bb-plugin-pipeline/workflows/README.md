# Pipeline

Pipeline turns an approved spec into a verified draft PR. This file owns roles, sizing, and the phase map; each phase document owns its phase.

Pipeline starts downstream of requirements: a spec sharp enough to plan against, filed as a ticket.

## Roles

- **Lead** — the parent agent running the flow: plans, orchestrates, gates, and talks to the user. An engineer first: it forms its own view of every decision, question, and round of findings before asking anyone to check it. The Oracle and the workers challenge that view and can overturn it; among the agents, the lead decides.
- **Oracle** — the lead's counterpart on design and decisions: proposes its own approach before it sees the lead's, challenges every claim with repo ground truth in hand, owns no deliverable, never writes code.
- **Workers** — everything else. Each phase document says what needs doing; the lead spawns what the moment needs, fresh, with only the context the job requires.

## The flows

Phases are documents stored on the BB server, read with `bb pipeline instructions <phase>`; `overview` is this document, and `--file <relative-path>` reads a supporting file under the phase. Kickoffs name the first phase to read; each phase's exit names the command that advances the run. Intake ends with the documented report that hands off to a separate lead. After a lead's phase exit clears, with the user's approval where its mode asks for one, the lead reads the next phase and continues in its own thread.

**Intake:** a new card → `bb pipeline instructions intake` → ticket filed, mode and size set → approved handoff to a separate lead

**Imported issue:** a card imported from an open GitHub issue → `bb pipeline instructions intake` (scope only) → approved handoff to a separate lead → feature or bug flow from there

**Feature:** approved spec → `bb pipeline instructions plan` → `bb pipeline instructions implement` → `bb pipeline instructions close-out`

**Bug:** `bb pipeline instructions debug` (RCA first) → the lead plans the fix on the evidence → `bb pipeline instructions implement` gates → `bb pipeline instructions close-out`

## Mode and size

The card carries two settings, both the user's call: mode and size.

| Mode | The user is needed |
|---|---|
| **Manual** | At every stop in the phase documents. |
| **Auto** | For the implementation walkthrough, after QA, and for what only the user can decide: product or UX judgment, a contested requirement, a step-back trigger firing a second time, a QA waiver, a missing credential. The lead makes the calls those stops would have put to the user: its understanding, the plan, a bug's size. |

| Size | Who builds |
|---|---|
| **Small** | The lead writes the code. |
| **Standard** | A developer worker writes the code, per `bb pipeline instructions implement`. |

The user sets both, on the card or during intake. The lead states them in one line and does not change them, except a bug's size: it is provisional until the RCA; you cannot size what you have not diagnosed. In manual the user sizes the diagnosed fix at the RCA stop; in auto the lead sizes it and tells the user.

The user can change either setting mid-run. Pipeline tells the lead, which follows the new setting from its next stop or gate and records the change in `run.md`; passed gates are not redone.

## Non-negotiables

1. Every piece of work traces to a ticket; a few words filed at kickoff is enough.
2. The ticket is intent, not law. A requirement that is ambiguous, contradictory, or costs more than it is worth goes to the user with evidence, alternatives, and a recommendation. Update the ticket after the user decides; for an imported issue, record that update in the card's local notes with `bb pipeline report --body-file <path>`.
3. Every plan and engineering decision goes through the Oracle before it becomes work, including changes of direction mid-flight. No decision becomes work silently.
4. Evidence before claims, at every gate.
5. Root cause before fixes.
6. Every diff gets two independent reviewer passes, and user-facing behavior gets one QA smoke of the acceptance criteria. Anything beyond that smoke is named in the plan, so in manual the user sees it in the walkthrough before it runs.
7. Never non-trivial work on main without explicit consent.
8. Stop at a draft PR. Ready-for-review, merge, release, and external posting need the user's explicit go.
9. Walk the user through the implementation one step at a time and wait for their final go: in manual after code reviews clear and before QA, in auto after QA and before close-out. `bb pipeline instructions implement` owns this gate and its rework rules.

## Artifacts

Working files live at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`, out of the repo:

- `run.md` — the lead's run card, created at kickoff before any plan and updated at every gate and every waiver:

  ```
  ticket: #NNNN            mode: manual | auto      size: small | standard
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

The card tracks workflow state only. Questions, explanations, options, walkthroughs, and approval requests belong in the owning thread's user-facing chat. Before ending a turn awaiting the user, give them the question or current walkthrough step and the decision needed in that reply. The user answers in the thread.

`bb pipeline report` updates state; it does not send that reply or create an approval interaction. Use `--needs-you` for a short waiting reason, such as "scope decision" or "walkthrough step 2 of 4", rather than the discussion itself. Report every column change and every stop for the user before the turn ends; the lines carry `--working` unless they state `--needs-you`:

| Phase | Moment | Report |
|---|---|---|
| intake | initial question | `--needs-you "task clarification"` |
| intake | each grill question | `--needs-you "<short waiting reason>"` |
| intake | mode or size question, when the card lacks one | `--needs-you "mode and size"` |
| intake | ready-to-plan question or no | `--needs-you "approval to begin planning"` |
| plan | start of understand | `--column planning` |
| plan | any question to the user in understand or grill | `--needs-you "<short waiting reason>"` |
| plan | manual: Shape done, plan.md settled, before the first walkthrough step | `--column plan_ready --needs-you "plan ready; walkthrough step 1 of M"` |
| plan | each later walkthrough step | `--needs-you "walkthrough step N of M"` (column stays plan_ready) |
| debug | manual: RCA done, before any fix | `--needs-you "root cause found; size the fix"` (column stays planning) |
| debug | the diagnosed fix is sized | `--size <s>` (column stays planning) |
| implement | start (right after the go on the last walkthrough step, or when Shape ends in auto; no separate stop) | `--column implementing` |
| implement | review passes start | `--column reviewing` |
| implement | when findings send it back to the worker | `--column implementing` |
| implement | each implementation walkthrough step, after code reviews clear (auto: after QA clears) | `--column reviewing --needs-you "implementation walkthrough; step N of M"` |
| implement | walkthrough changes return to the worker | `--column implementing` |
| implement | QA starts | `--column qa` |
| implement | when QA sends it back | `--column implementing` |
| close-out | draft PR opened | `--column pr --pr <url>` |
| close-out | external review handoff | `bb pipeline review-wait`; end the turn |
| close-out | delivered feedback triaged | `bb pipeline review-wait --handled <batch-id>`; end the turn |
| any | lead stops for the user for another reason | `--needs-you "<why>"` |

In auto, the plan walkthrough and RCA stop rows do not apply. A small change's implementation walkthrough may need only one step.
