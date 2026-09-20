# bb-plugin-pipeline

Pipeline gives each project a ten-column delivery board backed by BB threads. Each card requires an explicit machine choice. A new card starts an intake thread in the project's existing checkout on that machine. Moving the card to planning starts a lead in its own managed worktree on the same machine, carrying the filed issue and the card's attachments into the work.

The board tracks:

- `backlog` → `todo` → `planning` → `plan_ready`
- `implementing` → `reviewing` → `qa`
- `pr` → `pr_ready` → `done`

`pr_ready` means the draft PR is review-clean and waiting for the user to mark it ready and merge it.

Cards show why the user is needed, open the owning thread, link the issue and PR, and expose launch retry when the target machine is unavailable. Explicit `bb pipeline report` calls are authoritative; Jev classifies an unsignalled lead idle as needs-you, not waiting, or unchecked.

Retrying after a thread is deleted starts that role over. A retried lead gets a new managed worktree and the full kickoff prompt.

## Commands

```text
bb pipeline add --title <text> --machine <id-or-name> [--body <text>] [--attachment <uploaded-path>]... [--project <id>]
bb pipeline set-machine <card-id> --machine <id-or-name>
bb pipeline list [--project <id>] [--all]
bb pipeline show <card-id>
bb pipeline move <card-id> <column>
bb pipeline report [--card <id>] [--column <column>] [--needs-you <reason> | --working] [--issue <url>] [--pr <url>] [--tier <trivial|small|standard>]
bb pipeline retry <card-id>
bb pipeline remove <card-id>
```

Every command accepts `--json`. A CLI attachment must already be in BB's project attachment store:

```sh
bb project attachment upload <project-id> --client-file <path>
```

Pass the returned path to `bb pipeline add --attachment`.

Choose a machine in Add card or pass its ID or unambiguous name with `--machine`. Run `bb machine list` to find IDs and names. The project must have a checkout on the chosen machine. The choice stays with the card for intake, lead work, and retries.

Cards without a machine show a machine picker on the board. Assign one there or with `set-machine` before launching further work. Assignment does not relocate existing threads, and an assigned card's machine cannot be changed.

Removing a card removes only its board data. It does not stop the intake or lead threads; archive those threads in BB if needed.

## Configuration

Launch settings use Claude Code with `claude-fable-5-1`, high reasoning, and full permission. Change them in the plugin settings or with `bb plugin config pipeline set`:

- `providerId`, `model`
- `reasoningLevel`, `permissionMode`
- `jevApiKey` (secret), `jevThreshold`

The BB server needs `gh` installed and authenticated because Pipeline reads the GitHub issue when it launches a lead thread.

The Jev key is optional. Without it, an unsignalled lead idle is shown as `idle, unchecked` rather than guessed.

## Workflow skills

All threads receive `pipeline`, which documents board operations. Intake threads also receive `pipeline-intake`. Lead threads receive the forked `pipeline-plan`, `pipeline-implement`, `pipeline-close-out`, and `pipeline-debug` workflow skills. Their upstream revision and local edits are recorded in [VENDOR.md](./VENDOR.md).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

The plugin owns its SQLite database through `bb.storage.database()`. Its frontend keeps durable state in sync through RPC refetches after realtime signals and reconnects.
