# bb usage plugin scratchpad

Scope: Codex + Claude Code quota windows only. Show account email, account plan, remaining %, reset, and signed pace delta. Explicitly omit credits, spend/cost, dashboards, status, account switching, token utilization history, and settings.

Data:
- Use BB 0.36's public `bb.sdk.system.usageLimits()` API. BB already handles Codex and Claude Code authentication and isolates provider failures.
- Keep only Codex and Claude Code. Strip Cursor, cost, credits, and raw provider error messages from the plugin response.
- Do not read credentials, spawn provider CLIs, store usage, or log account data.

Normalized RPC shape:
`{ fetchedAt, providers: { codex, claudeCode } }`

Each provider has `id`, `name`, `status`, `accountEmail`, `planLabel`, and `windows`. Each window has `label`, `remainingPercent`, `resetsAt`, and `pace`.

`pace: null | { kind: deficit|reserve|on_pace, percentage }`

Pace = actual used % - expected used %. Expected = elapsed/window * 100. Positive is deficit, negative is reserve. On pace within +/-2. Hide pace before expected reaches 3%, matching CodexBar's noise guard. Use per-window known duration (5h, 7d, or response value). Do not implement Codex historical learned pace in v1; it is a separate history feature and conflicts with the tiny scope.

bb shape:
- One `navPanel`: Usage, icon Zap.
- Shared header owns title; `headerContent` has Updated time + Refresh.
- No sidebar value or provider setting in v1. BB has no safe nav-row accessory API yet; track that separately in issue #1202.
- Body is two plain provider columns on wide screens, stacked on narrow. No dashboard card grid.
- RPC fetch on mount, 60s server cache, manual refresh bypass. Frontend refresh every 180 seconds while mounted. No background service, database, or settings.
- Bars drain from 100% filled when all usage remains to empty at 0% remaining.
- Expected remaining marker inside bar. Text below says `8% in deficit`, `6% in reserve`, or `On pace`.
- Provider failure is isolated: one can render while the other shows login/error help.

Tests worth having:
- Pace boundaries: before start, exact reset, 3% noise guard, +/-2 on-pace, 100% used.
- Remaining percentage clamps safely and bars fill in the remaining direction.
- Cursor, cost, and raw errors never appear in the normalized response.
- One provider failure does not hide the other provider.
- Cache, in-flight request sharing, manual refresh, and the 180-second UI refresh work as promised.

Host boundary: omitting `hostId` uses BB's primary machine. Choosing another machine is not v1.
