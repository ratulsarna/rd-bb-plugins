# bb-plugin-pipeline

Pipeline gives each project a ten-column delivery board backed by BB threads. Each card requires an explicit machine choice. A new card starts an intake thread in the project's existing checkout on that machine. Moving the card to planning starts a lead in its own managed worktree on the same machine, carrying the filed issue and the card's attachments into the work.

Feature priorities are tracked in [WISHLIST.md](./WISHLIST.md).

The board tracks:

- `backlog` → `todo` → `planning` → `plan_ready`
- `implementing` → `reviewing` → `qa`
- `pr` → `pr_ready` → `done`

`pr_ready` means the draft PR is review-clean and waiting for the user to mark it ready and merge it.

Cards show why the user is needed, open the owning thread, link the issue and PR, and expose launch retry when the target machine is unavailable. Explicit `bb pipeline report` calls are authoritative; Jev classifies an unsignalled lead idle as needs-you, not waiting, or unchecked.

Use **New task** to add a title, context, attachments, and a machine. **Intake** and **Lead** each have a provider, model, and reasoning picker. They start from Pipeline settings and remember the last task's choices across the UI and CLI. Each card saves both selections for its launches and retries. Drag cards between stages, or use the card’s actions menu to move or remove it. **Show done** includes completed work.

At most two Pipeline tasks run per project and machine. Intake, lead, and child threads share the card's slot. A task keeps its slot while it is starting, running, stopping, has tracked background work, or is continuing an active autonomous goal. Once that work stops, queued tasks can run. Replies, retries, and a move to planning wait for capacity when the task no longer holds a slot. Ordinary BB threads do not consume Pipeline slots.

The board and `bb pipeline list` show `Queued` when a task has messages waiting on a plugin, including Pipeline capacity; `list` and `show` JSON output include `queued`. BB owns the durable message queue and resumes waiting messages when their conditions clear. Send now respects the Pipeline limit. An edit-and-resend or manual compaction at capacity is refused before changing the conversation; retry it when capacity is available.

Cancelling a queued kickoff leaves the task waiting for you. **Retry** sends its kickoff again to the same thread and waits for capacity if needed.

Retrying after a thread is deleted starts that role over. A retried lead gets a new managed worktree and the full kickoff prompt.

## Pause and resume

Choose **Pause** from a task's actions menu, or run `bb pipeline pause <card-id>`. Pipeline holds new task work and steers a pause instruction to the current intake or lead. The owner brings its workers and commands to a safe stopping point, saves a handoff, pauses any autonomous goal, and acknowledges the request. The card keeps its stage and files.

The card shows **Pause requested** until the owner acknowledges, then **Pausing** until its threads, tracked background work, and active goals have stopped. Only then does it show **Paused**. A task whose kickoff has not started can pause immediately. An offline machine or a pending question can delay delivery; **Retry pause** retries a failed or cancelled instruction.

**Resume** continues the owning thread from its handoff and releases preserved queued messages, subject to the two-task limit. An unstarted task resumes its kickoff; a deleted owner is relaunched. Archived owners must be restored in BB first. Moving, removing, or retrying a held card requires resuming it.

**Stop now** (`bb pipeline stop <card-id>`) is the immediate fallback. It requests a stop for the task's intake, lead, and occupied descendants, and waits for confirmed shutdown before showing Paused. It preserves queued messages and files. An unavailable machine can leave the card **Stopping**; retry Stop now when it reconnects. BB can stop provider sessions and their tracked work, but cannot guarantee shutdown of arbitrary detached processes.

## Notifications

With Notify installed and enabled, Pipeline sends an alert when a task starts needing your attention: an explicit `--needs-you` report, intake waiting for you, confirmed lead attention, or a launch/thread failure. Repeated updates and reloads do not repeat an existing attention alert. Clearing attention and needing you again sends another alert. Pending questions and approvals on the owning thread also notify. Done, pausing, paused, and stopping tasks do not send Pipeline attention alerts.

Alerts include the task title and reason and open its owning thread when one exists. They use Notify's desktop and phone delivery, sound preference, and foreground suppression. They do not require enabling each thread's bell. Unknown idle status and capacity waits stay quiet. A missing or failing Notify plugin is logged without blocking task work; failed requests are not replayed.

## Commands

```text
bb pipeline add --title <text> --machine <id-or-name> [--body <text>] [--attachment <uploaded-path>]... [--project <id>]
bb pipeline set-machine <card-id> --machine <id-or-name>
bb pipeline list [--project <id>] [--all]
bb pipeline show <card-id>
bb pipeline move <card-id> <column>
bb pipeline report [--card <id>] [--column <column>] [--needs-you <reason> | --working] [--issue <url>] [--pr <url>] [--tier <trivial|small|standard>]
bb pipeline retry <card-id>
bb pipeline pause <card-id>
bb pipeline resume <card-id>
bb pipeline stop <card-id>
bb pipeline report --paused <request-id>
bb pipeline remove <card-id>
```

Every command accepts `--json`. A CLI attachment must already be in BB's project attachment store:

```sh
bb project attachment upload <project-id> --client-file <path>
```

Pass the returned path to `bb pipeline add --attachment`.

Override either role when adding a card:

```sh
bb pipeline add --title "Improve startup" --machine <id-or-name> \
  --intake-provider pi --intake-model zai/glm-5.3-flash --intake-reasoning high \
  --lead-provider codex --lead-model gpt-5.6-sol --lead-reasoning high
```

All role options are optional. Omitted fields use the remembered Pipeline settings; explicit choices become the settings for subsequent tasks. Specify the matching model when switching providers. Providers that support service tiers also accept `--intake-service-tier <default|fast>` and `--lead-service-tier <default|fast>`. Use `bb provider list --machine <id-or-name>` and `bb provider models <provider-id> --machine <id-or-name>` to discover providers, model IDs, and supported reasoning. `bb pipeline show` includes the card's saved selections.

Choose a machine in New task or pass its ID or unambiguous name with `--machine`. Run `bb machine list` to find IDs and names. The project must have a checkout on the chosen machine. The choice stays with the card for intake, lead work, and retries.

Cards without a machine show a machine picker on the board. Assign one there or with `set-machine` before launching further work. Assignment does not relocate existing threads, and an assigned card's machine cannot be changed.

Removing a card removes only its board data. It does not stop the intake or lead threads; archive those threads in BB if needed.
Their running work continues to count toward the limit after the card is removed.

## Configuration

Initial settings use Claude Code with `claude-fable-5-1`, high reasoning, and full permission for both roles. Change them in the plugin settings or with `bb plugin config pipeline set`:

- Intake: `providerId`, `model`, `reasoningLevel`, optional `serviceTier`
- Lead: `leadProviderId`, `leadModel`, `leadReasoningLevel`, optional `leadServiceTier`
- `permissionMode` for both roles
- `jevApiKey` (secret), `jevThreshold`

Lead settings initially inherit the intake settings. Creating a task saves the resolved choices for both roles. Settings changes affect future cards; existing cards retain their saved selections. Cards created before per-role selections use the current settings when launching a role.

The BB server needs `gh` installed and authenticated because Pipeline reads the GitHub issue when it launches a lead thread.

The Jev key is optional. Without it, an unsignalled lead idle is shown as `Idle · awaiting status` rather than guessed.

## Workflow skills

All threads receive `pipeline`, which documents board operations. Intake threads also receive `pipeline-intake`. Lead threads receive the forked `pipeline-plan`, `pipeline-implement`, `pipeline-close-out`, and `pipeline-debug` workflow skills. Their upstream revision and local edits are recorded in [VENDOR.md](./VENDOR.md).

## Development

This plugin requires BB plugin SDK 0.4.107 or newer. Install published dependencies with `npm install`. When developing against an unpublished SDK, install its local package instead:

```sh
cd /path/to/bb
pnpm exec turbo run build build:types --filter=@get-bb/plugin-sdk
cd packages/plugin-sdk
npm pack --ignore-scripts --pack-destination /tmp
cd /path/to/bb-plugin-pipeline
npm install --no-save --package-lock=false /tmp/get-bb-plugin-sdk-0.4.107.tgz
```

```sh
npm run typecheck
npm test
npm run build
```

The plugin owns its SQLite database through `bb.storage.database()`. Its frontend keeps durable state in sync through RPC refetches after realtime signals and reconnects.
