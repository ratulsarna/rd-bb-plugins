# bb-plugin-pipeline

Pipeline tracks each project’s delivery tasks in a compact list or stage board backed by BB threads. Each card requires an explicit machine choice. Starting a card launches an intake thread in the project's existing checkout on that machine. Moving the card to planning starts a lead in its own managed worktree on the same machine, carrying the filed issue and the card's attachments into the work.

Feature priorities are tracked in [WISHLIST.md](./WISHLIST.md).

Both views track:

- `backlog` → `todo` → `planning` → `plan_ready`
- `implementing` → `reviewing` → `qa`
- `pr` → `pr_ready` → `done`

`pr_ready` is available for an explicit user/lead handoff. External review status is shown independently of the stage; clean or settled feedback surfaces the user’s merge decision without moving stages.

After the two implementation reviews clear, the lead walks you through the result before QA. It uses `/show-me` and code snippets, one step per turn, with up to eight steps and fewer for small changes. The walkthrough covers how the code works, deviations from the approved plan and why, and what still awaits verification. The card stays in Reviewing with **Needs you** until you approve the final step. Material changes after approval return to the affected steps.

Cards show workflow state and a short reason the user is needed, and open the owning thread. Questions, explanations, walkthroughs, and approvals stay in that thread's chat. `bb pipeline report` updates the card; it does not send a chat message or collect an answer. Task details link the issue and PR; task actions expose launch retry when the target machine is unavailable. Explicit reports are authoritative for state; Jev classifies an unsignalled lead idle as needs-you, not waiting, or unchecked.

Use **New task** to add a title, context, attachments, and a machine. **Intake** and **Lead** each have a provider, model, and reasoning picker. They start from Pipeline settings. With **Remember last task’s choices** enabled, accepted UI and CLI tasks update those defaults. Each card saves both selections for its launches and retries.

Choose **Save** to keep a task in Backlog without starting work, or **Save and start** to launch intake. Saved tasks show **Not started** and a **Start** action; they create no thread or queued message until started. Start uses the saved choices and waits for capacity when necessary. Start a task before moving it between stages or using execution controls. Use **Tasks** for a compact list, or **Board** for occupied stages. Filter by **Open**, **Needs you**, **Queued**, **Done**, or a specific stage. The layout choice is remembered; switching projects resets the filters.

Task titles open the owning thread. The details button opens context, diagnostics, attachments, execution choices, and task actions in a side panel, or full-screen on a phone. Queued tasks show their waiting reason directly. Both layouts use a single scrolling area; Board stages stack vertically on narrow screens. Drag started cards in Board to reveal all destination stages, or use **Move to** in the actions menu.

If a reload interrupts Start, Pipeline looks for the intake already created for that task and reconnects it. If it cannot find or check that thread, the card offers **Retry**; Retry checks again before launching intake.

Pipeline defaults to two concurrent tasks per project and machine. Change **Concurrent tasks** in Settings; lowering it lets existing work finish while holding further starts. Intake, lead, and child threads share the card's slot. A task keeps its slot while it is starting, running, stopping, has tracked background work, or is continuing an active autonomous goal. Once that work stops, queued tasks can run. Replies, retries, and a move to planning wait for capacity when the task no longer holds a slot. Ordinary BB threads do not consume Pipeline slots.

The board and `bb pipeline queue` show which tasks occupy those slots and why other work is waiting. `list` and `show` JSON output include `queued`, `waitingReasons`, and `runNext`; `queue --json` returns the per-machine occupants, waiting tasks, and selected card. BB owns the durable message queue and resumes waiting messages when their conditions clear. Send now respects the Pipeline limit. An edit-and-resend or manual compaction at capacity is refused before changing the conversation; retry it when capacity is available.

`bb pipeline run-next <card-id>` asks Pipeline to favor a waiting task when capacity opens. The choice is saved per project and machine, survives a reload, and does not interrupt existing work. Choosing another task for the same project and machine replaces it; add `--clear` to remove the choice. The choice clears when that task starts. If it remains blocked for another reason, it does not prevent other eligible work from running. The configured task limit still applies.

Run next is a preference: concurrent BB queue claims can let another task start first. Other tasks yield for at most five seconds per priority wait, then become eligible on BB's next queue check so an unreported blocker cannot stall the queue.

Cancelling a queued kickoff leaves the task waiting for you. **Retry** sends its kickoff again to the same thread and waits for capacity if needed.

Retrying after a thread is deleted starts that role over. A retried lead gets a new managed worktree and the full kickoff prompt.

## Pause and resume

Choose **Pause** from a task's actions menu, or run `bb pipeline pause <card-id>`. Pipeline holds new task work and steers a pause instruction to the current intake or lead. The owner brings its workers and commands to a safe stopping point, saves a handoff, pauses any autonomous goal, and acknowledges the request. The card keeps its stage and files.

The card shows **Pause requested** until the owner acknowledges, then **Pausing** until its threads, tracked background work, and active goals have stopped. Only then does it show **Paused**. A task whose kickoff has not started can pause immediately. An offline machine or a pending question can delay delivery; **Retry pause** retries a failed or cancelled instruction.

**Resume** continues the owning thread from its handoff and releases preserved queued messages, subject to the configured task limit. A task paused before its queued kickoff runs resumes that kickoff; a deleted owner is relaunched. Archived owners must be restored in BB first. Moving, removing, or retrying a held card requires resuming it.

**Stop now** (`bb pipeline stop <card-id>`) is the immediate fallback. It requests a stop for the task's intake, lead, and occupied descendants, and waits for confirmed shutdown before showing Paused. It preserves queued messages and files. An unavailable machine can leave the card **Stopping**; retry Stop now when it reconnects. BB can stop provider sessions and their tracked work, but cannot guarantee shutdown of arbitrary detached processes.

## Notifications

With Notify installed and enabled, Pipeline sends an alert when a task starts needing your attention: an explicit `--needs-you` report, intake waiting for you, confirmed lead attention, or a launch/thread failure. Repeated updates and reloads do not repeat an existing attention alert. Clearing attention and needing you again sends another alert. Pending questions and approvals on the owning thread also notify. Pipeline alerts are suppressed from the moment you request a pause or stop, and for saved or Done tasks.

Alerts include the task title and reason and open its owning thread when one exists. They use Notify's desktop and phone delivery, sound preference, and foreground suppression. They do not require enabling each thread's bell. Unknown idle status and capacity waits stay quiet. A missing or failing Notify plugin is logged without blocking task work; failed requests are not replayed.

## GitHub sync

Link one GitHub PR to a task with `report --pr <url>`. Pipeline refreshes its state, draft status, checks, mergeability, and review feedback every minute. Refresh GitHub in task details or run `github-sync` for an immediate update. Failed reads preserve the last successful snapshot and show the error; two consecutive read failures send one notification until reads recover. No checks means no checks; CI does not gate review handoff.

The lead runs `bb pipeline review-wait` after opening a draft PR, then ends its turn. The command posts `reviewRequestComment` once per revision (initially `@codex review`). Set it to an empty string when external reviews run automatically. Pipeline uses Jev to distinguish new findings, explicit clean completion, progress, and uncertainty across reviewers; no reviewer-account list is needed. An uncertain result remains visible for checking or refreshing.

Clean conclusions must refer to the current commit through GitHub review metadata or a standalone `Reviewed commit:` / `Reviewed revision:` label containing its full or abbreviated hash (at least seven characters). Jev interprets the verdict separately from this check. Findings take priority over a clean summary; progress updates in the same batch do not override an explicit clean conclusion. Informational updates and conversational comments preserve the review state; new findings, review activity, withdrawals, and commits still update it.

New findings produce one feedback batch sent to the existing lead through BB’s queue. With automatic follow-ups disabled in Settings, findings wait for your triage; **Send to lead** explicitly permits that batch. Turning automatic follow-ups off also holds queued automatic feedback, without interrupting an already running lead. Pause, machine availability, and the configured task limit apply. The lead triages findings under the close-out workflow, verifies justified fixes, and runs `review-wait --handled <batch-id>` before ending its turn. A new revision requests another review; answered findings without a code change do not. Pending feedback survives reload, and failed or cancelled delivery has a Retry review action. If a send response is lost, check the lead before retrying an unconfirmed delivery.

Clean or settled review asks for your merge decision. Sync moves a task to Done when its PR merges; a PR closed without merging needs your decision. Sync preserves manual stage changes and never reopens Done tasks. Replacing the PR link invalidates old queued feedback. Done describes delivery: remaining agents still consume capacity and remain visible and stoppable.

GitHub access uses the BB server’s authenticated `gh`. Jev classification uses the existing `jevApiKey` and confidence threshold; unavailable classification reports Unknown. Paused and Done tasks retain their notification suppression. Neither a review-request comment nor an author reply starts another feedback turn.

## Commands

```text
bb pipeline add --title <text> --machine <id-or-name> [--no-start] [--body <text>] [--attachment <uploaded-path>]... [--project <id>]
bb pipeline start <card-id>
bb pipeline set-machine <card-id> --machine <id-or-name>
bb pipeline list [--project <id>] [--all]
bb pipeline show <card-id>
bb pipeline queue [--project <id>]
bb pipeline run-next <card-id> [--clear]
bb pipeline move <card-id> <column>
bb pipeline report [--card <id>] [--column <column>] [--needs-you <reason> | --working] [--issue <url>] [--pr <url>] [--tier <trivial|small|standard>]
bb pipeline github-sync <card-id>
bb pipeline review-wait [--card <id>] [--handled <batch-id>]
bb pipeline review-retry <card-id>
bb pipeline retry <card-id>
bb pipeline pause <card-id>
bb pipeline resume <card-id>
bb pipeline stop <card-id>
bb pipeline report --paused <request-id>
bb pipeline remove <card-id>
```

`add` starts intake unless you pass `--no-start`. Start a saved task with `bb pipeline start <card-id>`; repeated Start requests do not create another thread. A failed start uses the existing Retry action. Saved tasks retain their machine, execution choices, notes, and attachments across reloads.

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

All role options are optional. Omitted fields use Pipeline settings; explicit choices become defaults for subsequent tasks when remembering is enabled. Specify the matching model when switching providers. Providers that support service tiers also accept `--intake-service-tier <default|fast>` and `--lead-service-tier <default|fast>`. Use `bb provider list --machine <id-or-name>` and `bb provider models <provider-id> --machine <id-or-name>` to discover providers, model IDs, and supported reasoning. `bb pipeline show` includes the card's saved selections.

Choose a machine in New task or pass its ID or unambiguous name with `--machine`. Run `bb machine list` to find IDs and names. The project must have a checkout on the chosen machine. The choice stays with the card for intake, lead work, and retries.

Intake reuses the ready BB environment at that checkout. Before first use, open a regular BB thread there using **Project checkout**, then retry the Pipeline task once the environment is ready. A missing, busy, or unavailable checkout leaves a launch error with **Retry**. Lead launches use their own managed worktrees.

Cards without a machine show a machine picker on the board. Assign one there or with `set-machine` before launching further work. Assignment does not relocate existing threads, and an assigned card's machine cannot be changed.

Removing a card removes only its board data. It does not stop the intake or lead threads; archive those threads in BB if needed.
Their running work continues to count toward the limit after the card is removed.

## Configuration

Open **Settings** from the Pipeline header to configure execution defaults, capacity, external reviews, notifications, and advanced options. Model pickers use the selected **Model catalog** machine for discovery; defaults apply globally, and each task still requires its own machine.

Settings saves update only edited fields. Leave the TypeSafe key blank to retain it, enter a replacement, or explicitly clear it. Integration status checks GitHub authentication on the BB server and Notify availability; Jev’s status says whether a key is configured, not whether a request has succeeded.

Initial settings use Claude Code with `claude-fable-5-1`, high reasoning, and full permission for both roles. The same settings are available through `bb plugin config pipeline set`:

- Intake: `providerId`, `model`, `reasoningLevel`, optional `serviceTier`
- Lead: `leadProviderId`, `leadModel`, `leadReasoningLevel`, optional `leadServiceTier`
- `rememberExecution` — remember new tasks’ choices, enabled by default; disable for fixed execution defaults
- `taskLimit` — concurrent tasks per project and machine, 1–32; default 2
- `permissionMode` for both roles
- `jevApiKey` (secret), `jevThreshold`
- `reviewRequestComment` — review trigger text; empty for automatic reviews
- `autoReviewFollowup` — send findings to the lead automatically, enabled by default
- `notificationsEnabled`, `notifyQuestions`, `notifyFailures`, `notifyReview` — Pipeline alert preferences, all enabled by default; delivery and sound stay in Notify

Lead settings initially inherit the intake settings. Creating a task saves the resolved choices for both roles. Settings changes affect future cards; existing cards retain their saved selections. Cards created before per-role selections use the current settings when launching a role.

The BB server needs `gh` installed and authenticated because Pipeline reads the GitHub issue when it launches a lead thread.

The Jev key is optional. Without it, an unsignalled lead idle is shown as `Idle · awaiting status` rather than guessed.

## Workflow documents

The Pipeline workflow lives in plugin-owned documents under `workflows/`, stored on the BB server and read with:

```text
bb pipeline instructions [overview|intake|plan|implement|debug|close-out] [--file <relative-path>] [--json]
```

With no phase, `instructions` reads the overview (`workflows/README.md`): roles, sizing, and the phase map. Each phase reads its `workflows/<phase>/README.md`, and `--file <relative-path>` reads a supporting file under that phase, such as a worker template dispatched during implementation. Documents are only read through this command, never from the task's host checkout. The intake kickoff reads `intake`; the lead reads `overview` and then the phase its kind and tier call for; after an approved plan it reads `implement`; a review follow-up reads `close-out`. After the user approves a transition, the thread reads the next phase and continues — no separate slash command is needed.

Board operations stay in the general `pipeline` skill, invoked explicitly when a thread works the board.

The workflow documents are forks of Nexus. Their upstream revision and local edits are recorded in [VENDOR.md](./VENDOR.md).

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
