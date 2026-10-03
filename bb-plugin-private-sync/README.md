# bb-plugin-private-sync

Two-way, real-time sync of private folders between BB machines, with the BB
server as the hub. Operating guide: [skills/private-sync/SKILL.md](skills/private-sync/SKILL.md).

## Private Sync page

Open **Private Sync** in BB navigation, or link directly to
`/plugins/private-sync/sync` from the Inbox dialog. The page shows the saved
physical folder paths, primary machine, connectivity, sync progress, exclusions,
and preserved conflicts. Use **Edit folder mapping** to change paths and
exclusions without a JSON file.

Share assistant files and personal vault memories through your BB server.
File watchers send edits both ways; offline machines reconcile when they
reconnect. Conversations stay on the selected execution machine.

| Example folder | Server (primary) | Laptop | WSL |
| --- | --- | --- | --- |
| Assistants | `/home/me/assistants` | `/Users/me/assistants` | `/home/me/assistants` |
| Personal vault | `/home/me/ObsidianVault` | `/Users/me/Vault/ObsidianVault` | `/home/me/ObsidianVault` |

These are example paths. The live page reads BB's saved map; only mapped
machines sync. The selected primary copy seeds a new folder.

- **Save mapping** applies the map while preserving enabled and paused state.
  If sync is active, changed mappings take effect immediately.
- **Enable sync** enables automatic transfers. Sync starts disabled by default.
  If Pause is already set, enabling leaves it paused until **Resume**.
- **Pause** stops all transfers while leaving the map enabled. **Resume** clears
  Pause; it does not enable a disabled map. **Disable sync** turns sync off.
- **Sync now** waits for a fresh pass on every mapped machine. It is unavailable
  when disabled, paused, or a mapped machine is offline.

The canonical map is the `folders` JSON setting in BB server settings for plugin
`private-sync`. It is stored in `<BB_DATA_DIR>/bb.db`, table
`plugin_settings`, with `plugin_id = private-sync`, `key = folders`; `enabled`
is stored alongside it.

Hub metadata is `<BB_DATA_DIR>/plugins/private-sync/data.db`; file content is
in sibling `blobs/`. `BB_DATA_DIR` selects the server's BB data directory.
Working copies stay at the mapped paths.
The page's optional details explain these locations.

Machine-local tools, secrets, and runtime files belong in exclusions. Built-in
exclusions cover common credentials, dependencies, and caches; folder exclusions
cover additional local paths. Other files inside mapped roots sync. Conflicting
edits are kept as conflict copies for review and merging.

## Layout

| File                                                      | Owns                                                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `contract.ts`                                             | Config and status schemas, the frontend `rpcContract`, the host RPC contract and signals.                                              |
| `server.ts`                                               | Settings, RPC, `bb private-sync` CLI, the background service.                                                                          |
| `lib/coordinator.ts`                                      | `SyncCoordinator`: per-folder serialized passes, connectivity polling, retries, barriers, status.                                      |
| `lib/reconcile.ts`                                        | One node's pass: upload local changes against the node's base, then apply hub changes.                                                 |
| `lib/store.ts`                                            | Hub SQLite (head, tombstones, bases, history, conflicts) and content blobs beside `data.db`.                                           |
| `host.ts`, `lib/host-fs.ts`                               | The per-machine worker: scan with a hash cache, chunked reads, temp-file writes with hash and expected-content checks, native watches. |
| `lib/paths.ts`                                            | Path safety, default exclusions, symlink rules, conflict names.                                                                        |
| `app.tsx`                                                 | Physical folder mapping editor, connectivity, sync controls, and operating explanation.                                                                                       |

Transfers move in 4 MiB chunks and yield between chunks, allowing small edits
and deletes to progress during bulk transfers. Partial transfers keep sync
barriers pending. File size is bounded by disk space.

## Develop

Requires BB 0.44 or newer with runtime Plugin SDK 0.6.16 or newer.
Development uses the published `@get-bb/plugin-sdk` package from npm.

```sh
npm install
npm test          # frontend SDK harness, temp folders, SQLite, host-entry harness
npm run typecheck
BB_DATA_DIR="$(mktemp -d)" bb plugin build
```

Frontend tests exercise disabled and offline display, edits, rejected writes,
duplicate requests, and reconnects using the official SDK app harness.
Sync tests simulate several machines in one process: each has its own temp root,
host data dir, and host entry instance. Nothing touches real folders.
