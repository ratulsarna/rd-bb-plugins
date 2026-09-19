# bb-plugin-pipeline

Pipeline gives each project a ten-column delivery board backed by BB threads. A new card starts an intake thread in the project's existing checkout. Moving the card to planning starts a lead in its own managed worktree, carrying the filed issue and the card's attachments into the work.

The board tracks:

- `backlog` → `todo` → `planning` → `plan_ready`
- `implementing` → `reviewing` → `qa`
- `pr` → `pr_ready` → `done`

Cards show why the user is needed, open the owning thread, link the issue and PR, and expose launch retry when the target machine is unavailable. Explicit `bb pipeline report` calls are authoritative; Jev classifies an unsignalled lead idle as needs-you, working, or unchecked.

## Commands

```text
bb pipeline add --title <text> [--body <text>] [--attachment <uploaded-path>]... [--project <id>]
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

## Configuration

The defaults launch Claude Code on `host_wt5difpwsy` with `claude-fable-5-1`, high reasoning, and full permission. Change them in the plugin settings or with `bb plugin config pipeline set`:

- `hostId`, `providerId`, `model`
- `reasoningLevel`, `permissionMode`
- `jevApiKey` (secret), `jevThreshold`

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
