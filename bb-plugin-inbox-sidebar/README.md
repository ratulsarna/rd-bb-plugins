# Inbox Sidebar assistant conversations

Use a Bots row's **New thread with …** action to open BB's normal composer.
**Machine** chooses where the fresh root conversation starts. **Home** shows
the same assistant home segment under that machine's mapped assistants root.
Only machines with a canonical assistants root appear in the selector;
offline or unready mapped machines remain visible with their reasons.
The dialog shows the destination **Vault**, connection status, and readiness
reason. Source history is a reference in the first message; the new session
starts empty.

Starting on another machine keeps the source conversation intact. On the
same machine, **Replace and archive the selected conversation after creation**
is unchecked by default and must be selected deliberately. Opening the dialog
or changing machines clears it. A synchronous creation refusal keeps the source.
An archive failure returns the created conversation's id and displays a
warning, allowing navigation without another creation attempt.

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
The flow performs no file copying and changes no automation targets. Sam's
journal pointers use the destination vault.

Bots renders each unarchived root conversation with its SDK machine name.
Assistant titles, identity-based subtitles and ordering stay shared across
machines. Bots uses the first project whose lowercase name is `assistants`;
a second project named `Assistants` is not hidden by capitalization.

## RPC handoff

Plugin id: `inbox-sidebar`. SDK `useRpc.call` returns the result directly.
HTTP calls use `POST /api/v1/plugins/inbox-sidebar/rpc/<method>` and BB's
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
  targetingAutomations: Array<{ id: string; name: string }>;
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
  archiveSource: boolean; // must be false across machines
  request: NewThreadRequest; // stock public SDK composer request
}
```

It returns `{ newThreadId: string, archivedSource: boolean, archiveError?: string }`.
The server forwards the composer's project, provider, model, reasoning,
permission, service tier, execution provenance, prompt inputs, and optional
`sendAt`. It supplies `environment: { type: "host", hostId: destinationHostId,
workspace: { type: "unmanaged", path: homePath } }` to `threads.spawn`, with
the source title. Parent, source-session, and lifecycle-owner fields are not
forwarded. No native session moves or forks are used.

Malformed RPC inputs produce HTTP 400 with
`{ ok: false, error: { code: "invalid_input", message: string } }`.
Policy refusals, missing/offline/unready destinations, failed barriers, and
synchronous `threads.spawn` errors throw through BB's RPC layer: HTTP 500 with
`{ ok: false, error: { code: "handler_error", message: string } }`.
Policy checks and barriers fail before `threads.spawn`. A synchronous spawn
error keeps the source and composer draft. Archive failure occurs after creation
and is a success result with `archivedSource: false` and `archiveError`, rather
than a thrown failure.

HTTP success confirms conversation creation; provider provisioning can fail
afterward, leaving a created thread with `thread_provisioning_failed`. Inspect
that thread's status to verify startup. With `archiveSource: false`, the source
stays intact after such a failure. Explicit replacement archives the source
after creation succeeds and does not wait for successful provider startup.

## Disposable verification

Use a new isolated assistants project and temporary canonical mapped roots
containing the same synthetic `sam/.pi/SYSTEM.md` home on each host, plus
temporary vaults. Keep `archiveSource: false` for live QA starts. Discover and
select destination provider/model options in the normal composer. Verify
distinct conversation/session ids, actual destination cwd and vault reads,
source preservation, and refused spoofed roots, offline destinations,
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
