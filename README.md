# rd-bb-plugins

Personal plugins for [bb](https://github.com/ymichael/bb).

## Plugins

- [`bb-plugin-codex-review`](./bb-plugin-codex-review) — run Codex reviews from a thread.
- [`bb-plugin-inbox-sidebar`](./bb-plugin-inbox-sidebar) — organize threads in an inbox sidebar.
- [`bb-plugin-usage`](./bb-plugin-usage) — view Codex and Claude Code subscription usage.

## Development

Plugins share the BB SDK declarations in `types/`. Refresh them after updating
bb:

```sh
npm run update-bb-types
```
