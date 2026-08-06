# Codex Review for bb

Adds a review button to every thread header. Review uncommitted changes, changes
against a searchable local or remote branch, a recent commit, or custom review
instructions. Codex's native `codex review` runs in the thread's exact workspace
and streams its result into a persistent bb side panel.

Agents can invoke the same review flow and receive the final output:

```sh
bb codex-review uncommitted
bb codex-review base origin/main
bb codex-review commit abc1234
bb codex-review custom "Focus on concurrency and data loss"
```

Pass `--thread <threadId>` when the command is not run from a bb thread context.

## Develop

```sh
npm install
npx tsc --noEmit
bb plugin build
bb plugin install . --yes
```
