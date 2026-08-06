# Codex Review for bb

Adds a review button to every thread header. Review uncommitted changes, changes
against a searchable local or remote branch, a recent commit, or custom review
instructions. Choose a Codex model and one of that model's supported reasoning
efforts, or inherit Codex's configured defaults. Codex's native review runs in
the thread's exact workspace and streams its result into a persistent bb side
panel.

Agents can invoke the same review flow and receive the final output:

```sh
bb codex-review uncommitted
bb codex-review base origin/main
bb codex-review commit abc1234
bb codex-review custom "Focus on concurrency and data loss"
bb codex-review uncommitted --model gpt-5.6-sol --effort high
bb codex-review custom -- "Review literal --model handling"
```

Pass `--model` and `--effort` to override Codex's configured defaults. Pass
`--thread <threadId>` when the command is not run from a bb thread context.
Long reviews continue in bb after the first CLI request returns; retrieve the
durable result with `bb codex-review result`.

## Develop

```sh
npm install
npx tsc --noEmit
bb plugin build
bb plugin install . --yes
```
