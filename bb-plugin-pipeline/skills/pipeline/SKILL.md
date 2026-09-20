---
name: pipeline
description: "Work the pipeline board from any thread: add, list, show, and move cards. Specify a machine when adding a card and upload attachments first."
---

# Pipeline: Board

Every task is a card on the pipeline board: a title, a note, a machine, attachments, and a column. The columns, in order: `backlog`, `todo`, `planning`, `plan_ready`, `implementing`, `reviewing`, `qa`, `pr`, `pr_ready`, `done`. Adding a card launches an intake thread for it.

## Commands

- `bb pipeline add --title <t> --machine <id-or-name> [--body <text>] [--attachment <uploaded-path>]... [--project <id>]` — create a card on the explicitly chosen machine. `--project` defaults to the current project.
- `bb pipeline set-machine <card-id> --machine <id-or-name>` — assign a machine to a card that has none. An assigned machine cannot be changed.
- `bb pipeline list [--project <id>] [--all]` — the board's cards; `done` is hidden unless `--all`.
- `bb pipeline show <card-id>` — the card, its history, and its threads.
- `bb pipeline retry <card-id>` — retry a failed or cancelled kickoff. A cancelled kickoff uses its existing thread and waits for capacity.
- `bb pipeline move <card-id> <column>` — move a card by hand. Moving to planning starts its lead thread if needed and waits for capacity; other moves update the board.

The machine must be explicitly specified for every new card; never infer it from the current thread or choose the first available machine. Use `bb machine list` to find machine IDs and names, and ask the user when their target is unknown. The project must have a checkout on that machine. Intake, lead work, and retries use the card's stored machine.

When spawning workers for a card, use `--parent-self` so they belong to the task, and use its existing environment or explicitly select its stored machine for a new environment.

Two Pipeline tasks can run at once per project and machine. A card's intake, lead, and children share one slot until their running work, tracked background work, and active autonomous goals stop. Further starts, replies, and retries queue automatically when both slots are occupied. `bb pipeline list` and `show` expose whether work is queued. Send now cannot bypass this limit. Ordinary BB threads are outside it.

## Attachments

Upload each file first, then pass the returned path to `bb pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```
