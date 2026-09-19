Keep delivery work visible from the first rough note through a merge-ready pull request.

## One card, two focused threads

Adding a card starts an intake thread that sharpens the request, files the GitHub issue, and records its tier. Planning starts a separate lead thread in a managed worktree. Both threads receive the card's attachments, while the board always opens the thread that currently owns the work.

## A board that explains attention

The ten columns cover backlog, intake, planning, implementation, review, QA, and pull-request handoff. A card can show the lead's explicit reason for stopping, a structured open question, a failed thread, or a launch error with retry. Completed cards stay hidden until you choose to show them.

Workflow skills report phase changes with `bb pipeline report`. If a lead goes idle without reporting, the optional Jev integration classifies whether the user is needed. Missing credentials or an uncertain answer remain visible as *idle, unchecked*.

## Available everywhere

Use the Pipeline page for a visual board or run `bb pipeline` from any BB thread. The CLI can add, list, inspect, move, retry, report, and remove cards, with JSON output for automation.

Pipeline stores its cards and history in BB's plugin database. Attachments use BB's project attachment store, and the target machine, provider, model, reasoning level, and permission mode remain configurable.
