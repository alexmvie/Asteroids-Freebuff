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
// texture sets, the player ship, a pirate ship, and all 6 power-up
// types — one at a time on a rotating turntable, like a character-
// select screen.
//
// Controls (while active):
//   → / ←      next / previous object
//   ↑ / ↓      next / previous texture variant (asteroids only)
//   F1 / Esc   leave the showcase, return to the game
//
// Activation: F1 toggles at runtime; `?showcase` in the URL boots
// straight into the mode (used by the screenshot/iteration loop). The
// automation handle `window.__showcase` exposes { next, prev, texNext,
// texPrev, getLabel, getIndex, getCount, isActive, activate, deactivate }
// so headless scripts can walk every object and capture screenshots.
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
 * }} opts
 */
export function createShowcase({ scene, camera, nebula, updateLighting, canvasRoot = null } = {}) {
  if (!scene || !camera) throw new Error('createShowcase: `scene` and `camera` are required');

  let active = false;
  let index = 0;
  let textureIndex = 1; // 1..5 (asteroid texture sets)
  let current = null; // { dispose, update(dt), root, label }
  const visibilityBackup = new Map(); // Object3D -> original visible

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

  // Catalogue order: 5 asteroid shapes (× current texture), player ship,
  // pirate ship, 6 power-ups.
  const catalogue = [
    ...ASTEROID_SHAPE_ORDER.map((_, i) => buildAsteroidEntry(i)),
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
      `<span>←/→ object</span><span>↑/↓ texture</span><span>F1/Esc exit</span>` +
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
    // Frame the object: camera looks at the origin where the turntable
    // sits, positioned at a per-entry distance/height.
    camera.position.set(0, height, dist);
    camera.lookAt(0, 0, 0);
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
    if (typeof window !== 'undefined') window.addEventListener('keydown', onKeyDown);
    select();
    // Announce for automation.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('showcase:active', { detail: { index } }));
  }

  function deactivate() {
    if (!active) return;
    active = false;
    disposeCurrent();
    restoreGameObjects();
    if (overlay) overlay.style.display = 'none';
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeyDown);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('showcase:inactive'));
  }

  /**
   * Per-frame tick while active. Runs ONLY showcase logic: rotate the
   * object, keep the nebula camera-synced, keep the sun shadow centered
   * on the object. No game code runs.
   * @param {number} dt
   */
  function update(dt) {
    if (!active) return;
    if (current && current.update) current.update(dt);
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
