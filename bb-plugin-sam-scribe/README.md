# bb-plugin-sam-scribe

Runs Sam's scribe when a Sam thread goes quiet. The scribe is `observe.py`
in `~/assistants/sam/memory`; it keeps Ratul's daily note in the vault from
Sam's conversations. That folder's README has the whole memory design.

What the plugin does:

- On `thread.idle` for a top-level thread titled Sam in Sam's environment,
  wait a quiet window (default 120 s), then run the scribe on that thread.
  Another idle inside the window restarts the wait; the thread waking up
  cancels it.
- Threads are read one at a time. The script owns the cursor, so a run that
  gets cancelled or skipped is picked up next time.
- Once an hour, at minute 17, sweep every Sam thread for anything missed.
- `bb sam-scribe run` queues a sweep now.

Settings: `samEnvPath`, `scriptDir`, `quietSeconds`.

The script exits 2 when nothing is loaded on edgexpert. That is logged as a
deferral, never a failure, because asking for another model would trigger a
swap across both Sparks.

```sh
npm install
npm run typecheck
npm test
bb plugin install .
bb plugin logs sam-scribe -f
```
