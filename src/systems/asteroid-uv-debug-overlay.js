import * as THREE from 'three';
import { Capsule } from '../geometry/capsule.js';

/**
 * Asteroid UV debug overlay — a per-asteroid wireframe grid that
 * visualizes how the geometry's `uv` attribute maps to the surface.
 * One quad per 0.1×0.1 UV cell (so 100 cells in a 10×10 grid),
 * colored by region (rainbow by cell index, white at the cell
 * borders). Lets the dev / artist see the unwrap live in the
 * browser and tune `CAPSULE_UV_PLANE` ('xy' vs 'xz' vs 'yz')
 * without rebuilding.
 *
 * Toggle with `window.ASTEROID_UV_DEBUG = true` in the browser
 * devtools. Toggle the plane with
 * `window.ASTEROID_UV_PLANE = 'xy' | 'xz' | 'yz'`.
 *
 * Implementation notes:
 *   - The overlay shares the body's `BufferGeometry` (so no extra
 *     memory per asteroid) and adds a child `THREE.Mesh` with a
 *     custom `ShaderMaterial` that draws the UV grid. The child
 *     inherits the body's transform, so it follows rotation /
 *     position automatically.
 *   - The shader is shared across all asteroids (one material,
 *     many meshes — the same pattern as the nebula debug overlay).
 *   - `polygonOffset` is enabled on the material so the grid
 *     doesn't z-fight the body (the grid mesh shares the same
 *     geometry, so the fragments are at the same depth).
 *   - `setCapsulePlane(plane)` iterates over all attached
 *     CAPSULE-kind bodies and calls `computePlanarUVs(plane)` on
 *     their geometry. The `setNeedsUpdate` flag on the uv
 *     attribute signals Three.js to re-upload the buffer to the
 *     GPU on the next frame. (Icosphere bodies are skipped —
 *     their UVs come from the underlying IcosahedronGeometry and
 *     aren't recomputable here.)
 *   - Initial state is **disabled** (visible: false on every
 *     attached mesh). The first `setEnabled(true)` call flips
 *     them all on.
 *
 * Public API:
 *   - `setEnabled(boolean)`      show / hide the grid
 *   - `isEnabled()`              current visibility
 *   - `setCapsulePlane(string)`  'xy' | 'xz' | 'yz' — recomputes
 *                                the planar UVs on every attached
 *                                capsule body
 *   - `getCapsulePlane()`        current capsule plane
 *   - `attach(geometry, kind)`   attach a debug mesh for the given
 *                                geometry. `kind` is 'icosphere' or
 *                                'capsule' (used by setCapsulePlane
 *                                to know which geometries to
 *                                recompute). Returns the mesh.
 *   - `detach(mesh)`             unregister a mesh (does not
 *                                dispose the shared material)
 *   - `dispose()`                release the shared material
 *
 * @returns {{
 *   setEnabled: (enabled: boolean) => void,
 *   isEnabled: () => boolean,
 *   setCapsulePlane: (plane: 'xy'|'xz'|'yz') => boolean,
 *   getCapsulePlane: () => string,
 *   attach: (geometry: THREE.BufferGeometry, kind: 'icosphere'|'capsule') => THREE.Mesh,
 *   detach: (mesh: THREE.Mesh) => void,
 *   dispose: () => void,
 * }}
 */
export function createAsteroidUvDebugOverlay() {
  // The shared debug material. One ShaderMaterial instance is
  // reused across every attached mesh (avoids per-asteroid
  // material allocation; the GPU compiles the shader once).
  const material = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;

      // HSV → RGB. Used to give each of the 10×10 cells a unique
      // hue so the dev can see "this fragment is in cell 47" at
      // a glance.
      vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
      }

      void main() {
        // Wrap UVs to [0, 1) so out-of-range UVs (e.g. if a
        // future unwrap goes outside the unit square) still
        // show up as a valid cell index.
        vec2 wrappedUv = fract(vUv);
        vec2 cellUv = wrappedUv * 10.0;
        vec2 cell = floor(cellUv);
        float cellIndex = cell.x + cell.y * 10.0;

        // Grid line distance. fract(cellUv) is the position
        // inside the current cell ([0, 1) x [0, 1)). Subtracting
        // 0.5 and taking the abs gives the distance to the cell
        // border; smoothstep turns this into an anti-aliased
        // line. The line width is 0.08 of a cell, which reads
        // clearly at typical camera distances.
        vec2 gridDist = abs(fract(cellUv) - 0.5);
        float lineWidth = 0.08;
        float lineX = 1.0 - smoothstep(0.0, lineWidth, gridDist.x);
        float lineY = 1.0 - smoothstep(0.0, lineWidth, gridDist.y);
        float line = clamp(max(lineX, lineY), 0.0, 1.0);

        // Per-cell color: rainbow by cell index (0–99). 0.7
        // saturation + full value gives vibrant, distinct cells.
        float hue = cellIndex / 100.0;
        vec3 cellColor = hsv2rgb(vec3(hue, 0.7, 1.0));

        // Mix: line is bright white, cell is colored.
        vec3 finalColor = mix(cellColor, vec3(1.0), line);

        gl_FragColor = vec4(finalColor, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    // polygonOffset pushes the debug mesh slightly toward the
    // camera, so it doesn't z-fight the body it's overlaid on
    // (the debug mesh shares the body's geometry, so the
    // fragments are at the same depth without this).
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  let enabled = false;
  // Maps from debug-mesh → { geometry, kind }. `kind` is 'icosphere'
  // or 'capsule' — used by setCapsulePlane to know which
  // geometries to recompute. (We could store the kind on the
  // mesh's userData, but a Map is cleaner and testable.)
  const attached = new Map();
  let capsulePlane = 'xy'; // initial value; updated by setCapsulePlane

  function setEnabled(value) {
    enabled = !!value;
    for (const mesh of attached.keys()) {
      mesh.visible = enabled;
    }
  }
  function isEnabled() {
    return enabled;
  }

  /**
   * Change the planar UV projection for every attached CAPSULE
   * body. Calls `Capsule.computePlanarUVs(plane)` on each
   * capsule's geometry and flags the UV attribute for re-upload.
   * Returns true if the plane is a valid option, false otherwise
   * (the state is unchanged in that case).
   */
  function setCapsulePlane(plane) {
    if (plane !== 'xy' && plane !== 'xz' && plane !== 'yz') {
      // eslint-disable-next-line no-console
      console.warn('[asteroid-uv-debug] setCapsulePlane: invalid plane', plane, '(expected xy | xz | yz)');
      return false;
    }
    capsulePlane = plane;
    for (const { geometry, kind } of attached.values()) {
      if (kind !== 'capsule') continue;
      if (typeof geometry.computePlanarUVs !== 'function') continue; // safety
      geometry.computePlanarUVs(plane);
      if (geometry.attributes.uv) geometry.attributes.uv.needsUpdate = true;
    }
    return true;
  }
  function getCapsulePlane() {
    return capsulePlane;
  }

  /**
   * Attach a debug mesh for the given geometry. The returned mesh
   * shares the geometry (no extra memory) and uses the overlay's
   * shared material. `visible` is set to the current `enabled`
   * state. `kind` is 'icosphere' or 'capsule' and is used by
   * setCapsulePlane to know which geometries to recompute.
   */
  function attach(geometry, kind) {
    if (!geometry) throw new Error('attach: `geometry` is required');
    if (kind !== 'icosphere' && kind !== 'capsule') {
      throw new Error('attach: `kind` must be "icosphere" or "capsule"');
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = enabled;
    mesh.renderOrder = 1; // render after the body (which has renderOrder 0)
    attached.set(mesh, { geometry, kind });
    return mesh;
  }

  /** Unregister a mesh. Does not dispose the shared material. */
  function detach(mesh) {
    attached.delete(mesh);
  }

  function dispose() {
    material.dispose();
    attached.clear();
  }

  return { setEnabled, isEnabled, setCapsulePlane, getCapsulePlane, attach, detach, dispose };
}
