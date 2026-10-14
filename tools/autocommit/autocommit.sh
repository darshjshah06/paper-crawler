#!/bin/bash
# Daily auto-commit: commits any pending changes in the repo with a short,
# casual message (one of 10, never the same as the last commit) and pushes.
# Does nothing if there are no changes. Scheduled by launchd (see install.sh).
# Safe to run by hand too.
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

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
