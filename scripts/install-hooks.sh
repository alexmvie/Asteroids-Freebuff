#!/usr/bin/env bash
# scripts/install-hooks.sh -- wire .githooks/ to git (one-time per clone).
#
# Project-local. Writes to .git/config (NOT ~/.gitconfig), so it applies
# only to this clone. Re-running is harmless (git config overwrites).
# The .githooks/post-commit hook keeps src/version-constants.js's
# COMMIT line in sync with HEAD so the bottom-right game-version chip
# stays honest about which build you are watching. See AGENTS.md +
# SPEC.md for the full hook contract.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)" || { echo "ERROR: not in a git repo"; exit 1; }
[ -d .githooks ] || { echo "ERROR: .githooks/ missing in $(pwd)"; exit 1; }

git config core.hooksPath .githooks
echo "core.hooksPath = .githooks  (project-local; applies only to this clone)"
echo "Hook fires on your next 'git commit'."
