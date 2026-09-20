---
name: pipeline-plan
description: The lead grounds in the code, syncs with the user on the task, shapes the design with the Oracle, and walks the user through the plan before any coding. Use when an approved spec is ready to build.
---

# Pipeline: Plan

## Ground

Create `run.md` per `references/pipeline-README.md` first. Then learn how the relevant behavior works today, where responsibility lives, and which existing patterns fit. Spawn as many workers in parallel as the task needs, wide or deep, each returning evidence with file:line. A worker's summary is a pointer; the lead reads what it points at before planning on it.

## Understand, with the user

`bb pipeline report --column planning --working`

Tell the user what you understand the task to be, checked against what your research found, and what research could not settle: a technical call that needs human judgment, a business rule that is unclear, or a design preference that changes how it gets built. Open questions go to `/grill-me` (Codex: `$grill-me`). If the user corrects you, verify the correction yourself before moving on. Fold every answer back into the ticket. No plan until the user says the picture is right.

`bb pipeline report --needs-you "<question in one line>"`

## Shape

Lay out the real ways to build it; your first idea is one of them, not the default. Open the Oracle session with the brief in `templates/oracle.md`; it stays up for the whole run, and from there it is a conversation. Then a blind Oracle round: the ticket and the agreed picture, nothing of yours, and the question: how would you build this. From there, work it out as a duo: put your ways next to its approach, challenge each other's assumptions, and hash out the best-designed solution together. Every claim either side makes ends in evidence from the repo or a change of mind; a reply without a read list is not a round. The lead has the final say. If the design work shows that what you and the user agreed the task to be was wrong, go back to the user before going on.

The lead writes `plan.md` as the design settles; the Oracle reads and challenges each draft. Shape ends when the Oracle has no objection left to the written plan that is not answered with evidence, taken into the plan, or ruled on by the lead.

The plan contract. Written for the worker who builds from it; go as deep as the change needs, down to code where code says it best:

- how the relevant behavior works today, with file:line;
- the approach and why, and the ways set aside and why;
- exact scope and task breakdown;
- what is out of scope;
- files or seams to touch;
- where the design surface is real, a design sketch in code blocks: types, signatures, call flow, and the code itself where the code is the decision;
- expected tests and exact verification commands, and for each manual check: what it runs against, the data or account it needs, and how you know the case can be reached at all;
- acceptance-criteria mapping back to the spec;
- risk notes; rollback where relevant.

Every item resolved; "TBD" or "handle later" is a gap the worker fills by guessing. Plans describe the change, never the process: gates, review, and delivery live in these skills, and a worker given process in a plan follows the plan.

Artifact: `plan.md` at `~/.ai/artifacts/<project>/YYYY-MM-DD-<topic>/`.

Real blast radius (migrations, auth, data-loss surfaces, anything hard to roll back) buys one independent read of the plan by a fresh worker that saw none of the design work. Risk, not habit, buys it; take its findings back into Shape by evidence and severity.

## Walkthrough — the user's review

`bb pipeline report --column plan_ready --needs-you "plan ready; walkthrough step 1 of M"`

Tell the user the plan is ready, and nothing more. Then walk them through it one step at a time, up to five or six steps: what we are solving and how, what path we are taking, with visuals and code snippets where they help. Use `/show-me` for each step. One step per turn; never all the steps at once. An objection at any step goes back to Shape, with the Oracle still up.

`bb pipeline report --needs-you "walkthrough step N of M"`

**Exit:** the user gives the go after the last step → `pipeline-implement`.
