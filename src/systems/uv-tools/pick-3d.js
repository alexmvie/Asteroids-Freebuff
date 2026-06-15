import * as THREE from 'three';

/**
 * Create the 3D-picking tool.
 *
 * Owns:
 *   - the `THREE.Raycaster` + `THREE.Vector2` (NDC) state
 *   - the `meshToEntity` Map (rebuilt on every pick)
 *   - the internal `hoveredEntity` (the entity currently
 *     highlighted by the yellow emissive overlay)
 *   - the 3D-canvas event handlers: `onPointerMove`,
 *     `onLeave`, `onClick`
 *   - the public `pickAt3D(clientX, clientY)` API used by
 *     the edit screen to reuse the same picking logic
 *
 * The factory does NOT own the 3D canvas or the camera
 * itself — those are passed in as deps so the factory can
 * be instantiated at the top of the orchestrator (before
 * `mount()` runs) and still read the late-bound values.
 *
 * @param {object} _state - editor state (unused; accepted
 *   for consistency with the other tool factories)
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas - the 3D canvas
 *   (to attach event listeners + read `getBoundingClientRect`
 *   for the screen→NDC conversion)
 * @param {THREE.Camera} deps.camera - the scene camera (for
 *   `raycaster.setFromCamera`)
 * @param {() => Array<{ mesh: THREE.Group, dispose: Function }>} deps.getAsteroids
 * @param {() => boolean} deps.getEnabled - gate the handlers
 *   (no-op when the editor panel is hidden)
 * @param {(entity: object) => void} deps.onPickEntity - the
 *   click handler — typically the orchestrator's
 *   `selectAsteroid` so clicking an asteroid body loads its
 *   UV into the editor
 * @returns {{
 *   onPointerMove: (e: PointerEvent) => void,
 *   onLeave: () => void,
 *   onClick: (e: MouseEvent) => void,
 *   clearHover: () => void,
 *   pickAt3D: (clientX: number, clientY: number) => object | null,
 * }}
 */
export function createPick3DTool(_state, deps) {
  const { canvas, camera, getAsteroids, getEnabled, onPickEntity } = deps;

  if (!canvas) throw new Error('createPick3DTool: `canvas` is required');
  if (!camera) throw new Error('createPick3DTool: `camera` is required');
  if (typeof getAsteroids !== 'function') {
    throw new Error('createPick3DTool: `getAsteroids` must be a function');
  }
  if (typeof getEnabled !== 'function') {
    throw new Error('createPick3DTool: `getEnabled` must be a function');
  }
  if (typeof onPickEntity !== 'function') {
    throw new Error('createPick3DTool: `onPickEntity` must be a function');
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const meshToEntity = new Map();
  // The entity currently highlighted by the yellow emissive
  // overlay. Owned by this factory (private detail of the
  // hover-feedback logic). Cleared on `clearHover()` (which
  // is called from the orchestrator's `unmount` and
  // `setEnabled(false)`).
  let hoveredEntity = null;

  /**
   * Rebuild the mesh-to-entity Map from the current
   * asteroids. Called on every pick because asteroids can be
   * disposed/added dynamically (the streaming world in the
   * future, splitting asteroids on shot today). The cost is
   * O(asteroidCount) which is < 0.1ms for the demo field.
   */
  function rebuildMeshMap() {
    meshToEntity.clear();
    const asteroids = getAsteroids() || [];
    for (const a of asteroids) {
      if (!a || !a.mesh || !a.mesh.children) continue;
      const group = a.mesh;
      const body = group.children[0];
      if (!body) continue;
      // The asteroid body is either a `THREE.LOD` (noisy
      // icosphere, 3 detail levels) or a single `Mesh`
      // (capsule, jittered). In both cases we want the
      // actual rendered mesh(es) in the map.
      if (body.isLOD) {
        for (const level of body.levels) {
          if (level.object) meshToEntity.set(level.object, a);
        }
      } else {
        meshToEntity.set(body, a);
      }
    }
  }

  /**
   * Convert a client-space pointer coordinate to a
   * normalized device coordinate, then raycast against all
   * the asteroid meshes. Returns the first entity hit, or
   * null if nothing was hit.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @returns {object | null} the picked entity
   */
  function pickEntity(clientX, clientY) {
    rebuildMeshMap();
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const meshes = [...meshToEntity.keys()];
    if (meshes.length === 0) return null;
    const hits = raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      const entity = meshToEntity.get(hit.object);
      if (entity) return entity;
    }
    return null;
  }

  /**
   * Apply the yellow emissive hover overlay to the body's
   * mesh(es). Lazy-creates `material.emissive` if the
   * material doesn't have one yet (e.g. the standard
   * MeshStandardMaterial does, but the noise overlay might
   * be on a shared material).
   */
  function applyHover(entity) {
    if (!entity) return;
    const body = entity.mesh && entity.mesh.children && entity.mesh.children[0];
    if (!body) return;
    const meshes = body.isLOD ? body.levels.map((l) => l.object) : [body];
    for (const m of meshes) {
      if (m && m.material) {
        if (!m.material.emissive) m.material.emissive = new THREE.Color();
        m.material.emissive.setHex(0xffaa00);
        m.material.emissiveIntensity = 0.6;
      }
    }
  }

  /**
   * Remove the yellow emissive hover overlay from the
   * currently-hovered entity, then clear the
   * `hoveredEntity` reference. No-op if nothing is
   * hovered. Called on pointer-leave, on disable, and on
   * unmount.
   */
  function clearHover() {
    if (!hoveredEntity) return;
    const body = hoveredEntity.mesh && hoveredEntity.mesh.children && hoveredEntity.mesh.children[0];
    if (body) {
      const meshes = body.isLOD ? body.levels.map((l) => l.object) : [body];
      for (const m of meshes) {
        if (m && m.material && m.material.emissive) {
          m.material.emissive.setHex(0x000000);
          m.material.emissiveIntensity = 0;
        }
      }
    }
    hoveredEntity = null;
  }

  /**
   * 3D-canvas pointermove handler. Updates the hover
   * overlay (clears the old entity's emissive, applies to
   * the new one if it changed) and the cursor style. No-op
   * when the editor panel is hidden.
   */
  function onPointerMove(e) {
    if (!getEnabled()) return;
    const entity = pickEntity(e.clientX, e.clientY);
    if (entity !== hoveredEntity) {
      clearHover();
      hoveredEntity = entity;
      applyHover(entity);
    }
    canvas.style.cursor = entity ? 'pointer' : 'default';
  }

  /**
   * 3D-canvas pointerleave handler. Clears the hover
   * overlay and resets the cursor. No-op when disabled.
   */
  function onLeave() {
    if (!getEnabled()) return;
    clearHover();
    canvas.style.cursor = 'default';
  }

  /**
   * 3D-canvas click handler. Picks the entity under the
   * click point and forwards it to `onPickEntity` (the
   * orchestrator's `selectAsteroid`). No-op when disabled.
   */
  function onClick(e) {
    if (!getEnabled()) return;
    const entity = pickEntity(e.clientX, e.clientY);
    if (entity) onPickEntity(entity);
  }

  /**
   * Public pick API — exposed for the edit screen so it
   * can use the same picking logic (3D mini viewport in
   * the edit object screen). Returns the entity under the
   * given client-space coordinate, or null.
   *
   * @param {number} clientX
   * @param {number} clientY
   * @returns {object | null}
   */
  function pickAt3D(clientX, clientY) {
    return pickEntity(clientX, clientY);
  }

  return {
    onPointerMove,
    onLeave,
    onClick,
    clearHover,
    pickAt3D,
  };
}
