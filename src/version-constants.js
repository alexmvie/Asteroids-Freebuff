/**
 * src/version.js — single source of truth for the game's version +
 * branch metadata.
 *
 * Why this file exists (SSOT)
 * ---------------------------
 * The rest of the codebase follows a "constants split" pattern: tunable
 * literals live in dedicated `<topic>-constants.js` files alongside
 * their consumers (e.g. `src/entities/ship-constants.js` owns ship
 * physics, `src/scene/camera-constants.js` owns camera behavior,
 * `src/training/defaults.js` owns training tunables). The game
 * metadata (version label + branch name) is the same kind of tunable
 * — it's a build-time constant that two distinct consumers read
 * (the bottom-right HUD chip + the dev console banner) — and
 * therefore belongs in its own constants module rather than being
 * inlined in `src/main.js`.
 *
 * Consumers
 * ---------
 *   1. `src/main.js` renders the bottom-right version chip
 *      (`#game-version`) using `BRANCH` + `VERSION` here.
 *   2. `src/main.js` prints the dev-console banner stamping the
 *      same two values so DevTools and the corner chip agree.
 *
 * Update procedure
 * ----------------
 * Bump both VERSION and BRANCH here whenever a meaningful public
 * change ships:
 *   - VERSION: increment per the project's semver-ish convention
 *     (v0.MM.PP, with M bumped for behavior changes and P bumped
 *     for hotfixes on the same release).
 *   - BRANCH: lowercased branch name ("refine-coded-ai",
 *     "power-up-system", etc.). The display chip distinguishes
 *     branches without code changes -- a different branch renders
 *     a different label.
 *
 * NOTE: this file does NOT export a "commit" string. A hard-coded or
 * stale SHA leaves the chip disagreeing with itself (v0.17.3 hit
 * this exact bug twice). When a post-commit hook updates this file
 * from `git rev-parse --short HEAD`, that's the right place to add
 * it -- the chip render path will start including it, the constants
 * stay declarative, and the chip stays in sync with HEAD.
 */

const VERSION = 'v0.18.0';
const BRANCH = 'refine-coded-ai';

export { VERSION, BRANCH };
