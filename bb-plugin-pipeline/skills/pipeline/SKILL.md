---
name: pipeline
disable-model-invocation: true
description: "Work the pipeline board: add, import GitHub issues, start, list, show, move, pause, and resume tasks. Specify a machine; optionally choose separate intake and lead models and reasoning. Upload attachments first."
---

# Pipeline: Board

Every task is a card on the pipeline board: a title, a note, a machine, attachments, and a column. The columns, in order: `backlog`, `todo`, `planning`, `plan_ready`, `implementing`, `reviewing`, `qa`, `pr`, `pr_ready`, `done`. Adding a card saves it in Backlog. Pass `--start` to place it in To do and launch intake. A saved task creates no thread or queued message until explicitly started.

## Commands

- `bb pipeline instructions [overview|intake|plan|implement|debug|close-out] [--file <relative-path>]` — read the workflow document or phase template when working on a Pipeline task.

- `bb pipeline add --title <t> --machine <id-or-name> [--start] [--body <text>] [--attachment <uploaded-path>]... [--project <id>]` — create a card on the explicitly chosen machine. `--project` defaults to the current project.
- `bb pipeline start <card-id> [--machine <id-or-name>] [execution overrides]` — start intake for a saved task using its stored machine, models, notes, and attachments; the flags accept the same machine and execution overrides as `add`. Repeated Start requests do not launch again; use Retry after a failed start.
- `bb pipeline set-machine <card-id> --machine <id-or-name>` — assign a machine to a card that has none. An assigned machine cannot be changed.
- `bb pipeline list [--project <id>] [--all]` — the board's cards; `done` is hidden unless `--all`.
- `bb pipeline issues [--project <id>] [--page <n>]` — the project's open GitHub issues assigned to the BB server's account, page by page, each with the card it is imported to, if any.
- `bb pipeline import-issues <number>... [--project <id>]` — import issues as Backlog cards carrying the full issue snapshot; up to 50 per call, and an already-imported issue returns its existing card.
- `bb pipeline show <card-id>` — the card, its history, and its threads.
- `bb pipeline queue [--project <id>]` — running and waiting tasks by machine, including each wait reason and the selected next task.
- `bb pipeline run-next <card-id>` — favor this waiting task when a slot opens on its project and machine.
- `bb pipeline run-next <card-id> --clear` — clear that selection if it is still current.
- `bb pipeline github-sync <card-id>` — refresh the linked PR, checks, and review status; retry an unknown review classification.
- `bb pipeline report --body <text>` or `bb pipeline report --body-file <path>` — store local scope notes on the card; `--body-file` requires a BB thread and reads the file from that thread's machine.
- `bb pipeline review-wait [--card <id>] [--handled <batch-id>]` — hand off external review from the owning lead. It posts the configured request once per revision; an empty `reviewRequestComment` uses automatic reviews. End the turn after the command succeeds.
- `bb pipeline review-retry <card-id>` — retry a cancelled or failed review follow-up. Check the lead first if delivery was unconfirmed.
- `bb pipeline retry <card-id>` — retry a failed or cancelled kickoff. A cancelled kickoff uses its existing thread and waits for capacity.
- `bb pipeline pause <card-id>` — ask the owner to pause gracefully and hold new work.
- `bb pipeline resume <card-id>` — continue a Paused task through the normal capacity gate.
- `bb pipeline stop <card-id>` — hard-stop the task and occupied descendants; use when graceful pause cannot finish.
- `bb pipeline move <card-id> <column>` — move a card by hand. Moving to planning starts its lead thread if needed and waits for capacity; other moves update the board.

Use `add` to capture a task for later. Start it before moving stages, pausing, stopping, or resuming; saved tasks can be removed without starting. Start puts the task in To do; a started task cannot return to Backlog. The UI offers **Save** and **Save and start**, and a saved card can be dragged to To do to start intake.

An interrupted Start recovers an existing intake thread when found, or exposes Retry. Use `retry` on that card instead of adding another task.

The machine must be explicitly specified for every new card; never infer it from the current thread or choose the first available machine. Use `bb machine list` to find machine IDs and names, and ask the user when their target is unknown. The project must have a checkout on that machine. Intake, lead work, and retries use the card's stored machine.

Intake reuses that checkout's ready BB environment. If it has never been opened in BB, open a regular thread there with **Project checkout**, wait until ready, and retry the same card. Checkout discovery and readiness failures are recoverable with `bb pipeline retry <card-id>`.

### Intake and lead choices

`add` accepts optional `--intake-provider <id>`, `--intake-model <id>`, `--intake-reasoning <level>`, `--lead-provider <id>`, `--lead-model <id>`, and `--lead-reasoning <level>`.

For providers that support service tiers, use `--intake-service-tier <default|fast>` or `--lead-service-tier <default|fast>`.

Omit these unless the user requests a change. Omitted fields use Pipeline's remembered settings, shared with the New task UI. An accepted task remembers the resolved choices for the next task when `rememberExecution` is enabled (the default). Each card saves its own choices for intake, lead, and retries; changing defaults does not change existing cards. `show` includes both saved selections.

Discover providers and their models on the chosen machine with `bb provider list --machine <id-or-name>` and `bb provider models <provider-id> --machine <id-or-name>` before choosing new IDs or reasoning levels. Specify the matching model when switching providers.

```sh
bb pipeline add --title "Improve startup" --machine <id-or-name> \
  --intake-provider pi --intake-model zai/glm-5.3-flash --intake-reasoning high \
  --lead-provider codex --lead-model gpt-5.6-sol --lead-reasoning high
```

When spawning workers for a card, use `--parent-self` so they belong to the task, and use its existing environment or explicitly select its stored machine for a new environment.

### Imported issues

An imported card works from a GitHub issue the user picked. The card carries the full snapshot (title, body, labels, comments), the source link, and its own local notes (`Card.body`, stored with `report --body` or `report --body-file`). The source issue is read-only: never edit its body, labels, or comments, never comment on it, and never close, reopen, or reassign it. Keep scope, decisions, and classification in the local notes, and the tier on the card; do not add labels to the source issue.

Start behaves like any card: an imported card missing a machine or role choices asks for them before launching. The snapshot refreshes on import, at start, and through **Refresh issue** in task details; `github-sync` stays PR-only and issues are not polled in the background. A closed or reassigned source keeps its card and shows its state.

Two Pipeline tasks can run at once per project and machine. A card's intake, lead, and children share one slot until their running work, tracked background work, and active autonomous goals stop. Further starts, replies, and retries queue automatically when both slots are occupied. Use `bb pipeline queue` to read the occupants and wait reasons before choosing a card with `run-next`. The saved choice applies only to that project and machine, replaces an earlier choice there, and does not interrupt running work. It clears when the task starts. A nominee blocked for another reason does not prevent eligible work from running. `list` and `show` expose `queued`, `waitingReasons`, and `runNext` with `--json`. Send now cannot bypass the limit. Ordinary BB threads are outside it.

```sh
bb pipeline queue --project <project-id>
bb pipeline run-next <card-id>
bb pipeline run-next <card-id> --clear
```

Run next is a preference, not a start-order guarantee: concurrent queue claims can let another task start first. Priority waits are bounded so a blocked nominee cannot stall the queue.

The card tracks state only. Put questions, explanations, options, walkthroughs, and approval requests in the owning thread's user-facing chat, where the user replies. `bb pipeline report --needs-you <reason>` records a short waiting reason and sends an alert through Notify when attention begins; it does not post a chat message or collect an answer. Use `--working` when that blocker clears. Repeated attention reports do not resend the alert. Notify must be installed and enabled; its foreground and sound preferences apply. Pipeline also alerts for intake waiting, confirmed lead attention, failures, and pending questions or approvals on the owning thread. Do not send an extra `bb notify` for the same blocker.

## External PR review

Link one PR with `report --pr <url>`. Pipeline reads GitHub status and uses Jev to classify new review text from bots or humans. A feedback batch is delivered to the existing lead through BB's queue, respecting capacity and pause. Read `bb pipeline instructions close-out` and follow its feedback process when handling it. Acknowledge the exact batch with `review-wait --handled <batch-id>` after triage; material fixes still require the existing walkthrough/review/QA gates.

Awaiting review is an expected idle state. End the turn and pause or finish any autonomous goal instead of polling GitHub. Clean or answered review surfaces the user's merge decision. CI is displayed but is not a handoff requirement. Sync marks merged tasks Done; other GitHub changes do not move stages or reopen completed tasks. Remaining runtime work retains its capacity slot and can be stopped from task details.

## Graceful pause

When you receive a Pipeline pause instruction, follow its request ID. Start no new task work. Bring running commands and existing workers to a safe stopping point, preserve files, and leave a concise handoff in the owning conversation. Use your provider's goal controls to pause any active autonomous goal. Existing task threads may coordinate shutdown while the card is Pause requested; new worker starts are held.

Once safe, the current intake or lead must run `bb pipeline report --paused <request-id>` as its last action and end its turn. Workers cannot acknowledge for the owner. Do not report working or continue task work until the user resumes it. Pipeline checks the token and waits for all real task activity to end before showing Paused; acknowledgement alone does not free its capacity slot.

A pending question or offline machine can delay the instruction. Keep the task Pause requested rather than claiming it stopped. Stop now is available to the user as a fallback. Queued messages survive pause and stop; Resume releases them through the capacity gate and continues from the handoff. Task controls preserve the card's stage. Resume before moving, removing, or retrying a held card. Pipeline attention notifications are suppressed while held and for saved or Done cards.

## Attachments

Upload each file first, then pass the returned path to `bb pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```

## Settings

Open Settings in the Pipeline header or use `bb plugin config pipeline set <key> <value>`. `taskLimit` sets concurrent tasks per project and machine (1–32, default 2); lowering it holds new starts without stopping current work. `rememberExecution=false` keeps fixed intake/lead defaults. `reviewRequestComment` is the review trigger text; an empty value uses automatic reviews. `autoReviewFollowup=false` holds findings for user triage; Send to lead or `review-retry` explicitly releases a batch. Notifications are controlled by `notificationsEnabled`, `notifyQuestions`, `notifyFailures`, and `notifyReview`; Notify owns destinations and sound.
