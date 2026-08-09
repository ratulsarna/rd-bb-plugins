# Usage

A small BB plugin for Codex and Claude Code subscription usage.

It shows:

- account email and plan
- every available usage window
- percentage left and reset time
- deficit or reserve against the current pace

It does not show cost, credits, account controls, dashboards, or service status.

## Install

Requires BB 0.36 or newer.

```bash
bb plugin install . --yes
```

The panel refreshes every 180 seconds while it is open. Refreshing it does not run a model or use subscription quota.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run build
```

The plugin uses BB's public usage API. It does not read or store provider credentials.

BB 0.36 does not yet return Codex model-only limits such as Spark. The plugin will show them automatically when BB adds them to its usage API.
