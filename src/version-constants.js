/**
 * src/version-constants.js — single source of truth for the game's
 * MANUAL version constant. Only the SEMANTIC version lives here; the
 * other two build-identity values (BRANCH + COMMIT) are auto-resolved.
 *
 * Why this file exists (SSOT)
 * ---------------------------
 * The bottom-right HUD chip + dev-console banner read three
 * build-identity values: BRANCH + VERSION + COMMIT. Only VERSION is
 * manual; the others are read directly from git at Vite config-load
 * time (see `vite.config.js`) and exposed via Vite's `define` plugin
 * as `__BRANCH__` + `__COMMIT__` global identifiers. They are not
 * committed here because doing so would create a chicken-and-egg:
 * baking the SHA into the committed file changes the commit's
 * content, which changes its SHA, which means the file is always
 * off-by-one from the SHA it displays.
 *
 * Consumers
 * ---------
 *   - `src/main.js` reads VERSION from this module + reads
 *     `__BRANCH__` + `__COMMIT__` from Vite's define substitution.
 *   - The dev-console banner in `src/main.js` stamps all three
 *     values so DevTools and the corner chip agree.
 *
 * Update procedure
 * ----------------
 * - VERSION: bump per the project's semver-ish convention
 *   (v0.MM.PP, with M bumped for behavior changes and P bumped for
 *   hotfixes on the same release). Manual edits only — VERSION
 *   is SEMANTIC, not derived.
 * - BRANCH + COMMIT: auto-resolved from git at Vite config-load.
 *   No edits needed; no amend-chain, no off-by-one.
 */
const VERSION = 'v0.58.0';

export { VERSION };
