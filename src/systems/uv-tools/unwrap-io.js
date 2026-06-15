/**
 * Unwrap I/O tool factory for the UV editor.
 *
 * Owns the `saveUnwrap()` and `loadUnwrap()` tools —
 * download the current UV attribute + seam set as a JSON
 * file, or load a previously-saved unwrap back into the
 * editor.
 *
 * @fileoverview Tool factory for `src/systems/uv-unwrap-viewer.js`.
 * Extracted in 2026 to enable the per-tool split.
 *
 * @example
 *   const io = createUnwrapIO(state, deps);
 *   io.saveUnwrap();
 *   io.loadUnwrap();
 */

import { UV_EDITOR_CONFIG } from './config.js';
import { getAsteroidType } from '../../entities/asteroid.js';

/**
 * Create the unwrap I/O tool.
 *
 * @param {object} state - editor state from createEditorState()
 * @param {object} deps - dependencies
 * @param {() => THREE.BufferGeometry | null} deps.getBodyGeometry
 * @param {() => object | null} deps.getSelectedEntity
 * @param {(entity: object) => string} deps.describeEntity
 * @param {() => void} deps.scheduleDraw
 * @param {() => void} deps.onAfterApply - called after UVs
 *   are written (e.g., to recompute the layout)
 * @returns {object} { saveUnwrap, loadUnwrap }
 */
export function createUnwrapIO(state, deps) {
  const {
    getBodyGeometry,
    getSelectedEntity,
    describeEntity,
    scheduleDraw,
    onAfterApply,
  } = deps;

  /**
   * Download the current UV attribute + seam set as a JSON
   * file. The file is named after the selected entity's
   * spec id (or "uv.json" if the entity has no id).
   */
  function saveUnwrap() {
    const selectedEntity = getSelectedEntity();
    if (!selectedEntity) return;
    const geom = getBodyGeometry();
    if (!geom) return;
    const uvArr = Array.from(geom.attributes.uv.array);
    const payload = {
      type: 'uv-unwrap',
      version: 1,
      object: describeEntity(selectedEntity),
      uvs: uvArr,
      seams: [...state.getSeamKeys()],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedEntity.spec.id || 'uv'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), UV_EDITOR_CONFIG.fileDownload.revokeTimeoutMs);
  }

  /**
   * Save the current UV attribute + seam set as a per-TYPE
   * template (covers icosphere OR capsule — whichever this
   * asteroid is). Two side effects:
   *
   *   1. localStorage write to `asteroid-uv-template-${type}`
   *      so every new asteroid of this type that the world
   *      streams in (and every existing one on next reload)
   *      automatically adopts this UV layout. The write is
   *      best-effort (try/catch around quota / privacy-mode
   *      errors).
   *   2. Downloads a distributable JSON file named
   *      `asteroid-${type}-uv.json` that the user can share,
   *      drop into a presets folder, or commit to source.
   *      The file format is identical to the localStorage
   *      payload, so the same JSON is the canonical
   *      "distributable template" — re-apply by re-saving
   *      it to localStorage via the LOAD button (a future
   *      pass could add a LOAD TEMPLATE button for one-click
   *      adoption from a file).
   *
   * The user said "be sure save works so i can adjust uv
   * mapping, save it and its saved to a file which gets
   * distributed later" — this function is the answer. The
   * per-type save also means the user can unwrap ONE
   * icosphere, save the template, and every other icosphere
   * in the game uses the same UV layout (the user can
   * override per-instance by editing the asteroid after
   * opening it in the editor — the in-memory `seamKeys` set
   * takes precedence over the template).
   */
  function saveTemplate() {
    const selectedEntity = getSelectedEntity();
    if (!selectedEntity || !selectedEntity.spec) return;
    const geom = getBodyGeometry();
    if (!geom) return;
    const type = getAsteroidType(selectedEntity.spec);
    const uvArr = Array.from(geom.attributes.uv.array);
    const payload = {
      type: 'uv-template',
      version: 1,
      asteroidType: type,
      uvs: uvArr,
      seams: [...state.getSeamKeys()],
    };
    // localStorage: every new asteroid of this type adopts the
    // template at creation time (see applyUvTemplate in
    // src/entities/asteroid.js). Best-effort write.
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`asteroid-uv-template-${type}`, JSON.stringify(payload));
      } catch (_) { /* quota / privacy mode — file download still works */ }
    }
    // Distributable file: same payload as localStorage, so the
    // file is the canonical portable template (drop into a
    // presets folder, commit, share, etc.).
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asteroid-${type}-uv.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), UV_EDITOR_CONFIG.fileDownload.revokeTimeoutMs);
  }

  /**
   * Load a previously-saved unwrap from a JSON file. The
   * file is selected via a hidden <input type="file">
   * element. The UV attribute is overwritten, the seam
   * set is replaced, and the layout is recomputed.
   */
  function loadUnwrap() {
    if (!getSelectedEntity()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          if (data.type !== 'uv-unwrap') throw new Error('Not a UV unwrap file');
          const geom = getBodyGeometry();
          if (!geom) return;
          const uvAttr = geom.attributes.uv;
          for (let i = 0; i < Math.min(uvAttr.count, data.uvs.length / 2); i++) {
            uvAttr.array[i * 2 + 0] = data.uvs[i * 2 + 0];
            uvAttr.array[i * 2 + 1] = data.uvs[i * 2 + 1];
          }
          uvAttr.needsUpdate = true;
          state.setSeamKeys(new Set(data.seams || []));
          if (onAfterApply) onAfterApply();
          scheduleDraw();
        } catch (err) {
          console.warn('Failed to load unwrap:', err);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  return { saveUnwrap, loadUnwrap, saveTemplate };
}
