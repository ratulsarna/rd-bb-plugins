# rd-bb-plugins

Personal plugins for [bb](https://github.com/ymichael/bb).

## Plugins

- [`bb-plugin-inbox-sidebar`](./bb-plugin-inbox-sidebar) — organize threads in an inbox sidebar. [t3code](https://github.com/pingdotgg/t3code) style.
- [`bb-plugin-bb-sidebar`](./bb-plugin-bb-sidebar) — vendored [yusuf8834/bb-sidebar](https://github.com/yusuf8834/bb-sidebar) with the assistants fleet as a Bots section on top. See its `VENDOR.md`.
- [`bb-plugin-usage`](./bb-plugin-usage) — view Codex and Claude Code subscription usage.
- [`bb-plugin-claude-accounts`](./bb-plugin-claude-accounts): switch Claude Code accounts on selected machines from any BB browser.
- [`bb-plugin-favorites`](./bb-plugin-favorites) — save machine / harness / model setups and open New Thread already set to them.
- [`bb-plugin-notify`](./bb-plugin-notify) — get BB thread notifications on macOS and iPhone Home Screen PWAs.
- [`bb-plugin-sam-scribe`](./bb-plugin-sam-scribe) — run Sam's scribe when a Sam thread goes quiet, so the daily journal keeps up.
- [`bb-plugin-pipeline`](./bb-plugin-pipeline) — run intake, planning, implementation, review, QA, and PR work from one project board.

## Development

Plugins share the BB SDK declarations in `types/`. Refresh them after updating
bb:

```sh
npm run update-bb-types
```

## Screenshots

<img width="270" height="896" alt="image" src="https://github.com/user-attachments/assets/86b21a30-ab24-49f1-838a-7c1cbe2a1c54" />

<img width="528" height="764" alt="Screenshot 2026-08-09 at 7 54 24 PM" src="https://github.com/user-attachments/assets/c060a8c8-397a-4a3d-815f-a3208796c2ba" />
