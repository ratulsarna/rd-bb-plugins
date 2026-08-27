# Taskwall

Taskwall keeps the dated task ledger visible in a BB panel.

It reads `/home/ratul/assistants/sam/tasks/ledger.json` on the BB server and refreshes every 30 seconds. Dates use the Asia/Kolkata calendar. The panel shows overdue tasks, tasks due today, the next seven days, and tasks finished today.

Undated tasks stay out of this first version. The ledger remains read-only.

## Install

```sh
bb plugin install . --yes
```

Open Taskwall from the BB sidebar.
