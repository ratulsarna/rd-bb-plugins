# Subagent Dashboard

A local bb plugin for monitoring and steering child agent threads.

## Development

```sh
npm install
npm run typecheck
bb plugin build
bb plugin install .
bb plugin dev
```

The plugin adds a **Subagents** navigation panel and a per-thread
**Subagents** side-panel action. It shows direct child status and supports
opening, stopping, steering, and queueing follow-up work.
