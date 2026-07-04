#!/usr/bin/env bash
# Wire .githooks/ to git (one-time per clone, project-local).
#
# Running this once after a fresh clone makes every `git commit` on
# the current branch auto-push to origin/<branch> via
# .githooks/post-commit. The user never has to type `git push` again.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)" || { echo "ERROR: not in a git repo"; exit 1; }
[ -d .githooks ] || { echo "ERROR: .githooks/ missing in $(pwd)"; exit 1; }

git config core.hooksPath .githooks

BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "core.hooksPath = .githooks  (project-local; applies to this clone only)"
echo "On your next 'git commit' on branch '$BRANCH', .githooks/post-commit will"
echo "auto-push the result to origin/$BRANCH."
