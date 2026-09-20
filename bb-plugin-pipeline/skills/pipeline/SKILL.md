---
name: pipeline
description: "Work the pipeline board: add, start, list, show, move, pause, and resume tasks. Specify a machine; optionally choose separate intake and lead models and reasoning. Upload attachments first."
---

# Pipeline: Board

Every task is a card on the pipeline board: a title, a note, a machine, attachments, and a column. The columns, in order: `backlog`, `todo`, `planning`, `plan_ready`, `implementing`, `reviewing`, `qa`, `pr`, `pr_ready`, `done`. Adding a card launches intake unless `--no-start` is supplied. A saved task creates no thread or queued message until explicitly started.

## Commands

- `bb pipeline add --title <t> --machine <id-or-name> [--no-start] [--body <text>] [--attachment <uploaded-path>]... [--project <id>]` — create a card on the explicitly chosen machine. `--project` defaults to the current project.
- `bb pipeline start <card-id>` — start intake for a saved task using its stored machine, models, notes, and attachments. Repeated Start requests do not launch again; use Retry after a failed start.
- `bb pipeline set-machine <card-id> --machine <id-or-name>` — assign a machine to a card that has none. An assigned machine cannot be changed.
- `bb pipeline list [--project <id>] [--all]` — the board's cards; `done` is hidden unless `--all`.
- `bb pipeline show <card-id>` — the card, its history, and its threads.
- `bb pipeline queue [--project <id>]` — running and waiting tasks by machine, including each wait reason and the selected next task.
- `bb pipeline run-next <card-id>` — favor this waiting task when a slot opens on its project and machine.
- `bb pipeline run-next <card-id> --clear` — clear that selection if it is still current.
- `bb pipeline retry <card-id>` — retry a failed or cancelled kickoff. A cancelled kickoff uses its existing thread and waits for capacity.
- `bb pipeline pause <card-id>` — ask the owner to pause gracefully and hold new work.
- `bb pipeline resume <card-id>` — continue a Paused task through the normal capacity gate.
- `bb pipeline stop <card-id>` — hard-stop the task and occupied descendants; use when graceful pause cannot finish.
- `bb pipeline move <card-id> <column>` — move a card by hand. Moving to planning starts its lead thread if needed and waits for capacity; other moves update the board.

Use `add --no-start` when the user wants to capture a task for later. Start it before moving stages, pausing, stopping, or resuming; saved tasks can be removed without starting. The UI offers the same choice as **Save** and **Save and start**.

The machine must be explicitly specified for every new card; never infer it from the current thread or choose the first available machine. Use `bb machine list` to find machine IDs and names, and ask the user when their target is unknown. The project must have a checkout on that machine. Intake, lead work, and retries use the card's stored machine.

### Intake and lead choices

`add` accepts optional `--intake-provider <id>`, `--intake-model <id>`, `--intake-reasoning <level>`, `--lead-provider <id>`, `--lead-model <id>`, and `--lead-reasoning <level>`.

For providers that support service tiers, use `--intake-service-tier <default|fast>` or `--lead-service-tier <default|fast>`.

Omit these unless the user requests a change. Omitted fields use Pipeline's remembered settings, shared with the New task UI. An accepted task remembers the resolved choices for the next task. Each card saves its own choices for intake, lead, and retries; changing defaults does not change existing cards. `show` includes both saved selections.

Discover providers and their models on the chosen machine with `bb provider list --machine <id-or-name>` and `bb provider models <provider-id> --machine <id-or-name>` before choosing new IDs or reasoning levels. Specify the matching model when switching providers.

```sh
bb pipeline add --title "Improve startup" --machine <id-or-name> \
  --intake-provider pi --intake-model zai/glm-5.3-flash --intake-reasoning high \
  --lead-provider codex --lead-model gpt-5.6-sol --lead-reasoning high
```

When spawning workers for a card, use `--parent-self` so they belong to the task, and use its existing environment or explicitly select its stored machine for a new environment.

Two Pipeline tasks can run at once per project and machine. A card's intake, lead, and children share one slot until their running work, tracked background work, and active autonomous goals stop. Further starts, replies, and retries queue automatically when both slots are occupied. Use `bb pipeline queue` to read the occupants and wait reasons before choosing a card with `run-next`. The saved choice applies only to that project and machine, replaces an earlier choice there, and does not interrupt running work. It clears when the task starts. A nominee blocked for another reason does not prevent eligible work from running. `list` and `show` expose `queued`, `waitingReasons`, and `runNext` with `--json`. Send now cannot bypass the limit. Ordinary BB threads are outside it.

```sh
bb pipeline queue --project <project-id>
bb pipeline run-next <card-id>
bb pipeline run-next <card-id> --clear
```

Run next is a preference, not a start-order guarantee: concurrent queue claims can let another task start first. Priority waits are bounded so a blocked nominee cannot stall the queue.

`bb pipeline report --needs-you <reason>` marks the task as needing user input and sends an alert through Notify when attention begins. Use `--working` when that blocker clears. Repeated attention reports do not resend the alert. Notify must be installed and enabled; its foreground and sound preferences apply. Pipeline also alerts for intake waiting, confirmed lead attention, failures, and pending questions or approvals on the owning thread. Do not send an extra `bb notify` for the same blocker.

## Graceful pause

When you receive a Pipeline pause instruction, follow its request ID. Start no new task work. Bring running commands and existing workers to a safe stopping point, preserve files, and leave a concise handoff in the owning conversation. Use your provider's goal controls to pause any active autonomous goal. Existing task threads may coordinate shutdown while the card is Pause requested; new worker starts are held.

Once safe, the current intake or lead must run `bb pipeline report --paused <request-id>` as its last action and end its turn. Workers cannot acknowledge for the owner. Do not report working or continue task work until the user resumes it. Pipeline checks the token and waits for all real task activity to end before showing Paused; acknowledgement alone does not free its capacity slot.

A pending question or offline machine can delay the instruction. Keep the task Pause requested rather than claiming it stopped. Stop now is available to the user as a fallback. Queued messages survive pause and stop; Resume releases them through the capacity gate and continues from the handoff. Task controls preserve the card's stage. Resume before moving, removing, or retrying a held card. Pipeline attention notifications are suppressed while held and for saved or Done cards.

## Attachments

Upload each file first, then pass the returned path to `bb pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```
