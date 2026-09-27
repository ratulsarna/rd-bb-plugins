# Usage

A small BB plugin for Codex, Claude Code, and Z.ai coding plan usage.

It shows:

- account email and plan
- one Claude Code card per account across BB machines, with its machine names
- every available usage window
- percentage left and reset time
- deficit or reserve against the current pace

It does not show cost, credits, account controls, dashboards, or service status.

## Install

Requires BB with Plugin SDK 0.5.31 or newer.

```bash
bb plugin install . --yes
```

The panel refreshes every 180 seconds while it is open. Refreshing it does not run a model or use subscription quota. If a manual refresh finds an expired Claude Code sign-in on the primary server, the plugin runs Claude's local `/status` command in a short-lived PTY on BB's primary server so Claude can refresh its own credentials.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run build
```

Claude Code usage is checked on every connected BB machine. Machines without Claude Code are omitted. Accounts are grouped by BB's account key, with email as a fallback when the key is missing. Accounts without either stay separate. Matching quotas are shown once, never added together. A working reading takes precedence over a failed reading from another machine on the same account. Offline machines are shown separately because their current login cannot be checked. Each refresh reads the machine list and accounts again, so login changes do not keep old account labels.

Codex uses the primary machine. Claude's manual credential recovery also runs only on the primary server. For an expired login on another machine, open Claude Code there and refresh Usage.

Codex and Claude Code come from BB's public usage API; the plugin does not read, copy, log, or store their credentials.

Z.ai has no BB usage API, so the plugin calls `api.z.ai` itself with an API key you give it. Set it in the plugin's settings (`Z.ai API key`, stored as a BB secret setting) and reload the plugin. The key is sent only to `api.z.ai` to read quota limits.

BB 0.36 does not yet return Codex model-only limits such as Spark. The plugin will show them automatically when BB adds them to its usage API.
