# rd-bb-plugins

Personal plugins for [bb](https://github.com/ymichael/bb).

## Plugins

- `bb-plugin-codex-review` — run native Codex reviews from a bb thread.
- `bb-plugin-subagent-dashboard` — monitor and control child agent threads.

## Development

All plugins use the same BB SDK declarations from `types/`. After upgrading
BB, refresh them once from the repo root:

```sh
npm run update-bb-types
```

The command works on Windows, macOS, and Linux. Plugin builds may create local
generated copies, but Git ignores them and TypeScript uses the shared files.
