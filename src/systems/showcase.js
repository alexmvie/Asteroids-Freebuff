import * as THREE from 'three';
import { createAsteroidFromSpec } from '../entities/asteroid.js';
import { createShip } from '../entities/ship.js';
import { createPowerUp } from '../entities/powerup.js';
import { SHAPE_TYPES } from '../world/chunk-constants.js';

// ---------------------------------------------------------------------------
// v0.72.0 — Object-Viewer Showcase mode.
//
// A second, game-free demo mode that reuses the game's EXACT rendering
// setup (the same THREE.Scene, camera, sun/lighting, nebula, starfield,
// shadow map + ACES tone mapping from createScene) but runs none of the
// game logic: no streaming, no collisions, no AI, no score. It presents
// every 3D object the game can produce — all 5 asteroid shapes × 5
// texture sets, the Blender-baked asteroid (v0.73.2), the player ship,
// a pirate ship, and all 6 power-up types — one at a time on a
// rotating turntable, like a character-select screen.
//
// Controls (while active):
//   → / ←      next / previous object
//   ↑ / ↓      next / previous texture variant (asteroids only)
//   drag        orbit the camera around the object (v0.72.3)
//   wheel       zoom in / out (v0.72.3)
//   F1 / Esc   leave the showcase, return to the game
//
// Activation: F1 toggles at runtime; the `#view-toggle` HUD button
// calls the same toggle; `?showcase` in the URL boots straight into
// the mode (used by the screenshot/iteration loop). The automation
// handle `window.__showcase` exposes { next, prev, texNext, texPrev,
// getLabel, getIndex, getCount, isActive, activate, deactivate } so
// headless scripts can walk every object and capture screenshots.
//
// While active, `document.body` carries the class `showcase-active`
// so CSS can hide the game HUD (score/energy/message) that would
// otherwise overlap the object-viewer label at the bottom of the
// screen.
//
// Isolation strategy: when active, every scene mesh that is NOT marked
// `userData.showcaseKeep` (sun/corona/nebula/lights/starfield) and NOT a
// showcase entry is hidden; the ORIGINAL visible flag of each hidden
// mesh is remembered and restored on deactivate, so DEMO-state
// visibility rules (AI ship visible, player ship hidden, ...) survive
// the round-trip untouched.
// ---------------------------------------------------------------------------

const ASTEROID_SHAPE_ORDER = [
  SHAPE_TYPES.SPINNING_TOP,
  SHAPE_TYPES.CRATERED_POTATO,
  SHAPE_TYPES.RUBBLE_PILE,
  SHAPE_TYPES.ELONGATED_POTATO,
  SHAPE_TYPES.CRAGGY_ROCK,
];

const POWERUP_TYPE_ORDER = ['shield', 'speed', 'energy', 'credits', 'hull', 'weapon'];

// ---------------------------------------------------------------------------
// v0.73.2 — Blender-baked asteroid GLB (branch `blender-asteroid-pipeline`).
//
// Loaded lazily with GLTFLoader (same pattern as powerup.js's per-type GLB
// cache). Node/test environments get null (no browser fetch), so the entry
// builds an empty wrapper that stays invisible; the browser path swaps in
// the baked Cycles mesh + PBR maps once the GLB resolves.
// ---------------------------------------------------------------------------
const BLENDER_ASTEROID_GLB_URL = '/models/asteroid-42.glb';
const _blenderGlbCache = new Map(); // url -> THREE.Group | null
const _blenderGlbLoading = new Map(); // url -> in-flight Promise

/**
 * Lazily load + normalize the Blender-baked asteroid GLB. Centers the
 * mesh on the origin (turntable axis) but keeps NATIVE scale (radius-8
 * bake → same camera framing as the procedural radius-8 showcase
 * asteroids). Tags every mesh castShadow + receiveShadow so the sun
 * shadow pass includes it (tagForShadows contract). Returns null on any
 * failure (entry stays on the empty placeholder).
 *
 * @returns {Promise<import('three').Group | null>}
 */
function loadBlenderAsteroidGlb() {
  if (_blenderGlbCache.has(BLENDER_ASTEROID_GLB_URL)) {
    return Promise.resolve(_blenderGlbCache.get(BLENDER_ASTEROID_GLB_URL));
  }
  if (_blenderGlbLoading.has(BLENDER_ASTEROID_GLB_URL)) {
    return _blenderGlbLoading.get(BLENDER_ASTEROID_GLB_URL);
  }
  const loading = (async () => {
    let GLTFLoader;
    try {
      ({ GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js'));
    } catch {
      _blenderGlbCache.set(BLENDER_ASTEROID_GLB_URL, null);
      return null;
    }
    try {
      const gltf = await new GLTFLoader().loadAsync(BLENDER_ASTEROID_GLB_URL);
      const root = gltf.scene;
      if (!root) throw new Error('GLB has no scene');
      // Center on origin (turntable axis) — keep native scale.
      const bbox = new THREE.Box3().setFromObject(root);
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      root.position.sub(center);
      // Sun shadow pass: baked mesh casts + receives like the
      // procedural asteroids.
      root.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      _blenderGlbCache.set(BLENDER_ASTEROID_GLB_URL, root);
      return root;
    } catch {
      _blenderGlbCache.set(BLENDER_ASTEROID_GLB_URL, null);
      return null;
    } finally {
      _blenderGlbLoading.delete(BLENDER_ASTEROID_GLB_URL);
    }
  })();
  _blenderGlbLoading.set(BLENDER_ASTEROID_GLB_URL, loading);
  return loading;
}

// ---------------------------------------------------------------------------
// v0.72.3 — Orbit camera. The object sits at the origin on the turntable;
// the camera orbits it in spherical coordinates (theta = azimuth, phi =
// elevation, dist = radius). Pure math is in `orbitCameraPosition`
// (exported for unit tests); the drag/wheel listeners just mutate the
// state and re-apply.
// ---------------------------------------------------------------------------
const ORBIT_PHI_MIN = 0.05;           // don't dive below the play plane
const ORBIT_PHI_MAX = Math.PI / 2 - 0.05; // don't look straight down
const ORBIT_DIST_MIN = 3;
const ORBIT_DIST_MAX = 400;
const ORBIT_DRAG_SPEED = 0.008;       // radians per pixel
const ORBIT_WHEEL_SPEED = 0.001;

/**
 * Pure spherical-orbit math: camera position around a target point.
 * theta = azimuth (rad), phi = elevation (rad), dist = radius.
 * phi = 0 → camera at the object's height (horizon view); positive
 * phi → camera rises (top-down-ish at PI/2).
 *
 * @param {number} theta
 * @param {number} phi
 * @param {number} dist
 * @param {{x?:number,y?:number,z?:number}} [target]
 * @returns {{x:number,y:number,z:number}}
 */
export function orbitCameraPosition(theta, phi, dist, target = { x: 0, y: 0, z: 0 }) {
  const cosPhi = Math.cos(phi);
  return {
    x: target.x + dist * cosPhi * Math.sin(theta),
    y: target.y + dist * Math.sin(phi),
    z: target.z + dist * cosPhi * Math.cos(theta),
  };
}

function clampOrbit(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Deterministic per (shape, texture) seed so the SAME combo always shows
// the SAME geometry across reloads (screenshot-comparable). The texture
// set is derived in asteroid.js from `(seed >> 3) % 5 + 1`, so we pick
// seeds that map textureIndex 1..5 → exactly that set. The shape index
// contributes the high bits so different shapes never share geometry.
function asteroidSeedFor(shapeIndex, textureIndex) {
  // (seed >> 3) % 5 == textureIndex-1  →  seed = (textureIndex-1)*8 + k
  // k in [0,8) keeps the low bits free; the shape offset avoids
  // collisions between shapes.
  return (shapeIndex + 1) * 1000 + (textureIndex - 1) * 8 + 42;
}

const SHAPE_LABELS = {
  spinning_top: 'Spinning Top (Bennu/Ryugu)',
  cratered_potato: 'Cratered Potato',
  rubble_pile: 'Rubble Pile (Itokawa)',
  elongated_potato: 'Elongated Potato (Eros)',
  craggy_rock: 'Craggy Rock',
};

/**
 * Create the object-viewer showcase.
 *
 * @param {{
 *   scene: import('three').Scene,
 *   camera: import('three').PerspectiveCamera,
 *   nebula: { update: (camera: unknown, dt: number) => void },
 *   updateLighting: (dt: number, pos: {x:number,y:number,z:number}) => void,
 *   canvasRoot?: HTMLElement | null,
 *   canvas?: HTMLCanvasElement | null,  // v0.72.3 — orbit-drag target;
 *                                       // defaults to the first <canvas>.
 * }} opts
 */
export function createShowcase({ scene, camera, nebula, updateLighting, canvasRoot = null, canvas = null } = {}) {
  if (!scene || !camera) throw new Error('createShowcase: `scene` and `camera` are required');

  let active = false;
  let index = 0;
  let textureIndex = 1; // 1..5 (asteroid texture sets)
  let current = null; // { dispose, update(dt), root, label }
  const visibilityBackup = new Map(); // Object3D -> original visible

  // v0.73.0 — freeze the turntable. When paused, `update(dt)` skips the
  // object's own per-frame rotation (the asteroids' `spec.spin` spin)
  // so the A/B screenshot loop can capture the SAME object frame with
  // SSAO off vs on — pixel-identical except the AO term. The nebula +
  // lighting keep updating (static backdrop, no camera motion).

  // v0.72.3 — orbit state (camera around the origin turntable).
  const orbit = { theta: 0, phi: 0.21, dist: 24 };
  let orbitDragging = false;
  let lastPointer = { x: 0, y: 0 };

  function applyOrbit() {
    const p = orbitCameraPosition(orbit.theta, orbit.phi, orbit.dist);
    camera.position.set(p.x, p.y, p.z);
    camera.lookAt(0, 0, 0);
  }

  // ---- Orbit pointer/wheel handlers (attached while active) -----------
  function onCanvasPointerDown(e) {
    if (!active) return;
    if (e.button !== undefined && e.button !== 0) return; // left button only
    orbitDragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    if (e.target && typeof e.target.setPointerCapture === 'function') {
      try { e.target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
  }
  function onPointerMove(e) {
    if (!active || !orbitDragging) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    orbit.theta -= dx * ORBIT_DRAG_SPEED;
    orbit.phi = clampOrbit(orbit.phi + dy * ORBIT_DRAG_SPEED, ORBIT_PHI_MIN, ORBIT_PHI_MAX);
    applyOrbit();
  }
  function onPointerUp() {
    orbitDragging = false;
  }
  function onCanvasWheel(e) {
    if (!active) return;
    e.preventDefault();
    orbit.dist = clampOrbit(orbit.dist * (1 + e.deltaY * ORBIT_WHEEL_SPEED), ORBIT_DIST_MIN, ORBIT_DIST_MAX);
    applyOrbit();
  }
  // The orbit-drag target: an explicit renderer canvas beats a DOM query
  // (a future UI could add canvases before the renderer's).
  function orbitCanvas() {
    if (canvas) return canvas;
    if (typeof document !== 'undefined') return document.querySelector('canvas');
    return null;
  }
  function attachOrbitControls() {
    if (typeof window === 'undefined') return;
    const c = orbitCanvas();
    if (!c) return;
    c.addEventListener('pointerdown', onCanvasPointerDown);
    c.addEventListener('wheel', onCanvasWheel, { passive: false });
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }
  function detachOrbitControls() {
    if (typeof window === 'undefined') return;
    const c = orbitCanvas();
    if (c) {
      c.removeEventListener('pointerdown', onCanvasPointerDown);
      c.removeEventListener('wheel', onCanvasWheel);
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }

  // ---- Entry catalogue ---------------------------------------------------
  // Each entry knows how to BUILD its object. Build is lazy (happens on
  // selection) so switching objects is cheap and disposal is clean.
  const buildAsteroidEntry = (shapeIndex) => ({
    kind: 'asteroid',
    label: () => {
      const shape = ASTEROID_SHAPE_ORDER[shapeIndex];
      return `Asteroid · ${SHAPE_LABELS[shape]} · Texture ${textureIndex}/5`;
    },
    build: () => {
      const shape = ASTEROID_SHAPE_ORDER[shapeIndex];
      const spec = {
        id: `showcase-a-${shapeIndex}-${textureIndex}`,
        position: { x: 0, y: 0, z: 0 },
        radius: 8,
        size: 0,
        axis: { x: 0, y: 1, z: 0 },
        spin: 0.35,
        velocity: { x: 0, y: 0, z: 0 },
        seed: asteroidSeedFor(shapeIndex, textureIndex),
        shape,
      };
      const entity = createAsteroidFromSpec({ spec, scene });
      entity.mesh.userData.showcaseEntry = true;
      // v0.72.4 — LOD tiers are lazy in the game (only far builds at
      // spawn, close/mid on proximity). The showcase frames objects at
      // ~24u — always in the close tier — so build every tier now for
      // frame-1 full detail (no one-frame pop while the close mesh
      // streams in).
      entity.ensureAllLodLevels();
      return {
        root: entity.mesh,
        dist: 24,
        height: 5,
        update: (dt) => entity.update(dt, camera),
        dispose: () => entity.dispose(),
      };
    },
  });

  const buildShipEntry = (kind) => {
    const label = kind === 'player' ? 'Player Ship · Skyfighter' : 'Pirate Ship · Hazard';
    return {
      kind,
      label: () => label,
      build: () => {
        const ship = createShip({ scene, position: { x: 0, y: 0, z: 0 } });
        ship.mesh.userData.showcaseEntry = true;
        if (kind === 'pirate') {
          // Red hull + hazard stripes (canvas-based; browser only).
          try {
            // Inline minimal pirate tint (mirrors main.js tintShipAs).
            ship.mesh.traverse((obj) => {
              if (obj.isMesh && obj.material) {
                obj.material.color.setHex(0xff3333);
                if (obj.material.emissive) obj.material.emissive.setHex(0xff3333);
              }
            });
          } catch { /* non-browser: keep default materials */ }
        }
        return {
          root: ship.mesh,
          dist: 12,
          height: 3.5,
          update: (dt) => {
            ship.mesh.rotation.y += dt * 0.6; // slow turntable
          },
          dispose: () => {
            scene.remove(ship.mesh);
            ship.dispose();
          },
        };
      },
    };
  };

  const buildPowerupEntry = (type) => {
    const label = `Power-up · ${type.toUpperCase()}`;
    return {
      kind: 'powerup',
      label: () => label,
      build: () => {
        const spec = { type, position: { x: 0, y: 0, z: 0 }, lifetime: Infinity };
        const powerup = createPowerUp({ scene, spec });
        const root = powerup.mesh || powerup.group || null;
        if (root) {
          root.userData.showcaseEntry = true;
          root.traverse((o) => { o.userData.showcaseEntry = true; });
        }
        return {
          root,
          dist: 7,
          height: 2.2,
          update: (dt) => {
            if (root) root.rotation.y += dt * 0.8;
          },
          dispose: () => {
            if (typeof powerup.dispose === 'function') {
              powerup.dispose();
            } else if (root) {
              scene.remove(root);
              root.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                  const mats = Array.isArray(o.material) ? o.material : [o.material];
                  for (const m of mats) if (m) m.dispose();
                }
              });
            }
          },
        };
      },
    };
  };

  // v0.73.2 — Blender-baked asteroid (Cycles). Loads the committed GLB
  // lazily; until it resolves the wrapper stays an empty (invisible)
  // group. The GLB keeps native scale (radius-8 bake → same camera
  // framing as the procedural asteroids) and its cached resources are
  // shared across selections, so dispose only detaches it from the
  // scene (no geometry/material disposal of the shared cache).
  const buildBlenderAsteroidEntry = () => ({
    kind: 'blender',
    label: () => 'Asteroid · Blender Baked (Cycles)',
    build: () => {
      const wrapper = new THREE.Group();
      wrapper.userData.showcaseEntry = true;
      scene.add(wrapper);
      // Race guard (review fix): if the user navigates away before the
      // GLB resolves, dispose() runs first — the resolved root must not
      // land on a dead wrapper. Benign either way (three re-parents on
      // next selection; GC collects the orphan), but the flag makes the
      // ordering explicit.
      let disposed = false;
      loadBlenderAsteroidGlb().then((root) => {
        if (!root || disposed) return; // load failed / non-browser / gone
        // Tag the subtree so the isolation pass never hides the GLB
        // meshes on a later activate round-trip.
        root.traverse((o) => { o.userData.showcaseEntry = true; });
        wrapper.add(root);
      });
      return {
        root: wrapper,
        dist: 24,
        height: 5,
        update: (dt) => { wrapper.rotation.y += dt * 0.35; }, // turntable
        dispose: () => {
          disposed = true;
          scene.remove(wrapper);
          wrapper.clear(); // detach children; shared GLB resources stay cached
        },
      };
    },
  });

  // Catalogue order: 5 asteroid shapes (× current texture), the
  // Blender-baked asteroid, player ship, pirate ship, 6 power-ups.
  const catalogue = [
    ...ASTEROID_SHAPE_ORDER.map((_, i) => buildAsteroidEntry(i)),
    buildBlenderAsteroidEntry(),
    buildShipEntry('player'),
    buildShipEntry('pirate'),
    ...POWERUP_TYPE_ORDER.map((t) => buildPowerupEntry(t)),
  ];
  const getCount = () => catalogue.length;

  // ---- DOM overlay -------------------------------------------------------
  function ensureOverlay() {
    if (overlay) return;
    if (typeof document === 'undefined') return; // Node/test env: no DOM
    const host = canvasRoot || document.body;
    if (!host) return;
    overlay = document.createElement('div');
    overlay.className = 'showcase-overlay';
    overlay.innerHTML =
      `<div class="showcase-overlay__label"></div>` +
      `<div class="showcase-overlay__nav">` +
      `<span>←/→ object</span><span>↑/↓ texture</span>` +
      `<span>drag orbit</span><span>wheel zoom</span><span>F1 exit</span>` +
      `</div>`;
    host.appendChild(overlay);
  }
  let overlay = null;

  function updateOverlay() {
    if (!overlay) return;
    const labelEl = overlay.querySelector('.showcase-overlay__label');
    if (labelEl && current) {
      labelEl.textContent = `${current.label}  (${index + 1}/${getCount()})`;
    }
  }

  // ---- Isolation ---------------------------------------------------------
  function hideGameObjects() {
    visibilityBackup.clear();
    scene.traverse((obj) => {
      if (obj.userData?.showcaseEntry) return;
      if (obj.userData?.showcaseKeep) return;
      if (!obj.isMesh && !obj.isPoints && !obj.isLine) return;
      // Keep the fixed space backdrop visible (starfield points, nebula
      // sphere, sun/corona meshes marked showcaseKeep).
      visibilityBackup.set(obj, obj.visible);
      obj.visible = false;
    });
  }

  function restoreGameObjects() {
    for (const [obj, visible] of visibilityBackup) {
      obj.visible = visible;
    }
    visibilityBackup.clear();
  }

  // ---- Object switching --------------------------------------------------
  function disposeCurrent() {
    if (current && current.dispose) {
      try { current.dispose(); } catch { /* ignore */ }
    }
    current = null;
  }

  function select() {
    disposeCurrent();
    const entry = catalogue[index];
    current = entry.build();
    // `label` is evaluated at build time (so texture-index changes are
    // reflected); store the STRING on `current` (entry.label() is a
    // function in the catalogue, current.label is the snapshot string).
    current.label = entry.label();
    if (!current.root) return;
    const dist = current.dist;
    const height = current.height;
    // v0.72.3 — reset the orbit framing to the entry's default (so each
    // object is framed cleanly on selection), then apply. The user's
    // drag/zoom orbit is preserved for the CURRENT object until they
    // switch (switching re-frames).
    orbit.theta = 0;
    orbit.phi = Math.atan2(height, dist);
    orbit.dist = dist;
    applyOrbit();
    updateOverlay();
  }

  // ---- Keyboard ----------------------------------------------------------
  function onKeyDown(e) {
    if (!active) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        index = (index + 1) % getCount();
        select();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        index = (index - 1 + getCount()) % getCount();
        select();
        break;
      case 'ArrowUp': {
        const entry = catalogue[index];
        if (entry.kind === 'asteroid') {
          e.preventDefault();
          textureIndex = (textureIndex % 5) + 1; // 1..5, wraps 5->1
          select();
        }
        break;
      }
      case 'ArrowDown': {
        const entry = catalogue[index];
        if (entry.kind === 'asteroid') {
          e.preventDefault();
          textureIndex = ((textureIndex - 2 + 5) % 5) + 1; // 1..5, wraps 1->5
          select();
        }
        break;
      }
      case 'F1':
      case 'Escape':
        e.preventDefault();
        deactivate();
        break;
      default:
        break;
    }
  }

  // ---- Public API --------------------------------------------------------
  function activate() {
    if (active) return;
    active = true;
    hideGameObjects();
    ensureOverlay();
    if (overlay) overlay.style.display = 'block';
    if (typeof document !== 'undefined' && document.body) document.body.classList.add('showcase-active');
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);
    attachOrbitControls();
    select();
    // Announce for automation + the view-toggle button label.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('showcase:active', { detail: { index } }));
  }

  function deactivate() {
    if (!active) return;
    active = false;
    disposeCurrent();
    restoreGameObjects();
    if (overlay) overlay.style.display = 'none';
    if (typeof document !== 'undefined' && document.body) document.body.classList.remove('showcase-active');
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeyDown);
    detachOrbitControls();
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('showcase:inactive'));
  }

  /**
   * Per-frame tick while active. Runs ONLY showcase logic: rotate the
   * object, keep the nebula camera-synced, keep the sun shadow centered
   * on the object. No game code runs.
   * @param {number} dt
   */
  let paused = false;

  function update(dt) {
    if (!active) return;
    if (!paused && current && current.update) current.update(dt);
    if (nebula && typeof nebula.update === 'function') nebula.update(camera, dt);
    if (updateLighting) updateLighting(dt, { x: 0, y: 0, z: 0 });
  }

  const api = {
    isActive: () => active,
    activate,
    deactivate,
    toggle: () => (active ? deactivate() : activate()),
    update,
    next: () => { if (active) { index = (index + 1) % getCount(); select(); } },
    prev: () => { if (active) { index = (index - 1 + getCount()) % getCount(); select(); } },
    texNext: () => { if (active && catalogue[index].kind === 'asteroid') { textureIndex = (textureIndex % 5) + 1; select(); } },
    texPrev: () => { if (active && catalogue[index].kind === 'asteroid') { textureIndex = ((textureIndex - 2 + 5) % 5) + 1; select(); } },
    getIndex: () => index,
    getCount,
    getLabel: () => (current ? current.label : null),
    setIndex: (i) => { if (active) { index = ((i % getCount()) + getCount()) % getCount(); select(); } },
    // v0.72.3 — orbit introspection for automation (screenshot loop
    // can verify the camera moved) + the drag/zoom dev loop.
    getCameraPosition: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
    getOrbit: () => ({ ...orbit }),
    // v0.73.0 — freeze/unfreeze the object turntable for identical-frame
    // A/B captures (SSAO off vs on on the same asteroid orientation).
    setPaused: (v) => { paused = !!v; },
    isPaused: () => paused,
  };

  // Global keyboard: F1 toggles even when the game is running (but never
  // steals arrows while inactive).
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F1') {
        e.preventDefault();
        api.toggle();
      }
    });
  }

  return api;
}
