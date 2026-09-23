# VENDOR

The `pipeline-*` skills are forks of the nexus skills. Upstream: `/home/ratul/scratchpad-mbp16-m3max/nexus/` at git revision `8a2273de13d3cf820d694ffcb704c964eae407b5` (`8a2273d`). The upstream checkout was not modified.

## Copied files

| Upstream | Here | Changes |
|---|---|---|
| `nexus-README.md` | `skills/pipeline-plan/references/pipeline-README.md` | renames; sizing exception; implementation walkthrough gate and run state; Board section |
| `nexus-plan/SKILL.md` | `skills/pipeline-plan/SKILL.md` | renames; 4 report lines added (below) |
| `nexus-plan/templates/oracle.md` | `skills/pipeline-plan/templates/oracle.md` | none — byte-for-byte |
| `nexus-implement/SKILL.md` | `skills/pipeline-implement/SKILL.md` | renames; implementation walkthrough before QA; board reports |
| `nexus-implement/templates/developer.md` | `skills/pipeline-implement/templates/developer.md` | none — byte-for-byte |
| `nexus-implement/templates/oracle.md` | `skills/pipeline-implement/templates/oracle.md` | none — byte-for-byte |
| `nexus-implement/templates/qa.md` | `skills/pipeline-implement/templates/qa.md` | none — byte-for-byte |
| `nexus-close-out/SKILL.md` | `skills/pipeline-close-out/SKILL.md` | renames; walkthrough approval entry gate; asynchronous external review handoff and feedback triage |
| `nexus-debug/SKILL.md` | `skills/pipeline-debug/SKILL.md` | renames; 2 report lines added (below) |
| `nexus-debug/templates/debugger.md` | `skills/pipeline-debug/templates/debugger.md` | none — byte-for-byte |

Each skill has `disable-model-invocation: true` and an `agents/openai.yaml` with `policy.allow_implicit_invocation: false`. Invocation is explicit; the Nexus UI metadata is not copied.

## Renames (every occurrence)

- Directories `nexus-plan`, `nexus-implement`, `nexus-close-out`, `nexus-debug` → `pipeline-plan`, `pipeline-implement`, `pipeline-close-out`, `pipeline-debug`.
- Frontmatter `name:` in each copied `SKILL.md` → the new directory name.
- Headings `# Nexus` and `# Nexus: Plan / Implement / Close-out / Debug` → `# Pipeline` and `# Pipeline: …`; the two sentences opening the README fork ("Nexus turns…", "Nexus starts…") → "Pipeline …".
- Skill cross-references: `nexus-plan` → `pipeline-plan`, `nexus-implement` → `pipeline-implement`, `nexus-close-out` → `pipeline-close-out`, `nexus-debug` → `pipeline-debug` — in the README fork's flow lines, in each skill's exit line, and in the close-out review-gates reference.
- README references: `../nexus-README.md` in plan → `references/pipeline-README.md`; `../nexus-README.md` in debug → `../pipeline-plan/references/pipeline-README.md` (the README moved inside the plan skill).

## Copied prose edits

- `pipeline-README.md`: sizing says the lead does not re-tier except for a bug, whose intake tier stays provisional until the RCA stop and is finalized by the user there.
- `pipeline-implement/SKILL.md`: every tier has a user walkthrough of the resulting implementation before QA or close-out. It owns step-by-step `/show-me` delivery, deviation explanations, approval, resume, and rework rules. Its execution instructions permit this approval stop.
- `pipeline-README.md`: sizing retains the implementation walkthrough for small and trivial work; `run.md` records its outline, progress, reviewed commit, and approval.
- `pipeline-close-out/SKILL.md`: entry requires the approved implementation walkthrough; material changes return through its rework rule. External review uses `review-wait` and asynchronous feedback batches instead of provider-specific polling. The Oracle remains available for subsequent review decisions.

## Additions: board report lines

One line per site, in the skill the moment belongs to; the full table appears once in the README fork. Column-move lines carry `--working`; `--needs-you` lines state it.

- `pipeline-README.md`: "## Board" report table with the `--working` default in the lead-in. It covers intake stops, plan and implementation walkthroughs, the post-RCA tier report, and the external review handoff and feedback acknowledgement. Small and trivial tiers skip only plan walkthrough reports.
- `pipeline-plan/SKILL.md`, 4 lines:
  - top of "Understand, with the user": `` `bb pipeline report --column planning --working` ``
  - end of "Understand, with the user" (questions in understand or grill): `` `bb pipeline report --needs-you "<question in one line>"` ``
  - top of "Walkthrough — the user's review" (Shape done, before the first step): `` `bb pipeline report --column plan_ready --needs-you "plan ready; walkthrough step 1 of M"` ``
  - end of "Walkthrough — the user's review" (each later step): `` `bb pipeline report --needs-you "walkthrough step N of M"` ``
- `pipeline-debug/SKILL.md`, 2 lines:
  - end of process step 3 (RCA done, before any fix): `` `bb pipeline report --needs-you "root cause found; tier the fix"` ``
  - exit after the user tiers the fix: `` `bb pipeline report --tier <t> --working` ``
- `pipeline-implement/SKILL.md`:
  - top of "Dispatch" (start): `` `bb pipeline report --column implementing --working` ``
  - end of gate 1 (review passes start): `` `bb pipeline report --column reviewing --working` ``
  - end of gate 4: ``When findings send it back to the worker: `bb pipeline report --column implementing --working` ``
  - gate 5, each implementation walkthrough step: `` `bb pipeline report --column reviewing --needs-you "implementation walkthrough; step N of M"` ``
  - gate 6 (QA starts, then QA sends it back): `` `bb pipeline report --column qa --working` `` and ``When QA sends it back: `bb pipeline report --column implementing --working` ``
- `pipeline-close-out/SKILL.md`: links the draft PR with a board report, hands off review with `review-wait`, and acknowledges delivered feedback with `--handled <batch-id>`.

## New files, no upstream counterpart

- `skills/pipeline/SKILL.md` — the board skill available to every thread: add, list, show, move cards; upload attachments first.
- `skills/pipeline-intake/SKILL.md` — intake: read the note and attachments, ask what this is, grill, file the issue, get the tier, label, hand off to planning; steps 2, 3, 5, and 7 report each stop for the user with `--needs-you`.

No symlinks anywhere under `skills/`.
