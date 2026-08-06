# Codex Review for bb

Adds a review button to every thread header. Choose uncommitted changes, a base
branch, or one commit, then run Codex's native `codex review` command in that
thread's workspace and stream the result into a bb side panel.

## Develop

```sh
npm install
npx tsc --noEmit
bb plugin build
bb plugin install . --yes
```
