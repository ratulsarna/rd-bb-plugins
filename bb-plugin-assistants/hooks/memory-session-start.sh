#!/bin/sh
# Claude Code SessionStart hook, for every source (startup, resume, clear, compact): points a
# memory-on assistant's main chat at a fresh copy of its memory. Silent for every other session.
# Stdout becomes context the agent sees before its next step.
[ -n "$BB_THREAD_ID" ] || exit 0
dir="${CLAUDE_PROJECT_DIR:-$PWD}/nosync"
file="$dir/bb-memory-$BB_THREAD_ID.md"
err=$(mktemp) || exit 0
trap 'rm -f "$err"' EXIT
if ! out=$("${BB_CLI:-bb}" assistants memory view 2>"$err"); then
  echo "Your memory could not be loaded ($(head -c 300 "$err")). Tell the user before other work, and use \`bb assistants recall\` for anything from before this session."
  exit 0
fi
# Not a memory-on assistant's main chat.
[ -n "$out" ] || exit 0
if ! { mkdir -p "$dir" && printf '%s\n' "$out" >"$file.tmp" && mv "$file.tmp" "$file"; }; then
  echo "Your memory could not be written to $file. Tell the user before other work."
  exit 0
fi
echo "Your memory is in $file. Read the whole file with the Read tool, in chunks if needed, before anything else."
