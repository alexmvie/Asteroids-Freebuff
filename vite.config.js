import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

// ---- Build identity (auto-resolved) -----------------------------------
// BRANCH + COMMIT are read from git ONCE at Vite config-load time
// (once per `npm run dev` / `npm run build`) and exposed via Vite's
// `define` plugin as `__BRANCH__` / `__COMMIT__`. Any source module
// can read either as a global identifier — Vite substitutes the
// literal value at parse time.
//
// Why this exists (instead of a committed constants file)
// --------------------------------------------------------
// The previous architecture baked the SHA into
// `src/version-constants.js` and used a `.githooks/post-commit`
// hook to amend the just-created commit so the file's content
// reflected its own SHA. That's a chicken-and-egg problem: baking
// the SHA into the committed file CHANGES the commit's content,
// which CHANGES its SHA, which means the file is always off-by-one
// from the SHA it displays. The marker-based recursion guard
// prevented an infinite amend loop, but the off-by-one remained —
// the chip showed yesterday's SHA, not today's.
//
// Resolution via Vite `define`:
//   - Dev mode: the values are baked into the dev server's
//     transform pipeline at start. HMR doesn't refresh them, but
//     a server restart does. Acceptable: branch / SHA changes are
//     infrequent, and the dev UX is still strictly better than the
//     baked-in approach (always accurate at start, never off-by-one).
//   - Prod mode: Vite inlines the literal strings into the bundle.
//
// Defensive fallback: if `git` is unavailable / the working copy
// isn't a git repo (e.g. building from a tarball), the values
// fall back to `'unknown'` rather than crashing the dev server.
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

const HEAD_BRANCH = safeExec('git rev-parse --abbrev-ref HEAD');
const HEAD_COMMIT = safeExec('git rev-parse --short HEAD');

export default defineConfig({
   root: '.',
   publicDir: 'public',
   server: {
      port: 5175,
      strictPort: false,
      open: true,
   },
   build: {
      outDir: 'dist',
      sourcemap: true,
      target: 'es2022',
   },
   // JSON.stringify is required because Vite's `define` is a literal
   // source-code substitution — without the quotes it'd emit an
   // unquoted identifier and fail to parse.
   define: {
      __BRANCH__: JSON.stringify(HEAD_BRANCH),
      __COMMIT__: JSON.stringify(HEAD_COMMIT),
   },
});
