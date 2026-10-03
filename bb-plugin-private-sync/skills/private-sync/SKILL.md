---
name: private-sync
description: Operate the Private Sync plugin with `bb private-sync`. Use when the user asks to configure, check, pause, resume, or wait for sync of private folders (assistants, personal vault) between BB machines, or to read sync conflicts.
---

# Private Sync

Private Sync keeps named folders the same on every listed BB machine. The BB
server is the hub. Each machine's copy of a folder is a node. Files travel
over BB's own machine connections, so there is no extra port, account, or
outside service. The hub keeps the current state, every machine's last
agreed state, old versions, and file contents in the plugin's own data
directory on the server (`<BB_DATA_DIR>/plugins/private-sync/data.db` and
sibling `blobs/`). Shared assistant files and vault memories travel between
machines; conversations stay on the selected execution machine. File watchers
send changes both ways; offline machines reconcile on reconnect.

## Page and saved map

Open **Private Sync** in BB navigation, or `/plugins/private-sync/sync`.
Inbox can link to this absolute page path. `toPluginPanel` is scoped to the
calling plugin, so Inbox must use the absolute URL rather than its own panel
navigation helper.

The page shows the physical folder map, primary copy, each machine's connectivity
and sync phase, exclusions, and preserved conflicts. **Edit folder mapping**
provides folder, machine, path, primary, and exclusion controls without raw JSON.
**Save mapping** preserves enabled and paused state. Changes take effect
immediately if sync is active. **Enable sync** enables transfers unless paused;
**Pause** stops transfers without disabling the map; **Resume** clears Pause.
Resume alone does not enable a disabled map. Default sync is disabled.

| Example folder | Server (primary) | Laptop | WSL |
| --- | --- | --- | --- |
| Assistants | `/home/me/assistants` | `/Users/me/assistants` | `/home/me/assistants` |
| Personal vault | `/home/me/ObsidianVault` | `/Users/me/Vault/ObsidianVault` | `/home/me/ObsidianVault` |

These are example paths. The selected primary copy seeds a new folder;
later changes sync in both directions. Read current status for the saved map
and machine names. Only mapped machines sync.

The canonical map is the `folders` JSON setting in BB server settings for
plugin `private-sync`. It lives in `<BB_DATA_DIR>/bb.db`, table
`plugin_settings`, `plugin_id = private-sync`, `key = folders`; `enabled` is
stored alongside it. Hub sync metadata is
`<BB_DATA_DIR>/plugins/private-sync/data.db`; content blobs are in sibling
`blobs/`. `BB_DATA_DIR` selects the server's BB data directory. The page
explains these locations in optional details.

## Commands

| Command | Effect |
| --- | --- |
| `bb private-sync status [--json]` | Folders, each machine's phase, lag, open conflicts, errors. |
| `bb private-sync configure --file <path> [--host <id>] [--json]` | Replace the folder config from a JSON file on the calling machine. |
| `bb private-sync pause` / `resume` | Stop or restart all syncing. The choice survives restarts. |
| `bb private-sync sync --folder <id> [--host <id> ...] [--timeout 10m] [--json]` | Wait until the named machines (default all) finish a fresh full pass and match the hub. |

`configure` reads the file through BB from the machine that runs the
command: the calling thread's machine, else `--host`, else the server.

## CLI configuration input

```json
{
  "enabled": false,
  "folders": [
    {
      "id": "assistants",
      "label": "Assistants",
      "primaryHostId": "host_server",
      "nodes": [
        { "hostId": "host_server", "path": "/home/me/assistants" },
        { "hostId": "host_laptop", "path": "/Users/me/assistants" }
      ],
      "ignorePaths": ["bots/inbox/state"]
    }
  ]
}
```

- `id` is lowercase letters, digits, and `-`. `label` is for people.
- `nodes` lists persistent machines only, one node per machine. Paths are
  absolute. Two folders may not overlap on the same machine.
- `primaryHostId` is the machine whose copy seeds a new folder. It defaults
  to the server's own machine and must be one of the nodes.
- `ignorePaths` are root-relative paths; each one also covers everything
  under it. List every service-only file here (cursors, tokens, caches a
  bot writes) so it stays on its own machine. Excluding a path that already
  synced leaves every machine's copy where it is and stops all transfers of it.
- `enabled` defaults to false. The config is stored in the plugin's BB
  settings, never in the folders.

## What is never mirrored

At any depth: `.git`, `node_modules`, `.venv`, `__pycache__`,
`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.DS_Store`, `Thumbs.db`,
`.env`, `.env.*`, `.mcp.json`, `.credentials.json`, `settings.local.json`,
`.wispr`, `.firecrawl`, and `projects`, `cache`, `todos`, `history` directly
inside a `.claude` directory. The rest of `.claude` and `.codex` (skills,
commands) syncs. Scratch and output files sync like any other file.

Symlinks sync only when their target is relative and stays inside the folder
(`CLAUDE.md -> AGENTS.md`). Links that leave the folder, sockets, and other
special files are skipped. Sync never follows a symlink.

## How changes are judged

- A machine's change wins when the hub still holds what that machine last
  agreed on. The same change made on two machines is not a conflict.
- When both sides changed, the hub keeps the version it has. The other
  version is saved beside it as `name.sync-conflict-<time>-<machine>.ext` on
  every machine. Delete the copy once you have merged it; that closes the
  conflict.
- An edit beats a delete: an edited file that was deleted elsewhere comes
  back as a conflict copy, and a deleted file that was edited elsewhere is
  restored.
- Deletes are kept as tombstones, so a machine that was offline cannot bring
  a deleted file back unless it edited that file.
- A new machine never loses its files. Files it has that the hub lacks are
  uploaded; files that differ become conflict copies.
- A missing root or an unexpected empty root stops that machine with an
  error. An empty root can recover after a hub-requested deletion when the
  hub explicitly records every previously held path as deleted.
- Incoming files are staged and checked against their hash. Replacing or
  deleting a target captures the existing entry, checks its content, then
  publishes without overwriting a concurrent editor save. A reader can
  briefly observe a missing path during replacement. Captured edits survive
  an interrupted operation and are recovered before subsequent scans.
- This protection covers atomic editor saves. A program that keeps writing
  through an open file handle can still alter the captured inode.
- Incoming files are owner-only: mode 600, or 700 when executable.
  Only the executable bit travels between machines.
- Conflicting file and directory layouts stop the affected node with an
  error and preserve its local files. Resolve the layout before retrying sync.

Large uploads and downloads yield between chunks so small edits and deletes
can progress during bootstrap. A partial transfer never completes a sync barrier.

Old versions stay on the hub for 30 days. There is no restore command; ask
the user before reading hub storage.

## Status phases

`offline`, `waiting-for-primary` (the primary has not seeded the folder),
`pending`, `syncing`, `error`, `ready`, `paused`, `disabled`. `ready` means a
full pass finished since the config last changed and nothing is outstanding.
Open conflicts do not stop `ready`; they are listed in status.

## Procedure

1. Run `bb private-sync status` before changing anything.
2. To set up or change folders, use **Edit folder mapping** on the page and
   **Save mapping**, then check status. For CLI workflows, write configuration
   input to a private file outside every synced folder and run `configure --file`.
   Saving preserves enabled state unless the input explicitly includes `enabled`.
3. Try a new setup on throwaway folders first. Enable real folders only
   after the user agrees.
4. Before work moves between machines, run `bb private-sync sync --folder
   <id> --host <from> --host <to>` for each folder it needs.
5. Report conflicts by their conflict path. Do not delete a conflict copy
   unless the user asks.

## Rules

- Change sync only through `bb private-sync` or the Private Sync page. Do not
  edit the plugin's database or blobs.
- Do not put secrets in a synced folder unless they match a default
  exclusion or an `ignorePaths` entry.
- Never print file contents or paths from the folders into logs or shared
  places.
