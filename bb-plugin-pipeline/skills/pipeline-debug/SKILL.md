---
name: pipeline-debug
disable-model-invocation: true
description: A worker produces an evidence-backed root cause before any fix is planned or written. Use for bugs, regressions, test failures, unexpected behavior.
---

# Pipeline: Debug

A root cause can arrive pre-done: a ticket already carrying reproduction, evidence, and cause satisfies the gate once spot-checked against the current code.

## Process

1. **Create `run.md`** per `../pipeline-plan/references/pipeline-README.md`, then **dispatch a worker** from `templates/debugger.md`. Give it symptoms, where the bug surfaces, and what's been tried.
2. **The deliverable is the root cause, not a fix**, written to `rca.md` in the artifact directory: an evidence-backed root cause the lead can follow and verify. Reproduction is preferred when practical; when it is not, the strongest available evidence, with the remaining uncertainty stated.
3. **Tell the user** the root cause, the evidence chain in short, the fix direction, and how a regression would be caught: a test that fails before the fix and passes after where that buys real coverage, otherwise the strongest check with captured evidence. Then stop; the user tiers the fix from there.
   `bb pipeline report --needs-you "root cause found; tier the fix"`

**Exit:** after the user tiers the fix, run `bb pipeline report --tier <t> --working` → `pipeline-plan` or `pipeline-implement`.
