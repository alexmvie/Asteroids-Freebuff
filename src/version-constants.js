/**
 * src/version-constants.js — single source of truth for the game's version +
 * branch + commit metadata.
 *
 * Why this file exists (SSOT)
 * ---------------------------
 * The rest of the codebase follows a "constants split" pattern: tunable
 * literals live in dedicated `<topic>-constants.js` files alongside
 * their consumers (e.g. `src/entities/ship-constants.js` owns ship
 * physics, `src/scene/camera-constants.js` owns camera behavior,
 * `src/training/defaults.js` owns training tunables). The game
 * metadata (version label + branch name + commit SHA) is the same kind
 * of tunable — it's a build-time constant that the bottom-right HUD
 * chip + dev-console banner read — and therefore belongs in its own
 * constants module rather than being inlined in `src/main.js`.
 *
 * Consumers
 * ---------
 *   1. `src/main.js` renders the bottom-right version chip
 *      (`#game-version`) using `BRANCH` + `VERSION` + `COMMIT` here.
 *   2. `src/main.js` prints the dev-console banner stamping the
 *      same three values so DevTools and the corner chip agree.
 *
 * Update procedure
 * ----------------
 * - VERSION: increment per the project's semver-ish convention
 *   (v0.MM.PP, with M bumped for behavior changes and P bumped for
 *   hotfixes on the same release). Manual edits only — never
 *   auto-bumped because VERSION reflects SEMANTIC version, not
 *   commit count.
 * - BRANCH: lowercased branch name ("refine-coded-ai",
 *   "power-up-system", etc.). Manual edits only — distinguishes
 *   branches visually without code changes elsewhere.
 * - COMMIT: populated automatically by `.githooks/post-commit`
 *   after each `git commit`. The hook reads `git rev-parse --short
 *   HEAD` and writes it back into this file, then `git commit
 *   --amend --no-verify`s so the file's content reflects its own
 *   SHA. The chip stays in sync with HEAD because every commit
 *   captures a version-constants.js whose COMMIT line == its own
 *   hash. The bootstrap placeholder `'\'<unset>\'` (this string)
 *   is replaced on the FIRST commit that fires the hook; until
 *   then the chip's commit span reads literally `'<unset>'`.
 *
 * Install the hook (one-time, project-local):
 *
 *     git config core.hooksPath .githooks
 *
 * The hook is plain Python (`#!/usr/bin/env python3`); works on
 * macOS + Linux + WSL out of the box. It is idempotent: commits
 * whose COMMIT line already equals HEAD SHA exit without
 * amending. It uses `--no-verify` on the amend so neither the
 * pre-commit nor post-commit hook re-fires for the amend commit
 * (no infinite amend cycle).
 */

const VERSION = 'v0.18.0';
const BRANCH = 'refine-coded-ai';
// Populated automatically by .githooks/post-commit after each commit.
// The string `'\'<unset>\'` is the bootstrap placeholder shown when
// the hook has not yet fired for this working copy (e.g. fresh
// clone whose first commit was created WITHOUT the hook installed).
const COMMIT = "c7f0764";

export { VERSION, BRANCH, COMMIT };
