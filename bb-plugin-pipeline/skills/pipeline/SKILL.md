---
name: pipeline
description: Work the pipeline board from any thread: add, list, show, and move cards. Upload attachments before adding them to a card.
---

# Pipeline: Board

Every task is a card on the pipeline board: a title, a note, attachments, and a column. The columns, in order: `backlog`, `todo`, `planning`, `plan_ready`, `implementing`, `reviewing`, `qa`, `pr`, `pr_ready`, `done`. Adding a card launches an intake thread for it.

## Commands

- `bb pipeline add --title <t> [--body <text>] [--attachment <uploaded-path>]... [--project <id>]` — create a card. `--project` defaults to the current project.
- `bb pipeline list [--project <id>] [--all]` — the board's cards; `done` is hidden unless `--all`.
- `bb pipeline show <card-id>` — the card, its history, and its threads.
- `bb pipeline move <card-id> <column>` — move a card by hand. A move never stops or messages a thread.

## Attachments

Upload each file first, then pass the returned path to `bb pipeline add --attachment`:

```
bb project attachment upload <projectId> --client-file <path>
```
