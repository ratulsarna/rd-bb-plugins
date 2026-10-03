Private Sync keeps chosen folders the same on every BB machine you list, as
you edit them. Your own BB server is the hub, and files travel over the
connections BB already has to your machines. There is no new port, account,
or outside sync service.

## What you get

- Two-way sync of named folders, with each machine's copy in its own path.
- Conflict copies instead of silent overwrites. When two machines change the
  same file, both versions stay on disk.
- Deletes that stick: a machine that was offline cannot bring a deleted file
  back.
- A missing or empty folder stops sync on that machine instead of deleting
  files everywhere.
- Large and binary files, executable bits, and symlinks that stay inside the
  folder.
- `bb private-sync status`, `sync`, `pause`, and `resume` for scripts and
  agents, plus a page in BB.

## Privacy

Folder paths and settings stay in BB's settings. Version control folders,
dependency trees, caches, `.env` files, and per-machine credential files are
never copied. Add your own per-folder exclusions for anything else that must
stay on one machine. Old versions are kept on the hub for 30 days.
