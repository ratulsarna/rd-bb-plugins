#!/bin/sh
# Claude Code SessionStart hook: points a memory-on assistant's main chat at a fresh copy of its
# memory on startup, clear and compact. Silent for every other session. Stdout becomes context the
# agent sees before its next step.
# Read Claude's input before any exit, so its writer never meets a closed pipe.
input=$(cat)
[ -n "$BB_THREAD_ID" ] || exit 0
# A resumed session still holds its memory in context.
printf '%s' "$input" | grep -q '"source" *: *"resume"' && exit 0
home="${CLAUDE_PROJECT_DIR:-$PWD}"
dir="$home/nosync"
file="$dir/bb-memory-$BB_THREAD_ID.md"
if ! out=$("${BB_CLI:-bb}" assistants memory view --home "$home" 2>&1); then
  # Only a chat this hook has given memory before is known to need it; any other stays undisturbed.
  [ -f "$file" ] || exit 0
  echo "Your memory could not be loaded ($(printf '%s' "$out" | head -c 300)). $file is from an earlier session and may be stale. Tell the user before other work, and use \`bb assistants recall\` for anything from before this session."
  exit 0
fi
# Not a memory-on assistant's main chat in this home.
[ -n "$out" ] || exit 0
if ! { mkdir -p "$dir" && printf '%s\n' "$out" >"$file.tmp" && mv "$file.tmp" "$file"; }; then
  echo "Your memory could not be written to $file. Tell the user before other work."
  exit 0
fi
echo "Your memory is in $file. Read the whole file with the Read tool, in chunks if needed, before anything else."
