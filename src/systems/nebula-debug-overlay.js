import * as THREE from 'three';
import { BUBBLE_RADIUS_CHUNKS, CHUNK_SIZE, NEBULA_RENDER_THRESHOLD } from '../world/constants.js';

/**
 * Debug overlay for the `NEBULA_RENDER_THRESHOLD` constant.
 *
 * For every chunk in the active streaming bubble (centered on the
 * ship's current chunk), draws a small colored quad 5 units above
 * the play plane:
 *   - **green**  = `chunkHasNebula(id) === true`  (density > threshold)
 *   - **red**    = `chunkHasNebula(id) === false` (density ≤ threshold)
 *
 * Toggle with `window.NEBULA_DEBUG = true` (default `false`; the
 * constant is `NEBULA_DEBUG_DEFAULT` in `src/world/constants.js`).
 * The overlay is purely diagnostic — it's a quick way to verify the
 * threshold is having the intended effect in the world, and to
 * tune the threshold value visually without rebuilding the data
 * model.
 *
 * Implementation notes:
 *   - One big `THREE.InstancedMesh` of a unit quad (2 triangles),
 *     repositioned per frame via `setMatrixAt`. This is much
 *     cheaper than `BUBBLE_RADIUS_CHUNKS^2` individual meshes
 *     (49 chunks → 49 instances in a single draw call).
 *   - Per-instance color via `setColorAt` — the standard material
 *     reads the instance color when `vertexColors: true` and the
 *     shader is patched. We use a `MeshBasicMaterial` with a
 *     vertexColors-shader injection via `onBeforeCompile` to read
 *     the per-instance color.
 *   - The mesh is hidden by default (`visible = false`); the
 *     scene's `setNebulaDebug(enabled)` toggles it. The render
 *     loop doesn't have to know about the overlay — it just
 *     calls `update(shipPos)` each frame.
 *   - The marker Y is +5 units above the play plane so the chase
 *     camera sees it (the camera is at +7 above the plane).
 *
 * @returns {{
 *   mesh: THREE.Mesh,
 *   setEnabled: (enabled: boolean) => void,
 *   isEnabled: () => boolean,
 *   update: (shipWorldPos: {x:number,y:number,z:number}, densityAt: (cx:number,cz:number)=>number) => void,
 *   dispose: () => void,
 * }}
 */
export function createNebulaDebugOverlay() {
  const { count, sideLen } = bubbleInstanceCount();
  const quadGeom = new THREE.PlaneGeometry(sideLen, sideLen);

  // Use a basic material with per-instance color. The InstancedMesh
  // automatically supplies `instanceColor` as a per-instance attribute
  // when `instanceColor` is non-null after `setColorAt(...)`. We
  // declare a `MeshBasicMaterial` with `vertexColors: true` and
  // inject a one-liner that reads `instanceColor` in the fragment
  // shader. This is the canonical Three.js pattern (used by the
  // `TransformControls` helper, for example).
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
    vertexColors: false,
  });
  material.onBeforeCompile = (shader) => {
    // Make `instanceColor` available in the fragment shader.
    // The standard `<color_pars_fragment>` chunk declares the
    // `vColor` varying; we just need to seed `vColor` from the
    // instance attribute in the vertex stage.
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 instanceColor;\nvarying vec3 vInstanceColor;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvInstanceColor = instanceColor;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vInstanceColor;',
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb *= vInstanceColor;',
      );
  };

  const mesh = new THREE.InstancedMesh(quadGeom, material, count);
  mesh.name = 'nebula-debug-overlay';
  mesh.renderOrder = 0; // draw in the normal opaque pass
  mesh.frustumCulled = false; // the bubble is always near the ship

  // Seed the geometry to a zero matrix (will be overwritten in update()).
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  const cOn = new THREE.Color(0x4ade80); // green-400
  const cOff = new THREE.Color(0xf87171); // red-400
  for (let i = 0; i < count; i++) {
    m.makeTranslation(0, -10000, 0); // park below the play plane initially
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, cOff);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  let enabled = false;
  mesh.visible = false;

  function setEnabled(value) {
    enabled = !!value;
    mesh.visible = enabled;
  }
  function isEnabled() {
    return enabled;
  }

  /**
   * Re-position the per-chunk markers around the ship and color them
   * based on `densityAt(cx, cz)`. Idempotent and cheap (49 matrix
   * writes + 49 color writes per call, no allocations after the
   * first call).
   *
   * @param {{x:number,y:number,z:number}} shipPos
   * @param {(cx:number, cz:number) => number} densityAtFn chunk-center density
   */
  function update(shipPos, densityAtFn) {
    if (!enabled) return;
    const shipCx = Math.floor(shipPos.x / CHUNK_SIZE);
    const shipCz = Math.floor(shipPos.z / CHUNK_SIZE);
    let i = 0;
    for (let dx = -BUBBLE_RADIUS_CHUNKS; dx <= BUBBLE_RADIUS_CHUNKS; dx++) {
      for (let dz = -BUBBLE_RADIUS_CHUNKS; dz <= BUBBLE_RADIUS_CHUNKS; dz++) {
        const cx = shipCx + dx;
        const cz = shipCz + dz;
        const d = densityAtFn(cx, cz);
        const isOn = d > NEBULA_RENDER_THRESHOLD;
        const wx = (cx + 0.5) * CHUNK_SIZE;
        const wz = (cz + 0.5) * CHUNK_SIZE;
        m.makeTranslation(wx, PLAY_PLANE_Y + 5, wz);
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, isOn ? cOn : cOff);
        i++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  function dispose() {
    quadGeom.dispose();
    material.dispose();
  }

  return { mesh, setEnabled, isEnabled, update, dispose };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const PLAY_PLANE_Y = 0; // matches src/world/constants.js

/**
 * Total number of instances = `(2 * BUBBLE_RADIUS_CHUNKS + 1)^2`.
 * Side length is `CHUNK_SIZE / 4` so 4 markers fit across a chunk
 * (so 2x2 chunks of markers tile the bubble visually).
 */
function bubbleInstanceCount() {
  const n = 2 * BUBBLE_RADIUS_CHUNKS + 1;
  return { count: n * n, sideLen: CHUNK_SIZE / 4 };
}
