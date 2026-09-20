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
- `bb pipeline move <card-id> <column>` — move a card by hand. A move never stops or messages a thread.

The machine must be explicitly specified for every new card; never infer it from the current thread or choose the first available machine. Use `bb machine list` to find machine IDs and names, and ask the user when their target is unknown. The project must have a checkout on that machine. Intake, lead work, and retries use the card's stored machine.

When spawning workers for a card, use its existing environment or explicitly select its stored machine for a new environment.

## Attachments

Upload each file first, then pass the returned path to `bb pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```
