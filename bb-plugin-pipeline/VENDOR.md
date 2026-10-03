# VENDOR

## Shared agent model settings

`vendor/ratulsarna-agent-models-0.4.0.tgz` is the standalone `@ratulsarna/agent-models` package. Its source lives in `agents/skills/pair-review/agent-models` in `ratulsarna/scratchpad-mbp16-m3max`. The package owns the file format, defaults, validation, and safe writes. Pipeline installs the checked-in archive through `package.json`; it has no runtime dependency on a scratchpad checkout. The general skill runs the same package's CLI directly.

To update it, change and test the source package, bump its version, run `npm pack --ignore-scripts --pack-destination <pipeline>/vendor` there, and install the archive in Pipeline with `npm install --save-exact ./vendor/<archive>.tgz --ignore-scripts`. Remove the old archive and commit the new archive, dependency, and lockfile together.

## Workflow sources

The Pipeline workflow documents are forks of the nexus skills. Upstream: `/home/ratul/scratchpad-mbp16-m3max/nexus/` at git revision `8a2273de13d3cf820d694ffcb704c964eae407b5` (`8a2273d`). The upstream checkout was not modified.

The forked bodies now live as plugin-owned documents under `workflows/`, stored on the BB server and read with `bb pipeline instructions [overview|intake|plan|implement|debug|close-out] [--file <relative-path>]`. Invocation is explicit through that command, named by Pipeline's kickoffs, review feedback batches, and each phase's exit line; once a phase exit clears, the thread reads the next phase and continues. Only the board skill `skills/pipeline` remains packaged as a skill, invoked explicitly when a thread works the board.

## Copied files

| Upstream | Here | Changes |
|---|---|---|
| `nexus-README.md` | `workflows/README.md` (overview) | renames; mode and size replace sizing; implementation walkthrough gate and run state; Board section; phase-map references rewritten to `bb pipeline instructions` commands |
| `nexus-plan/SKILL.md` | `workflows/plan/README.md` | renames; 4 report lines added (below); the run.md reference, Oracle brief, and exit rewritten to commands |
| `nexus-plan/templates/oracle.md` | `workflows/plan/templates/oracle.md` | a Guidelines section; the standard judges against that file instead of "the user's stated taste in the environment's guidance" |
| `nexus-implement/SKILL.md` | `workflows/implement/README.md` | renames; review configuration through `pair-review`; required checks before review; a shape pass when the card turns it on; implementation walkthrough before QA; board reports; template dispatch and exit rewritten to commands |
| `nexus-implement/templates/developer.md` | `workflows/implement/templates/developer.md` | a Guidelines section naming the run's `guidelines.md` |
| `nexus-implement/templates/oracle.md` | `workflows/implement/templates/oracle.md` | the guidelines path is attached; the standard judges against it instead of "the user's stated taste in the environment's guidance" |
| `nexus-implement/templates/qa.md` | `workflows/implement/templates/qa.md` | none — byte-for-byte |
| `nexus-close-out/SKILL.md` | `workflows/close-out/README.md` | renames; walkthrough approval entry gate; asynchronous external review handoff and feedback triage; implement references rewritten to commands |
| `nexus-debug/SKILL.md` | `workflows/debug/README.md` | renames; 2 report lines added (below); the run.md reference, debugger dispatch, and exit rewritten to commands |
| `nexus-debug/templates/debugger.md` | `workflows/debug/templates/debugger.md` | none — byte-for-byte |

## Renames (every occurrence)

- Upstream skill directories `nexus-plan`, `nexus-implement`, `nexus-close-out`, `nexus-debug` → the pipeline phases, now `workflows/plan`, `workflows/implement`, `workflows/close-out`, `workflows/debug`.
- Headings `# Nexus` and `# Nexus: Plan / Implement / Close-out / Debug` → `# Pipeline` and `# Pipeline: …`; the two sentences opening the overview fork ("Nexus turns…", "Nexus starts…") → "Pipeline …".
- Phase cross-references in the overview's flow lines, in each phase's exit line, and in the close-out review-gates reference read as `bb pipeline instructions <phase>` commands.
- Document references: `../nexus-README.md` in plan and in debug → the overview, read as `bb pipeline instructions overview` (the README now lives at `workflows/README.md`). Templates are read through the phase command's `--file`; `run.md` remains a task-local artifact in the run directory.

## Copied prose edits

- `workflows/README.md`: a "Guidelines" section and a `guidelines.md` artifact. Pipeline ships `workflows/guidelines/README.md`; the `guidelinesFile` and `guidelinesSection` settings can point `bb pipeline instructions guidelines` at a file on the BB server. The lead saves that output once per run and hands the path to the Oracle, the developer, and any reviewer whose prompt names it.
- `workflows/README.md`: "Mode and size" replaces "Sizing". Mode (`manual` or `auto`) sets which stops need the user; auto keeps the implementation walkthrough, after QA, and what only the user can decide. Size (`small` or `standard`) sets whether the lead or a developer worker writes the code. A bug's size stays provisional until the RCA. The user can change either mid-run; Pipeline tells the lead. Non-negotiable 6 gives every diff two reviewer passes; non-negotiable 9 places the walkthrough by mode.
- `workflows/implement/README.md`: every task has a user walkthrough of the resulting implementation, before QA in manual and after QA in auto. On size small, the lead writes the code as the owning worker. It owns step-by-step `/show-me` delivery, deviation explanations, approval, resume, and rework rules. Its execution instructions permit this approval stop.
- `workflows/README.md`: `run.md` records mode and size, and the implementation walkthrough's outline, progress, reviewed commit, and approval.
- `workflows/plan/README.md`: in auto, the lead settles the understanding and goes from Shape to implement without the plan walkthrough.
- `workflows/debug/README.md`: in manual, the user sizes the diagnosed fix at the RCA stop; in auto, the lead sizes it. Both continue to plan.
- Phase exits and the flow overview drop the upstream note about slash commands.
- `workflows/close-out/README.md`: entry requires the approved implementation walkthrough; material changes return through its rework rule. External review uses `review-wait` and asynchronous feedback batches instead of provider-specific polling. The Oracle remains available for subsequent review decisions.
- `workflows/README.md`, `workflows/plan/README.md`, and `workflows/close-out/README.md`: scope, decisions, classification, and outcomes for imported GitHub issues are saved as card notes through `bb pipeline report --body-file`. Agents change the source issue only after the user approves.
- `workflows/close-out/README.md`: the PR body carries `Closes #<n>` for the task's issue.

## Additions: board report lines

One line per site, in the phase document the moment belongs to; the full table appears once in the overview. Column-move lines carry `--working`; `--needs-you` lines state it.

- `workflows/README.md`: "## Board" report table with the `--working` default in the lead-in. It covers intake stops, plan and implementation walkthroughs, the post-RCA size report, and the external review handoff and feedback acknowledgement. In auto, the plan walkthrough and RCA stop rows do not apply.
- `workflows/plan/README.md`, 4 lines:
  - top of "Understand, with the user": `` `bb pipeline report --column planning --working` ``
  - end of "Understand, with the user" (questions in understand or grill): `` `bb pipeline report --needs-you "<question in one line>"` ``
  - top of "Walkthrough — the user's review" (Shape done, before the first step): `` `bb pipeline report --column plan_ready --needs-you "plan ready; walkthrough step 1 of M"` ``
  - end of "Walkthrough — the user's review" (each later step): `` `bb pipeline report --needs-you "walkthrough step N of M"` ``
- `workflows/debug/README.md`, 2 lines:
  - end of process step 3 (RCA done, before any fix): `` `bb pipeline report --needs-you "root cause found; size the fix"` ``
  - exit once the fix is sized: `` `bb pipeline report --size <s> --working` ``
- `workflows/implement/README.md`:
  - top of "Dispatch" (start): `` `bb pipeline report --column implementing --working` ``
  - end of gate 1 (review passes start): `` `bb pipeline report --column reviewing --working` ``
  - end of gate 4: ``When findings send it back to the worker: `bb pipeline report --column implementing --working` ``
  - gate 5, each implementation walkthrough step: `` `bb pipeline report --column reviewing --needs-you "implementation walkthrough; step N of M"` ``
  - gate 6 (QA starts, then QA sends it back): `` `bb pipeline report --column qa --working` `` and ``When QA sends it back: `bb pipeline report --column implementing --working` ``
- `workflows/close-out/README.md`: links the draft PR with a board report, hands off review with `review-wait`, and acknowledges delivered feedback with `--handled <batch-id>`.

## New files, no upstream counterpart

- `skills/pipeline/SKILL.md` — the board skill available to every thread: add, list, show, move cards; upload attachments first.
- `skills/pipeline/agents/openai.yaml` — disables implicit Codex invocation of the board skill.
- `workflows/intake/README.md` — intake: read the note and attachments, ask what this is, grill, file the issue, get mode and size when the card lacks them, label bugs, hand off to planning; steps 2, 3, 5, and 7 report each stop for the user with `--needs-you`. Imported issues use their snapshot, clarify missing context, and save local scope without filing or labeling an issue.
- `lib/control-prompts.ts` `settingsChangeInstruction` — the message Pipeline sends the owner when the user changes mode or size.

No symlinks anywhere under `skills/` or `workflows/`.

## Editable defaults

Settings saves overrides for workflow documents, role templates, kickoff prompts, and guidelines. Each task uses a snapshot captured before kickoff. Kickoff templates and shared prompt fragments live under `workflows/kickoff/` and are rendered by `lib/prompts.ts`.
