# bb usage plugin scratchpad

Scope: Codex + Claude Code quota windows only. Show account email, account plan, remaining %, reset, and signed pace delta. Explicitly omit credits, spend/cost, dashboards, status, account switching, token utilization history, and settings.

Data:
- Codex: spawn `codex -s read-only -a untrusted app-server`; JSONL RPC initialize, initialized, `account/read`, `account/rateLimits/read`. Parse primary, secondary, and any named/additional windows. No direct auth file reads needed.
- Claude: `claude auth status --json` for email/plan. Read the active Claude-owned `.credentials.json` only in memory and call `GET https://api.anthropic.com/api/oauth/usage`. Parse `limits` first, flat `five_hour`/`seven_day` fields as fallback, and de-dupe. Exclude `extra_usage`, `spend`, and cost data. Never log/return/store token. Never refresh token; Claude owns login.
- Current host probe 2026-08-08: Codex app-server works; Claude auth status and OAuth usage/profile work.

Normalized RPC shape:
providers: [{ id, label, email, plan, updatedAt, windows: [{ id, label, remainingPercent, resetsAt, windowMinutes, pace }] }]
pace: null | { deltaPercent, status: deficit|reserve|on-pace, expectedUsedPercent }

Pace = actual used % - expected used %. Expected = elapsed/window * 100. Positive is deficit, negative is reserve. On pace within +/-2. Hide pace before expected reaches 3%, matching CodexBar's noise guard. Use per-window known duration (5h, 7d, or response value). Do not implement Codex historical learned pace in v1; it is a separate history feature and conflicts with the tiny scope.

bb shape:
- One `navPanel`: Usage, icon Gauge.
- Shared header owns title; `headerContent` has Updated time + Refresh.
- Add one setting: sidebar provider (`codex` default or `claude`).
- Show that provider's weekly pace at the right of the Usage sidebar row: compact `+5%` deficit / `-8%` reserve / `0%` on pace. Tooltip and screen-reader text carry the full meaning.
- Refresh the server cache every 180 seconds, publish realtime, and update the sidebar even while the Usage panel is closed.
- Current bb SDK has no nav-row accessory/badge slot. Preferred implementation needs a small bb SDK/app change such as `navPanel.sidebarAccessory`; do not ship a DOM-query/MutationObserver patch.
- Body is two plain provider columns on wide screens, stacked on narrow. No dashboard card grid.
- RPC fetch on mount, 60s server cache, manual refresh bypass. Frontend refresh every 5m while mounted. No background service/database/settings.
- Bars drain from 100% filled when all usage remains to empty at 0% remaining.
- Expected remaining marker inside bar. Text below says `8% in deficit`, `6% in reserve`, or `On pace`.
- Provider failure is isolated: one can render while the other shows login/error help.

Tests worth having:
- JSONL RPC ignores notifications/out-of-order messages, times out, kills child.
- Claude parser de-dupes `limits` vs legacy flat fields and excludes extra usage/spend.
- Pace boundaries: before start, exact reset, 3% noise guard, +/-2 on-pace, 100% used.
- Token never appears in normalized response or logged errors.

Host boundary: backend runs on the bb server host and reads that host's Codex/Claude login. Current server has both. Remote-machine account selection is not v1.
