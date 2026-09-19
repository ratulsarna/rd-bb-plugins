# VENDOR

The `pipeline-*` skills are forks of the nexus skills. Upstream: `/home/ratul/scratchpad-mbp16-m3max/nexus/` at git revision `8a2273de13d3cf820d694ffcb704c964eae407b5` (`8a2273d`). The upstream checkout was not modified.

## Copied files

| Upstream | Here | Changes |
|---|---|---|
| `nexus-README.md` | `skills/pipeline-plan/references/pipeline-README.md` | renames; Board section added (below) |
| `nexus-plan/SKILL.md` | `skills/pipeline-plan/SKILL.md` | renames; 4 report lines added (below) |
| `nexus-plan/templates/oracle.md` | `skills/pipeline-plan/templates/oracle.md` | none — byte-for-byte |
| `nexus-implement/SKILL.md` | `skills/pipeline-implement/SKILL.md` | renames; 5 report lines added (below) |
| `nexus-implement/templates/developer.md` | `skills/pipeline-implement/templates/developer.md` | none — byte-for-byte |
| `nexus-implement/templates/oracle.md` | `skills/pipeline-implement/templates/oracle.md` | none — byte-for-byte |
| `nexus-implement/templates/qa.md` | `skills/pipeline-implement/templates/qa.md` | none — byte-for-byte |
| `nexus-close-out/SKILL.md` | `skills/pipeline-close-out/SKILL.md` | renames; 2 report lines added (below) |
| `nexus-debug/SKILL.md` | `skills/pipeline-debug/SKILL.md` | renames; 1 report line added (below) |
| `nexus-debug/templates/debugger.md` | `skills/pipeline-debug/templates/debugger.md` | none — byte-for-byte |

Not copied: `agents/openai.yaml` in each upstream skill directory (no counterpart in this plugin).

## Renames (every occurrence)

- Directories `nexus-plan`, `nexus-implement`, `nexus-close-out`, `nexus-debug` → `pipeline-plan`, `pipeline-implement`, `pipeline-close-out`, `pipeline-debug`.
- Frontmatter `name:` in each copied `SKILL.md` → the new directory name.
- Headings `# Nexus` and `# Nexus: Plan / Implement / Close-out / Debug` → `# Pipeline` and `# Pipeline: …`; the two sentences opening the README fork ("Nexus turns…", "Nexus starts…") → "Pipeline …".
- Skill cross-references: `nexus-plan` → `pipeline-plan`, `nexus-implement` → `pipeline-implement`, `nexus-close-out` → `pipeline-close-out`, `nexus-debug` → `pipeline-debug` — in the README fork's flow lines, in each skill's exit line, and in the close-out review-gates reference.
- README references: `../nexus-README.md` in plan → `references/pipeline-README.md`; `../nexus-README.md` in debug → `../pipeline-plan/references/pipeline-README.md` (the README moved inside the plan skill).

## Additions: board report lines

One line per site, in the skill the moment belongs to; the full table appears once in the README fork. Column-move lines carry `--working`; `--needs-you` lines state it.

- `pipeline-README.md`: new "## Board" section at the end — the report table (all 13 rows, including the catch-all "any" row) with the `--working` default in the lead-in, plus the note that small and trivial tiers produce no walkthrough reports.
- `pipeline-plan/SKILL.md`, 4 lines:
  - top of "Understand, with the user": `` `bb pipeline report --column planning --working` ``
  - end of "Understand, with the user" (questions in understand or grill): `` `bb pipeline report --needs-you "<question in one line>"` ``
  - top of "Walkthrough — the user's review" (Shape done, before the first step): `` `bb pipeline report --column plan_ready --needs-you "plan ready; walkthrough step 1 of M"` ``
  - end of "Walkthrough — the user's review" (each later step): `` `bb pipeline report --needs-you "walkthrough step N of M"` ``
- `pipeline-debug/SKILL.md`, 1 line at the end of process step 3 (RCA done, before any fix): `` `bb pipeline report --needs-you "root cause found; tier the fix"` ``
- `pipeline-implement/SKILL.md`, 5 lines:
  - top of "Dispatch" (start): `` `bb pipeline report --column implementing --working` ``
  - end of gate 1 (review passes start): `` `bb pipeline report --column reviewing --working` ``
  - end of gate 4: ``When findings send it back to the worker: `bb pipeline report --column implementing --working` ``
  - end of gate 5 (QA starts, then QA sends it back): `` `bb pipeline report --column qa --working` `` and ``When QA sends it back: `bb pipeline report --column implementing --working` ``
- `pipeline-close-out/SKILL.md`, 2 lines:
  - in step 2, after the draft-PR paragraph: `` `bb pipeline report --column pr --pr <url> --working` ``
  - end of step 3 (review loop clean): `` `bb pipeline report --column pr_ready --needs-you "PR ready to merge"` ``

No copied sentence was edited beyond the renames listed above; report lines were inserted only at paragraph and list-item boundaries.

## New files, no upstream counterpart

- `skills/pipeline/SKILL.md` — the board skill every thread gets: add, list, show, move cards; upload attachments first.
- `skills/pipeline-intake/SKILL.md` — intake: read the note and attachments, ask what this is, grill, file the issue, get the tier, label, hand off to planning.

No symlinks anywhere under `skills/`.
