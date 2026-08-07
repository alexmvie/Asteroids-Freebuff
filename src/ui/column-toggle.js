/**
 * Column toggle — shared helper for the collapsible debug columns.
 *
 * Used by:
 *   - `#debug-column` (left side: AI debug overlay + diagnostic HUD).
 *   - `#ai-tuners-column` (right side: AI Live Tuners panel).
 *
 * Behavior:
 *   - Click the toggle button to flip the `--collapsed` modifier on the
 *     column wrapper, which hides the body via `display: none`. The
 *     toggle button itself stays visible — the user said "collapsible to
 *     a small square" so the button IS the visible square in the
 *     collapsed state.
 *   - State persists in `localStorage` under a per-column key so the
 *     user's preference survives reloads. Default is expanded.
 *   - `aria-expanded` on the button is updated on every toggle so AT
 *     announces the current state. Tooltip text is updated from the
 *     `expandTitle` / `collapseTitle` options.
 *   - try/catch around `localStorage` makes the helper safe under SSR
 *     or privacy mode (matches the project-wide pattern for
 *     `AI_TUNING_ENABLED` and similar flags).
 *
 * The two columns are pure layout wrappers — they don't share any
 * runtime state, so each instance of `createColumnToggle` is fully
 * independent. The wrapper modules (`#debug-hud`, `#ai-debug-overlay`,
 * `#ai-tuners`) are untouched: their data-attrs + mount() calls
 * work unchanged.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.column — wrapper element that gets the --collapsed class.
 * @param {HTMLButtonElement} opts.toggleBtn — the click target.
 * @param {string} opts.storageKey — localStorage key (unique per column).
 * @param {string} opts.collapsedClass — CSS class toggled on the column.
 * @param {string} [opts.expandTitle='Expand panel'] — button title when collapsed.
 * @param {string} [opts.collapseTitle='Collapse panel'] — button title when expanded.
 * @returns {{ getCollapsed: () => boolean, setCollapsed: (collapsed: boolean) => void }}
 *   `getCollapsed` reads the current state. `setCollapsed` writes it.
 */
export function createColumnToggle({
  column,
  toggleBtn,
  storageKey,
  collapsedClass,
  expandTitle = 'Expand panel',
  collapseTitle = 'Collapse panel',
}) {
  if (!column || !toggleBtn) {
    return {
      getCollapsed: () => false,
      setCollapsed: () => {},
    };
  }

  const setCollapsed = (collapsed) => {
    column.classList.toggle(collapsedClass, collapsed);
    // Chevron points down when expanded (suggesting "click to collapse")
    // and right when collapsed (suggesting "click to expand").
    toggleBtn.textContent = collapsed ? '▶' : '▼';
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    toggleBtn.title = collapsed ? expandTitle : collapseTitle;
    try {
      localStorage.setItem(storageKey, collapsed ? '1' : '0');
    } catch {
      /* SSR / privacy mode — fall back to in-memory only */
    }
  };

  // Seed initial state from localStorage. Default: expanded.
  let initialCollapsed = false;
  try {
    initialCollapsed = localStorage.getItem(storageKey) === '1';
  } catch {
    /* ignore */
  }
  setCollapsed(initialCollapsed);

  toggleBtn.addEventListener('click', () => {
    setCollapsed(!column.classList.contains(collapsedClass));
  });

  return {
    getCollapsed: () => column.classList.contains(collapsedClass),
    setCollapsed,
  };
}
