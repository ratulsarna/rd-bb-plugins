# Assistants

## Inbox

The thread list (Pinned, Inbox, Snoozed, Settled) comes from `inbox-core`, a
file dependency on a sibling `bb-sw-pipeline` checkout (on the bb server:
`~/Developer/bb/bb-sw-pipeline`). Setup: `npm ci` in that checkout's
`inbox-core`, then `npm ci` here. This plugin composes the board with the
Bots section and keeps the assistants project out of the inbox lanes.
After any inbox-core change, run `npm run build` here before a reload: bb's
change check looks only inside the plugin folder and skips `node_modules`.

Use a Bots row's **New thread with …** action to open BB's normal composer.
**Machine** chooses where the fresh root conversation starts. **Home** shows
the same assistant home segment under that machine's mapped assistants root.
Only machines with a canonical assistants root appear in the selector;
offline or unready mapped machines remain visible with their reasons.
The dialog shows the destination **Vault**, connection status, and readiness
reason. Source history is a reference in the first message; the new session
starts empty.

Sending replaces the source on any machine. The plugin creates the new
conversation, points every agent automation that targeted the source at it,
then archives the source. A refusal before creation keeps the source. If an
automation cannot be moved, the source stays live so its runs keep working,
and the dialog warns with the automation's name. An archive failure also
returns the new conversation's id with a warning, so the composer does not
create it twice.

The provider/model/reasoning and permission controls are BB's stock composer.
When the old provider is unavailable on the destination, its provider, model,
reasoning, and service-tier seeds are omitted; choose current composer options.
BB's normal creation validates destination execution options and tools. Machine
and Home determine the final workspace, even if the composer submits its old
environment. Keep the assistants project selected.

Private Sync owns the mapping at `/plugins/private-sync/sync`. The plugin calls
its public `status` and `machineDirectory` RPCs, using folder ids `assistants`
and `vault`. Each host must have exactly one normalized mapping for each
folder; its assistants root must match the conversation project's source on
that host. The project name is case-insensitively `assistants`. The source
environment must be a direct assistant home under its mapped root. Destination
`.pi/SYSTEM.md` is read with the mapped root as the host's file boundary, and
the vault directory must be accessible. The resolved home must have the same
direct segment under the resolved mapped root; a symlink to another assistant
is refused. The source machine can be offline;
only source metadata establishes identity. Source files are not read.

Cross-machine creation requires enabled sync. When sync is enabled, paused or
unready destination nodes block creation. Before spawning, `private-sync.sync`
runs for `assistants` and `vault`, each with only the destination host and a
30-second timeout. Both results must confirm the mapped ready nodes. The
plugin then rereads source metadata, mappings, readiness, and destination files.
Disabled sync permits a same-machine local start after destination checks.
The flow copies no files. Sam's journal pointers use the destination vault.

Bots renders each unarchived root conversation with its SDK machine name.
Right-click a row and open **Past chats** to list that assistant's archived
conversations from every machine, newest first. Each one opens read-only.
The eye on a row, or **Hide when collapsed** in its menu, puts that
assistant behind **Show more**. All its machines' rows hide together. A
hidden row still shows while it has a dot (working, waiting or unread), while
it is open, and in search results.
Assistant titles, identity-based subtitles and ordering stay shared across
machines. Bots uses the first project whose lowercase name is `assistants`;
a second project named `Assistants` is not hidden by capitalization.

## Memory

Memory gives one Claude Code assistant a conversation that never ends. It is
off until you turn it on for that assistant. It follows Victor Taelin's
OptChat design: every message is logged word for word, a tree of one-line
summaries is built over the log, and every session starts with a 64-128 KB
view of the whole chat.

The assistant keeps one thread for good. Claude Code compacts it when its
context fills, and a `SessionStart` hook hands it the view again: on startup,
clear and compact, for the main chat only, it writes `memory view` to
`<home>/nosync/bb-memory-<thread>.md` and tells the agent to read that file
before anything else. A resume keeps its memory in context and gets nothing,
as does every other session in the home. If the command fails, only a chat
that already has such a file is told. `memory on` installs the hook in the
home: the script at `.claude/hooks/bb-memory-session-start.sh` and one entry
in `.claude/settings.json`, beside what the file already holds; running it
again repairs both. `memory off` takes out only that entry and the script.
The home syncs, so every machine gets them. **New thread with…** is closed
while memory is on.

What is logged: the main chat's user messages, the assistant's replies, its
tool calls and their output, and reports other threads send into it. What is
not: reasoning, plans, a subagent's own transcript (its call and report are
logged), blocks bb marks agent-only, and a successful plain
`bb assistants recall` or `date` call. Tool output over 30,000 characters
keeps its head and tail.

Where it lives: on the bb server, beside the plugin's database, in
`memory/<project>__<home>/` (`main/` is the log, `tree/` the summaries,
`view.json` the view, `memory.json` the state). It is outside `data.db`, so a
plugin rollback leaves it alone. Summaries run on the server through the
`summaryRunner` CLI: `claude -p` on the server's Claude login (never an API
key), or `pi -p` with any model pi knows. Either runs with no tools, no
session and no context files, in an empty folder. After 5 failed calls in a
row, as when an account runs out, every summary stops for 10 minutes and each
memory-on assistant gets a warning.

`memory off` stops logging. If you archive or delete the main chat yourself
while memory is on, memory logs its last events, has no main chat and warns;
run `memory on` on the thread to carry on in.

Each assistant's whole log and tree stay in the server's memory, read in full
when the plugin starts, so a very long history costs RAM and start time.
If a memory write fails, memory warns once and reads its files back at the
next turn; live logging picks up what was lost from bb's event log. A failed
write stops an import; run it again to resume.

| Command | Does |
|---|---|
| `bb assistants memory on <thread-id>` | Turn memory on for a Claude Code root thread and install the hook; this thread becomes the main chat and is logged from its start. |
| `bb assistants memory off <thread-id>` | Stop logging and remove the hook. The log, `recall` and `date` stay. |
| `bb assistants memory status <thread-id> [--clear]` | On or off, main chat, counts, view size, summary progress, import progress, warnings. `--clear` clears warnings. |
| `bb assistants recall <id> [n]` | Open line `id+n` of the view into its two halves; `n = 1` gives the message whole. |
| `bb assistants date <id>` | The date and time of message `id`, zone named in words first (`2026-08-17 10:30 UTC+05:30 (2026-08-17T10:30:00+05:30)`), so a model converts it to the user's time zone. |
| `bb assistants memory rebuild <thread-id> <id>` | Summarize again every line from message `id` on, after a prompt change. Old lines serve the view until their new ones land; `memory status` shows the lines left. A message logged as the user's that a script sent (`[heartbeat]`, `[bb automation …]`) becomes work. Pause summaries while it starts. |
| `bb assistants memory view --home <dir>` | From a memory-on assistant's main chat running in `<dir>`: its rules and current view, with what they cover. Empty for any other caller: helpers in its home, or a `claude` it started elsewhere. |
| `bb assistants import <thread-id> <source>...` | Before memory is first on: seed the log from old threads (`thr_…`) or absolute JSONL paths on the server (`{kind, text, date}` per line). Runs in the background and resumes when run again. |

`recall` and `date` use the calling thread's assistant; outside a thread pass
`--assistant <thread-id>`.

Settings: `summaryRunner` (`claude` or `pi`),
`summaryModel` (`haiku`; for pi `provider/model`, e.g. `zai/glm-5.3-flash`),
`summaryPool` (8 summary calls at once across all assistants),
`summaryTarget` (512 bytes asked per line; 512 stays the limit),
`timeZone` (the IANA zone a summary call is told each message's send time
in; the bb server's by default) and
`summariesPaused` (starts no new summary call; logging and recall go on; a
session start refuses a view that grew past 128 KB meanwhile). `memory status` shows the
runner, model and pool, and why summaries are not running.

Warnings (summaries that keep failing, a failed memory write, a main chat
archived by hand) show as a `!` on the assistant's Bots row and in
`memory status`.

`scripts/eval.ts` asks a thread a list of questions and scores the answers:
`node scripts/eval.ts <thread-id> <questions.json>`.

## RPC handoff

Plugin id: `assistants`. SDK `useRpc.call` returns the result directly.
HTTP calls use `POST /api/v1/plugins/assistants/rpc/<method>` and BB's
standard `{ ok: true, result }` envelope.

`assistantSeeds({ threadId: string })` returns:

```ts
{
  title: string | null;
  projectId: string;
  environmentId: string;
  sourceHostId: string;
  identity: string | null;
  vaultPath: string | null; // source mapping, not a destination prompt seed
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  permissionMode?: string;
  serviceTier?: string;
  homePath: string | null;
  homes: Array<{ name: string; path: string }>;
  memory: boolean; // memory is on: the view goes before the first message
  machines: Array<{
    hostId: string;
    name: string;
    connected: boolean;
    assistantsRoot: string | null;
    vaultPath: string | null;
    ready: boolean;
    reason: string | null;
  }>;
}
```

`assistantDestination({ threadId: string, hostId: string })` returns:

```ts
{
  hostId: string;
  homePath: string;
  identity: string;
  vaultPath: string | null;
  homes: Array<{ name: string; path: string }>;
  ready: boolean;
  reason: string | null;
  providerAvailable: boolean; // availability of the source thread's provider
}
```

An unknown machine or invalid source throws. A known unavailable destination
returns `ready: false` with a reason; the UI withholds the composer. A missing
assistants mapping produces an empty `homePath` and `homes`.

`createReplacementThread` accepts:

```ts
{
  replaceThreadId: string;
  title: string | null; // accepted; server preserves the source thread title
  destinationHostId: string;
  homePath: string; // exact mapped destination root + source home segment
  request: NewThreadRequest; // stock public SDK composer request
}
```

It returns `{ newThreadId: string, warning?: string }`. `warning` is set when
an automation could not be moved (source kept) or the archive failed.
The server forwards the composer's project, provider, model, reasoning,
permission, service tier, execution provenance, prompt inputs, and optional
`sendAt`. It supplies `environment: { type: "host", hostId: destinationHostId,
workspace: { type: "unmanaged", path: homePath } }` to `threads.spawn`, with
the source title. Parent, source-session, and lifecycle-owner fields are not
forwarded. No native session moves or forks are used. Automations move through
the automations plugin's `automations_update` RPC with
`agent.target = { type: "target-thread", threadId: newThreadId }`, in each
automation's own project.

Malformed RPC inputs produce HTTP 400 with
`{ ok: false, error: { code: "invalid_input", message: string } }`.
Policy refusals, missing/offline/unready destinations, failed barriers, and
synchronous `threads.spawn` errors throw through BB's RPC layer: HTTP 500 with
`{ ok: false, error: { code: "handler_error", message: string } }`.
Policy checks, barriers, and listing automations fail before `threads.spawn`.
A synchronous spawn error keeps the source and composer draft. Automation and
archive failures occur after creation and are success results with `warning`,
rather than thrown failures.

HTTP success confirms conversation creation; provider provisioning can fail
afterward, leaving a created thread with `thread_provisioning_failed`. Inspect
that thread's status to verify startup. The source is archived once creation
succeeds, without waiting for provider startup; reopen it from **Past chats**.

When memory is on for the source assistant, `createReplacementThread` refuses:
the assistant keeps its one conversation.

`assistantMemory({})` returns
`{ rows: Array<{ identity: string; warning: string | null }> }`: the latest
warning of each assistant that has memory.

`pastAssistantThreads({ threadId: string })` returns
`{ rows: Array<{ id: string; createdAt: number; archivedAt: number }> }`: the
archived root conversations in the same project whose home resolves to the
same assistant identity, newest archive first.

## Disposable verification

Use a new isolated assistants project and temporary canonical mapped roots
containing the same synthetic `sam/.pi/SYSTEM.md` home on each host, plus
temporary vaults. Every start archives its source, so start from disposable
conversations. Discover and
select destination provider/model options in the normal composer. Verify
distinct conversation/session ids, actual destination cwd and vault reads,
moved automation targets, the archived source under **Past chats**, and refused spoofed roots, offline destinations,
disabled/paused/unready sync, and core execution failures.

Source tests use the official public SDK plugin harness and temporary files;
frontend tests drive the dialog with a composer stand-in. They do not verify
live core picker reconciliation, remote host transport, or native sessions.
Those require disposable live QA before enabling real folder mappings.

```sh
npm test
npm run typecheck
BB_DATA_DIR=$(mktemp -d) bb plugin build .
```
