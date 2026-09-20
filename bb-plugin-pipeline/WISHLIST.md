# Pipeline wishlist

High-value improvements, in priority order:

1. **Pause, resume, and cancel an entire task.** Control its intake, lead, workers, and queued messages together while preserving the work. Keep capacity occupied until running work actually stops. Allow saving a task without immediately starting intake.

2. **Queue visibility and “Run next.”** Show which tasks occupy the two slots for a project and machine, and why another task is waiting. Let the user choose the next task when capacity opens, so an urgent fix can move ahead of ordinary work.

3. **GitHub status synchronization.** Show actual CI failures, review status, and merge status on the card. Move a task to Done when its PR merges, keeping the board consistent with GitHub.

4. **Task dependencies.** Support “start B after A’s PR merges.” Begin dependent work with the prerequisite changes available, so related tasks do not build against an outdated base.

5. **One “Needs me” view across projects.** List outstanding questions, approvals, failures, and merge decisions, each opening the relevant thread or PR. Keep unresolved decisions visible after their notifications have been dismissed.
