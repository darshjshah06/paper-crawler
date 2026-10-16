#!/bin/bash
# Auto-commit every 3 days: commits any pending changes in the repo with a
# short, casual message (one of 10, never the same as the last commit) and
# pushes. Does nothing if there are no changes. launchd wakes it daily (see
# install.sh) and it skips until 3 days have passed since its last run.
# Pass --force to run regardless. Safe to run by hand too.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# launchd can't schedule "every 3 days", so gate on a timestamp kept in .git.
# The hour of slack keeps a slightly-early wake from slipping a whole day.
EVERY=$((3 * 86400 - 3600))
STAMP="$REPO/.git/autocommit-last-run"
NOW="$(date +%s)"
if [ "${1:-}" != "--force" ] && [ -f "$STAMP" ] && [ $((NOW - $(cat "$STAMP"))) -lt "$EVERY" ]; then
  echo "$(date): not due yet"
  exit 0
fi
echo "$NOW" > "$STAMP"

MESSAGES=(
  "small tweaks"
  "cleaning things up"
  "minor fixes"
  "little improvements here and there"
  "tidying up"
  "quick update"
  "some polish"
  "a few small changes"
  "work in progress"
  "updating a couple things"
)

git add -A   # .gitignore keeps .env, cache/ and papers/ out
if git diff --cached --quiet; then
  echo "$(date): nothing to commit"
  exit 0
fi

# Pick a random message that differs from the previous commit's.
LAST="$(git log -1 --pretty=%s 2>/dev/null)"
MSG="$LAST"
while [ "$MSG" = "$LAST" ]; do
  MSG="${MESSAGES[$((RANDOM % ${#MESSAGES[@]}))]}"
done

git commit -q -m "$MSG" || exit 1
git push -q origin HEAD 2>&1 || echo "$(date): push failed (offline?) - will go out with the next run"
echo "$(date): committed \"$MSG\""
