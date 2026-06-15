/**
 * Edit Game Object screen — a full-screen modal that pauses the
 * game and shows the selected object's:
 *   - 3D viewport (a dedicated, lightweight renderer showing
 *     just the selected asteroid, orbitable, simple grid
 *     backdrop)
 *   - UV editor (the floating viewer, embedded in the sidebar)
 *   - Info box (radius, size, position, vertex/triangle counts,
 *     UV stats)
 *   - Close X to return to the game
 *
 * Flow (state machine: 'closed' | 'pick' | 'edit'):
 *
 *   closed ──beginPick()──▶ pick
 *   pick   ──openFor(e)───▶ edit    (user clicked an asteroid)
 *   pick   ──cancelPick()─▶ closed  (user pressed Esc / clicked EDIT OBJECT again)
 *   edit   ──close()──────▶ closed  (user clicked X)
 *
 *   1. User clicks EDIT OBJECT → `beginPick()` pauses the game,
 *      shows a small "EDIT MODE" hint at the top of the screen.
 *      The main 3D view stays active (cursor: crosshair).
 *   2. User clicks an asteroid in the 3D view → `openFor(entity)`
 *      opens the full screen for that entity.
 *   3. User clicks X (or Esc) → `close()` resumes the game.
 *
 * Performance:
 *   - The main 3D scene pauses (no updates, no rendering) when
 *     the screen is open. The modal's mini viewport is the only
 *     thing rendering.
 *   - The modal is OPAQUE (no transparency, no backdrop-filter),
 *     so the GPU doesn't waste fill-rate on a see-through layer.
 *   - The mini viewport uses a separate THREE.WebGLRenderer +
 *     a separate scene that contains ONLY the selected asteroid
 *     + a few lights + a grid. No other asteroids, no nebula,
 *     no ship — just the one object the user is editing.
 *
 * @param {{
 *   renderer: import('three').WebGLRenderer,
 *   camera: import('three').Camera,
 *   scene: import('three').Scene,
 *   getAsteroids: () => Array<{ mesh: THREE.Group, dispose: Function }>,
 *   onPause?: (paused: boolean) => void,
 *   createUvViewer?: () => Promise<{ mount, unmount, setEnabled, ... }>,
 * }} opts
 */
import * as THREE from 'three';
import { walkEdgeLoop, buildEdgeKey } from '../geometry/uv-unwrapping.js';

// ===========================================================================
// MINI_VIEWPORT_CONFIG
// ----------------------------------------------------------------------------
// All tunable values for the mini 3D viewport (camera, lights, grid,
// orbit controls, pick-hint feedback) live here. Tweak the orbit feel
// by changing numbers in this single object; the rest of the file
// references these and stays free of magic numbers.
//
// Naming:
//   - `camera.*`   THREE.PerspectiveCamera params (fov, near, far)
//   - `canvas.*`   the mini <canvas> sizing floor
//   - `lights.*`   ambient + directional + rim light setup
//   - `grid.*`     GridHelper params (size, divisions, colors, opacity)
//   - `orbit.*`    orbit camera controls (sensitivities, clamps, defaults)
//   - `pickHint.*` the "no asteroid there" feedback flash duration
// ===========================================================================
const MINI_VIEWPORT_CONFIG = {
  background: {
    color: 0x0a0a14,
  },
  camera: {
    fov: 50,
    near: 0.1,
    far: 100,
  },
  canvas: {
    minSize: 200, // px — minimum width/height to avoid a 0×0 canvas
  },
  lights: {
    ambient: {
      color: 0xffffff,
      intensity: 0.55,
    },
    directional: {
      color: 0xffffff,
      intensity: 0.9,
      position: [3, 5, 4],
    },
    rim: {
      color: 0x48dbfb,
      intensity: 0.3,
      position: [-4, 2, -3],
    },
  },
  grid: {
    size: 4,
    divisions: 8,
    centerColor: 0x48dbfb,
    gridColor: 0x232336,
    opacity: 0.35,
  },
  orbit: {
    autoRotateSpeed: 0.3,     // rad/sec when idle
    pointerSensitivity: 0.008, // rad/px
    wheelZoomFactor: 0.005,    // distance per wheel delta unit
    // FOCUS zoom range — min 0.1 (close enough to see individual
    // texels on a 2-8 unit radius asteroid) to max 500 (far
    // enough that the model is just a few pixels). The 5000×
    // range covers both extreme close-up (inspecting a single
    // texel) and far-out overview (model as a dot). The FOCUS
    // button still snaps to the default distance (3× radius);
    // this range is what the wheel / pinch can reach from there.
    minDistance: 0.1,
    maxDistance: 500,
    minPhi: 0.1,               // radians (avoids polar singularity)
    maxPhi: Math.PI - 0.1,
    distanceMultiplier: 3,     // default distance = radius × this
    minDefaultDistance: 2,     // floor for the default distance
    defaultTheta: Math.PI * 0.25, // 3/4 view azimuth
    defaultPhi: Math.PI * 0.35,   // 3/4 view elevation
    equatorPhi: Math.PI / 2,   // initial / equator polar angle
    // Floor for the 3D edge picker's world-space tolerance.
    // Without this floor, the proportional tolerance
    // (`cameraDist * 0.03`) becomes ~0.003 units at the
    // minDistance=0.1 close-up — too tight to hit an edge
    // on a 2-8 unit radius asteroid. 0.05 is roughly the
    // pixel width of a typical edge on screen.
    minPickTolerance: 0.05,
  },
  pickHint: {
    flashDurationMs: 1500,
  },
};

export function createEditObjectScreen({
  renderer,
  camera,
  scene,
  getAsteroids,
  onPause,
  createUvViewer,
}) {
  if (!renderer) throw new Error('createEditObjectScreen: `renderer` is required');
  if (!camera) throw new Error('createEditObjectScreen: `camera` is required');
  if (!scene) throw new Error('createEditObjectScreen: `scene` is required');
  if (typeof getAsteroids !== 'function') {
    throw new Error('createEditObjectScreen: `getAsteroids` is required');
  }

  // ---- State ------------------------------------------------------------
  let modalEl = null;
  let nameEl = null;
  let infoRowsEl = null;
  let closeBtn = null;
  let focusBtn = null;
  let statusEl = null;
  let uvHost = null;
  let miniHost = null;
  let pickHintEl = null;
  let mounted = false;
  let state = 'closed'; // 'closed' | 'pick' | 'edit'
  let currentEntity = null;
  let uvViewer = null;
  let uvViewerPromise = null;

  // Mini viewport (separate renderer for the selected asteroid).
  let miniRenderer = null;
  let miniScene = null;
  let miniCamera = null;
  let miniMesh = null;
  let miniCanvas = null;
  let miniResizeObs = null;
  // Mini viewport seam overlay (LineSegments for user-marked
  // seams, and a hover-highlight Line for the edge under the
  // cursor). Built in setupMiniViewport, updated by
  // rebuildSeamOverlay() whenever the UV viewer's seam state
  // changes.
  let miniSeamLines = null;        // user-marked seams (yellow)
  let miniAutoSeamLines = null;    // auto-detected seams (red)
  let miniHoverLine = null;        // hover highlight (cyan)
  let miniSeamHintEl = null;       // small status line in the corner
  let miniBodyGeometry = null;     // cached for picking (the cloned geom)
  let miniSeamListenerOff = null;  // unsubscribe handle for seam-change listener
  let orbit = { theta: 0, phi: MINI_VIEWPORT_CONFIG.orbit.equatorPhi, dist: MINI_VIEWPORT_CONFIG.orbit.minDefaultDistance, drag: null };
  let autoRotateEnabled = true; // toggled by the ANIM checkbox in the footer

  // 3D picking (for the pick mode click handler on the main canvas).
  const pickRaycaster = new THREE.Raycaster();
  const pickNdc = new THREE.Vector2();
  // 3D seam picking (for the mini viewport seam overlay).
  const seamRaycaster = new THREE.Raycaster();
  const seamNdc = new THREE.Vector2();
  const _seamHitVertex = new THREE.Vector3();
  let hoveredSeam = null; // { va, vb } or null

  // ===========================================================================
  // Public API
  // ===========================================================================

  function mount(parentEl = document.body) {
    if (modalEl) return;
    if (!parentEl) throw new Error('mount: parentEl is required');
    modalEl = document.createElement('div');
    modalEl.className = 'edit-screen';
    modalEl.dataset.editScreen = '';
    modalEl.innerHTML = `
      <div class="edit-screen__header">
        <span class="edit-screen__title">EDIT GAME OBJECT</span>
        <span class="edit-screen__name" data-edit-screen-name>—</span>
        <button class="edit-screen__close" type="button" data-edit-screen-close aria-label="Close editor">×</button>
      </div>
      <div class="edit-screen__body">
        <div class="edit-screen__3d" data-edit-screen-3d></div>
        <div class="edit-screen__side">
          <div class="edit-screen__uv" data-edit-screen-uv></div>
          <div class="edit-screen__info">
            <div class="edit-screen__info-title">INFO</div>
            <div class="edit-screen__info-rows" data-edit-screen-info-rows></div>
          </div>
        </div>
      </div>
      <div class="edit-screen__footer">
        <button class="edit-screen__btn" type="button" data-edit-screen-focus>FOCUS</button>
        <label class="edit-screen__checkbox" title="Toggle the mini viewport's auto-rotation">
          <input type="checkbox" data-edit-screen-anim checked />
          <span>ANIM</span>
        </label>
        <label class="edit-screen__checkbox" title="Hide the seam overlay so the live texture preview is clearly visible">
          <input type="checkbox" data-edit-screen-hide-seams />
          <span>HIDE SEAMS</span>
        </label>
        <span class="edit-screen__status" data-edit-screen-status>Drag the 3D view to rotate. Scroll to zoom.</span>
      </div>
    `;
    parentEl.appendChild(modalEl);

    nameEl = modalEl.querySelector('[data-edit-screen-name]');
    infoRowsEl = modalEl.querySelector('[data-edit-screen-info-rows]');
    closeBtn = modalEl.querySelector('[data-edit-screen-close]');
    focusBtn = modalEl.querySelector('[data-edit-screen-focus]');
    statusEl = modalEl.querySelector('[data-edit-screen-status]');
    uvHost = modalEl.querySelector('[data-edit-screen-uv]');
    miniHost = modalEl.querySelector('[data-edit-screen-3d]');
    const animCheckbox = modalEl.querySelector('[data-edit-screen-anim]');
    const hideSeamsCheckbox = modalEl.querySelector('[data-edit-screen-hide-seams]');

    closeBtn.addEventListener('click', close);
    focusBtn.addEventListener('click', focusOnSelected);
    if (animCheckbox) {
      autoRotateEnabled = !!animCheckbox.checked;
      animCheckbox.addEventListener('change', () => {
        autoRotateEnabled = !!animCheckbox.checked;
      });
    }
    if (hideSeamsCheckbox) {
      // The 3D mini viewport already shows the live texture
      // preview (the cloned mesh shares the original's material
      // and geometry, so UV changes drive the texture in real
      // time). The seam overlay is the only thing covering the
      // texture — this toggle hides it so the preview is
      // clearly visible. Hover and click still work while the
      // overlay is hidden (the edge is just picked invisibly).
      hideSeamsCheckbox.addEventListener('change', () => {
        const hidden = !!hideSeamsCheckbox.checked;
        if (miniSeamLines) miniSeamLines.visible = !hidden;
        if (miniAutoSeamLines) miniAutoSeamLines.visible = !hidden;
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown);
    }

    mounted = true;
  }

  function unmount() {
    if (!modalEl) return;
    if (state === 'edit') close();
    if (state === 'pick') cancelPick();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
    }
    teardownMiniViewport();
    if (uvViewer) {
      try { uvViewer.unmount(); } catch (_) { /* ignore */ }
      uvViewer = null;
    }
    if (pickHintEl && pickHintEl.parentNode) {
      pickHintEl.parentNode.removeChild(pickHintEl);
    }
    pickHintEl = null;
    modalEl.remove();
    modalEl = null;
    nameEl = infoRowsEl = closeBtn = focusBtn = statusEl = uvHost = miniHost = null;
    // The hide-seams checkbox listener is bound to a DOM node
    // that we just removed, so it gets garbage-collected
    // automatically — no explicit cleanup needed.
    mounted = false;
  }

  /**
   * Enter pick mode: pause the game, show a small "EDIT MODE"
   * hint at the top of the screen, and listen for a click on
   * the main 3D canvas. The next asteroid click opens the
   * screen for that entity.
   */
  function beginPick() {
    if (state !== 'closed') return;
    if (!modalEl) mount();
    state = 'pick';
    if (typeof onPause === 'function') onPause(true);
    if (renderer && renderer.domElement) {
      // Capture phase so the edit screen's picker runs BEFORE
      // the UV viewer's onCanvas3DClick.
      renderer.domElement.addEventListener('click', onPickClickCapture, true);
      renderer.domElement.style.cursor = 'crosshair';
    }
    showPickHint();
  }

  /**
   * Cancel pick mode (Esc, or clicking EDIT OBJECT while in
   * pick mode). Resumes the game and removes the pick handlers.
   */
  function cancelPick() {
    if (state !== 'pick') return;
    state = 'closed';
    if (renderer && renderer.domElement) {
      renderer.domElement.removeEventListener('click', onPickClickCapture, true);
      renderer.domElement.style.cursor = 'default';
    }
    hidePickHint();
    if (typeof onPause === 'function') onPause(false);
  }

  /**
   * Open the full editor screen for the given entity. Called
   * internally by the pick click handler, or externally when
   * an entity is already known (e.g. the floating UV viewer
   * already had one selected).
   */
  function openFor(entity) {
    if (!entity) return;
    if (!modalEl) mount();
    state = 'edit';
    // Stop the pick click handler (we're past pick mode now).
    if (renderer && renderer.domElement) {
      renderer.domElement.removeEventListener('click', onPickClickCapture, true);
      renderer.domElement.style.cursor = 'default';
    }
    hidePickHint();
    currentEntity = entity;
    modalEl.classList.add('edit-screen--visible');
    refreshInfo();
    setupMiniViewport();
    ensureUvViewer().then((viewer) => {
      if (!viewer || !uvHost) return;
      viewer.mount(uvHost);
      viewer.selectAsteroid(entity);
      viewer.setEnabled(true);
    });
  }

  /**
   * Close the editor screen and resume the game. Cleans up
   * the mini renderer, the embedded UV viewer, and any pick
   * state.
   */
  function close() {
    if (state === 'pick') cancelPick();
    if (state !== 'edit') return;
    state = 'closed';
    modalEl.classList.remove('edit-screen--visible');
    teardownMiniViewport();
    if (uvViewer) {
      try { uvViewer.setEnabled(false); } catch (_) { /* ignore */ }
    }
    if (typeof onPause === 'function') onPause(false);
    currentEntity = null;
  }

  function isOpen() { return state === 'edit'; }
  function isPicking() { return state === 'pick'; }
  function isMounted() { return mounted; }
  function getEntity() { return currentEntity; }

  /**
   * Per-frame update for the mini viewport. Called by main.js
   * instead of rendering the main scene when the screen is open.
   * @param {number} dt seconds since last frame
   */
  function updateMini(dt) {
    if (state !== 'edit' || !miniRenderer) return;
    if (!orbit.drag && autoRotateEnabled) {
      // Slow auto-rotation when idle (gives the user visual
      // feedback that the editor is live). Toggled by the ANIM
      // checkbox in the footer.
      orbit.theta += dt * MINI_VIEWPORT_CONFIG.orbit.autoRotateSpeed;
    }
    updateMiniCamera();
    miniRenderer.render(miniScene, miniCamera);
  }

  function dispose() { unmount(); }

  // ===========================================================================
  // Mini viewport — separate renderer for the selected asteroid
  // ===========================================================================

  function setupMiniViewport() {
    if (!miniHost || miniRenderer) return;
    const rect = miniHost.getBoundingClientRect();
    const minSize = MINI_VIEWPORT_CONFIG.canvas.minSize;
    const width = Math.max(rect.width, minSize);
    const height = Math.max(rect.height, minSize);

    miniCanvas = document.createElement('canvas');
    miniCanvas.className = 'edit-screen__mini-canvas';
    miniCanvas.setAttribute('data-edit-screen-mini-canvas', '');
    miniCanvas.style.width = `${width}px`;
    miniCanvas.style.height = `${height}px`;
    miniCanvas.style.display = 'block';
    miniHost.appendChild(miniCanvas);

    miniRenderer = new THREE.WebGLRenderer({ canvas: miniCanvas, antialias: true });
    miniRenderer.setPixelRatio(window.devicePixelRatio || 1);
    miniRenderer.setSize(width, height, false);
    miniRenderer.setClearColor(MINI_VIEWPORT_CONFIG.background.color, 1);

    miniScene = new THREE.Scene();
    miniScene.background = new THREE.Color(MINI_VIEWPORT_CONFIG.background.color);

    const cam = MINI_VIEWPORT_CONFIG.camera;
    miniCamera = new THREE.PerspectiveCamera(cam.fov, width / height, cam.near, cam.far);

    // Lights — ambient + directional (shading) + rim (color accent).
    const lights = MINI_VIEWPORT_CONFIG.lights;
    const ambient = new THREE.AmbientLight(lights.ambient.color, lights.ambient.intensity);
    miniScene.add(ambient);
    const dir = new THREE.DirectionalLight(lights.directional.color, lights.directional.intensity);
    dir.position.set(...lights.directional.position);
    miniScene.add(dir);
    const rim = new THREE.DirectionalLight(lights.rim.color, lights.rim.intensity);
    rim.position.set(...lights.rim.position);
    miniScene.add(rim);

    // Grid backdrop.
    const grid = MINI_VIEWPORT_CONFIG.grid;
    const gridHelper = new THREE.GridHelper(grid.size, grid.divisions, grid.centerColor, grid.gridColor);
    gridHelper.material.opacity = grid.opacity;
    gridHelper.material.transparent = true;
    miniScene.add(gridHelper);

    // Clone the selected asteroid.
    if (currentEntity) {
      miniMesh = cloneAsteroid(currentEntity);        if (miniMesh) {
          miniScene.add(miniMesh);
          // Cache the body geometry for edge picking.
          // `cloneAsteroid` always returns a Mesh (it dereferences
          // `level.object` for LODs), so we just use the geometry
          // directly. No need for an isLOD check.
          miniBodyGeometry = miniMesh.geometry;
        // Create the seam overlay LineSegments + hover highlight.
        // These are rebuilt by rebuildSeamOverlay() whenever the
        // UV viewer's seam state changes (via the listener
        // registered in ensureUvViewer).
        miniSeamLines = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({
            color: 0xffeb3b,    // user-marked seams: yellow
            linewidth: 2,
            transparent: true,
            opacity: 0.95,
            depthTest: true,
          }),
        );
        miniSeamLines.renderOrder = 1;
        miniScene.add(miniSeamLines);
        miniAutoSeamLines = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({
            color: 0xff3344,    // auto-detected seams: red
            linewidth: 1,
            transparent: true,
            opacity: 0.7,
            depthTest: true,
          }),
        );
        miniAutoSeamLines.renderOrder = 1;
        miniScene.add(miniAutoSeamLines);
        miniHoverLine = new THREE.LineSegments(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({
            color: 0x48dbfb,    // hover highlight: cyan
            linewidth: 3,
            transparent: true,
            opacity: 1.0,
            depthTest: false,
          }),
        );
        miniHoverLine.renderOrder = 2;
        miniScene.add(miniHoverLine);
        // Initial build (no seams yet, but we still need the
        // empty overlay geometry so the first frame doesn't
        // crash). The actual seam data arrives once the UV
        // viewer's seam-change listener fires.
        rebuildSeamOverlay();
        updateSeamHint();
      }
    }
    // Seam-count status line (small text in the top-left of
    // the 3D area, below the FOCUS button's hint). Shows the
    // current seam state + a one-line help for seam editing.
    miniSeamHintEl = document.createElement('div');
    miniSeamHintEl.className = 'edit-screen__seam-hint';
    miniSeamHintEl.setAttribute('data-edit-screen-seam-hint', '');
    miniHost.appendChild(miniSeamHintEl);

    // 3D edge picking — pointer move for hover, click for toggle.
    miniCanvas.addEventListener('pointermove', onMiniSeamPointerMove);
    miniCanvas.addEventListener('pointerleave', onMiniSeamPointerLeave);
    miniCanvas.addEventListener('click', onMiniSeamClick);

    // Default orbit distance: N× the asteroid's radius (or the floor).
    const r = currentEntity && currentEntity.spec && currentEntity.spec.radius;
    const ob = MINI_VIEWPORT_CONFIG.orbit;
    orbit = {
      theta: 0,
      phi: ob.equatorPhi,
      dist: Math.max(ob.minDefaultDistance, (r || 1) * ob.distanceMultiplier),
      drag: null,
    };
    updateMiniCamera();

    // Orbit controls (pointer-based — no library dependency).
    miniCanvas.addEventListener('pointerdown', onMiniPointerDown);
    miniCanvas.addEventListener('pointermove', onMiniPointerMove);
    miniCanvas.addEventListener('pointerup', onMiniPointerUp);
    miniCanvas.addEventListener('pointercancel', onMiniPointerUp);
    miniCanvas.addEventListener('wheel', onMiniWheel, { passive: false });

    // Resize observer — keep the mini viewport sized to its host.
    if (typeof ResizeObserver !== 'undefined') {
      miniResizeObs = new ResizeObserver(() => {
        if (!miniRenderer || !miniHost) return;
        const r = miniHost.getBoundingClientRect();
        const w = Math.max(r.width, MINI_VIEWPORT_CONFIG.canvas.minSize);
        const h = Math.max(r.height, MINI_VIEWPORT_CONFIG.canvas.minSize);
        miniRenderer.setSize(w, h, false);
        miniCamera.aspect = w / h;
        miniCamera.updateProjectionMatrix();
      });
      miniResizeObs.observe(miniHost);
    }
  }

  function teardownMiniViewport() {
    if (miniResizeObs) {
      try { miniResizeObs.disconnect(); } catch (_) { /* ignore */ }
      miniResizeObs = null;
    }
    // Unsubscribe the seam-change listener so the mini overlay
    // doesn't try to rebuild itself after the UV viewer is gone.
    if (miniSeamListenerOff) {
      try { miniSeamListenerOff(); } catch (_) { /* ignore */ }
      miniSeamListenerOff = null;
    }
    if (miniCanvas) {
      miniCanvas.removeEventListener('pointerdown', onMiniPointerDown);
      miniCanvas.removeEventListener('pointermove', onMiniPointerMove);
      miniCanvas.removeEventListener('pointerup', onMiniPointerUp);
      miniCanvas.removeEventListener('pointercancel', onMiniPointerUp);
      miniCanvas.removeEventListener('wheel', onMiniWheel);
      miniCanvas.removeEventListener('pointermove', onMiniSeamPointerMove);
      miniCanvas.removeEventListener('pointerleave', onMiniSeamPointerLeave);
      miniCanvas.removeEventListener('click', onMiniSeamClick);
    }
    if (miniRenderer) {
      try { miniRenderer.dispose(); } catch (_) { /* ignore */ }
      miniRenderer = null;
    }
    if (miniMesh) {
      // Geometry + material are shared with the original asteroid;
      // we don't dispose them (the original mesh still owns them).
      miniMesh = null;
    }
    if (miniScene) {
      // Dispose the grid + seam overlay LineSegments (the only
      // objects owned by the mini scene). The shared asteroid
      // mesh's geometry/material are NOT disposed.
      miniScene.traverse((obj) => {
        if (obj === miniMesh) return;
        if (obj.geometry) {
          try { obj.geometry.dispose(); } catch (_) { /* ignore */ }
        }
        if (obj.material) {
          try { obj.material.dispose(); } catch (_) { /* ignore */ }
        }
      });
      miniScene = null;
    }
    miniCamera = null;
    if (miniSeamHintEl && miniSeamHintEl.parentNode) {
      miniSeamHintEl.parentNode.removeChild(miniSeamHintEl);
      miniSeamHintEl = null;
    }
    miniSeamLines = null;
    miniAutoSeamLines = null;
    miniHoverLine = null;
    miniBodyGeometry = null;
    if (miniCanvas && miniCanvas.parentNode) {
      miniCanvas.parentNode.removeChild(miniCanvas);
    }
    miniCanvas = null;
  }

  /**
   * Clone the selected asteroid's mesh for the mini viewport.
   * The clone shares the geometry + material with the original
   * (we don't modify it, so sharing is safe and saves memory).
   * Position/rotation/scale are reset so the clone sits at the
   * origin, axis-aligned.
   */
  function cloneAsteroid(entity) {
    const original = entity && entity.mesh && entity.mesh.children && entity.mesh.children[0];
    if (!original) return null;
    if (original.isLOD) {
      const level = original.levels[0];
      if (!level || !level.object) return null;
      const clone = level.object.clone();
      clone.position.set(0, 0, 0);
      clone.rotation.set(0, 0, 0);
      clone.scale.set(1, 1, 1);
      return clone;
    }
    const clone = original.clone();
    clone.position.set(0, 0, 0);
    clone.rotation.set(0, 0, 0);
    clone.scale.set(1, 1, 1);
    return clone;
  }

  function updateMiniCamera() {
    if (!miniCamera) return;
    const x = orbit.dist * Math.sin(orbit.phi) * Math.cos(orbit.theta);
    const y = orbit.dist * Math.cos(orbit.phi);
    const z = orbit.dist * Math.sin(orbit.phi) * Math.sin(orbit.theta);
    miniCamera.position.set(x, y, z);
    miniCamera.lookAt(0, 0, 0);
  }

  function onMiniPointerDown(e) {
    if (!miniCanvas) return;
    try { miniCanvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    orbit.drag = { x: e.clientX, y: e.clientY, theta: orbit.theta, phi: orbit.phi };
  }
  function onMiniPointerMove(e) {
    if (!orbit.drag) return;
    const ob = MINI_VIEWPORT_CONFIG.orbit;
    const dx = e.clientX - orbit.drag.x;
    const dy = e.clientY - orbit.drag.y;
    orbit.theta = orbit.drag.theta - dx * ob.pointerSensitivity;
    orbit.phi = Math.max(ob.minPhi, Math.min(ob.maxPhi, orbit.drag.phi - dy * ob.pointerSensitivity));
    updateMiniCamera();
  }
  function onMiniPointerUp(e) {
    if (miniCanvas) {
      try { miniCanvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }
    orbit.drag = null;
  }
  function onMiniWheel(e) {
    e.preventDefault();
    const ob = MINI_VIEWPORT_CONFIG.orbit;
    orbit.dist = Math.max(ob.minDistance, Math.min(ob.maxDistance, orbit.dist + e.deltaY * ob.wheelZoomFactor));
    updateMiniCamera();
  }

  function focusOnSelected() {
    if (!currentEntity) return;
    // Reset the mini orbit camera to a clean 3/4 view.
    const ob = MINI_VIEWPORT_CONFIG.orbit;
    orbit.theta = ob.defaultTheta;
    orbit.phi = ob.defaultPhi;
    const r = currentEntity.spec && currentEntity.spec.radius;
    orbit.dist = Math.max(ob.minDefaultDistance, (r || 1) * ob.distanceMultiplier);
    orbit.drag = null;
    updateMiniCamera();
  }

  // ===========================================================================
  // 3D seam overlay + edge picking
  // ===========================================================================
  // The mini viewport shows the selected asteroid on the left
  // and the UV editor on the right. The seam overlay renders
  // user-marked seams (yellow) and auto-detected seams (red)
  // on top of the 3D mesh. Hovering an edge highlights it in
  // cyan; clicking toggles the seam. The seam state is shared
  // with the 2D UV editor via the seam-change listener.
  //
  // rebuildSeamOverlay() is called by the seam-change listener
  // (in ensureUvViewer) and on the first frame. It reads the
  // current seam state from the UV viewer and rebuilds the
  // LineSegments geometry.
  // =============================================================================
  function rebuildSeamOverlay() {
    if (!miniBodyGeometry || !miniSeamLines || !miniAutoSeamLines || !uvViewer) return;
    const state = uvViewer.getSeamState ? uvViewer.getSeamState() : null;
    if (!state) return;
    // After the seam-storage refactor, both userSeamKeys and
    // autoSeamKeys are Sets of VERTEX-edge keys (lo*1000000+hi
    // — the same encoding buildEdgeKey uses, but the 3D path
    // constructs the key inline to avoid a cross-module
    // import). We can match them to the geometry's edges
    // directly — no UV lookup, no risk of seams detaching
    // after a re-unwrap. The previous version walked every
    // edge, looked up the UVs of its two endpoints, computed
    // a UV-edge key, and checked the set; the encoding has
    // since been replaced with vertex-edge keys, so the UV
    // step is now unnecessary.
    const userPositions = [];
    const autoPositions = [];
    const pos = miniBodyGeometry.attributes.position;
    const idxArr = miniBodyGeometry.index ? miniBodyGeometry.index.array : null;
    const faceCount = idxArr ? Math.floor(idxArr.length / 3) : Math.floor(pos.count / 3);
    const pushEdge = (arr, va, vb) => {
      arr.push(pos.getX(va), pos.getY(va), pos.getZ(va));
      arr.push(pos.getX(vb), pos.getY(vb), pos.getZ(vb));
    };
    for (let f = 0; f < faceCount; f++) {
      let a, b, c;
      if (idxArr) {
        a = idxArr[f * 3 + 0]; b = idxArr[f * 3 + 1]; c = idxArr[f * 3 + 2];
      } else {
        a = f * 3 + 0; b = f * 3 + 1; c = f * 3 + 2;
      }
      const edges = [[a, b], [b, c], [c, a]];
      for (const [va, vb] of edges) {
        // Must use the canonical buildEdgeKey encoding
        // (lo + hi * 65536) — the previous hardcoded
        // `lo * 1000000 + hi` was a latent bug: seamKeys and
        // layout.seamEdges use the buildEdgeKey encoding, so
        // this lookup silently missed and the 3D overlay was
        // always empty. Importing buildEdgeKey from
        // uv-unwrapping.js keeps both sides in lockstep.
        const ek = buildEdgeKey(va, vb);
        if (state.userSeamKeys.has(ek)) {
          pushEdge(userPositions, va, vb);
        } else if (state.autoSeamKeys && state.autoSeamKeys.has(ek)) {
          pushEdge(autoPositions, va, vb);
        }
      }
    }
    // Update the LineSegments geometries. dispose() the old one
    // to avoid leaking the previous frame's buffer.
    miniSeamLines.geometry.dispose();
    miniSeamLines.geometry = new THREE.BufferGeometry();
    miniSeamLines.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(userPositions), 3),
    );
    miniAutoSeamLines.geometry.dispose();
    miniAutoSeamLines.geometry = new THREE.BufferGeometry();
    miniAutoSeamLines.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(autoPositions), 3),
    );
  }

  function updateSeamHint() {
    if (!miniSeamHintEl) return;
    const state = uvViewer && uvViewer.getSeamState ? uvViewer.getSeamState() : null;
    const userCount = state ? state.seamCount : 0;
    const liveOn = state ? state.isLiveUnwrapEnabled : true;
    miniSeamHintEl.innerHTML = userCount === 0
      ? `<strong>SEAMS</strong> · 0 user · Click an edge on the mesh to mark it as a seam. ${liveOn ? '<span class="edit-screen__seam-hint__live">LIVE</span>' : ''}`
      : `<strong>SEAMS</strong> · ${userCount} user · ${liveOn ? '<span class="edit-screen__seam-hint__live">LIVE</span>' : ''}`;
  }

  /**
   * Find the closest 3D edge of the asteroid to the cursor.
   * Returns { va, vb } (vertex indices) or null if no edge is
   * within the tolerance. The tolerance is in world-space
   * distance (NOT screen pixels) — the user's camera distance
   * to the asteroid sets the natural feel.
   */
  function pickClosestEdge(clientX, clientY) {
    if (!miniCanvas || !miniMesh || !miniBodyGeometry) return null;
    const rect = miniCanvas.getBoundingClientRect();
    seamNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    seamNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    seamRaycaster.setFromCamera(seamNdc, miniCamera);
    const hits = seamRaycaster.intersectObject(miniMesh, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const faceIdx = hit.faceIndex;
    if (faceIdx == null) return null;
    // Get the 3 vertices of the hit face.
    const idxArr = miniBodyGeometry.index ? miniBodyGeometry.index.array : null;
    let va, vb, vc;
    if (idxArr) {
      va = idxArr[faceIdx * 3 + 0];
      vb = idxArr[faceIdx * 3 + 1];
      vc = idxArr[faceIdx * 3 + 2];
    } else {
      va = faceIdx * 3 + 0; vb = faceIdx * 3 + 1; vc = faceIdx * 3 + 2;
    }
    // Find the closest edge of the face to the hit point in 3D.
    const pos = miniBodyGeometry.attributes.position;
    const edges = [[va, vb], [vb, vc], [vc, va]];
    let best = null, bestDist = Infinity;
    for (const [e0, e1] of edges) {
      const ax = pos.getX(e0), ay = pos.getY(e0), az = pos.getZ(e0);
      const bx = pos.getX(e1), by = pos.getY(e1), bz = pos.getZ(e1);
      const dx = bx - ax, dy = by - ay, dz = bz - az;
      const len2 = dx * dx + dy * dy + dz * dz;
      let t;
      if (len2 < 1e-12) {
        t = 0;
      } else {
        t = ((hit.point.x - ax) * dx + (hit.point.y - ay) * dy + (hit.point.z - az) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
      }
      const cx = ax + t * dx, cy = ay + t * dy, cz = az + t * dz;
      const ex = hit.point.x - cx, ey = hit.point.y - cy, ez = hit.point.z - cz;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (d < bestDist) { bestDist = d; best = [e0, e1]; }
    }
    // Tolerance: a few percent of the camera distance to the
    // origin (so the feel scales with zoom). This is loose
    // enough to be forgiving but tight enough to feel
    // intentional.
    // Tolerance: a few percent of the camera distance to the
    // origin (so the feel scales with zoom), but never less
    // than `minPickTolerance` — at minDistance=0.1 the
    // proportional value is 0.003 units, which is too tight
    // to hit an edge on a 2-8 unit radius asteroid.
    const tolerance = Math.max(
      miniCamera.position.length() * 0.03,
      MINI_VIEWPORT_CONFIG.orbit.minPickTolerance,
    );
    if (bestDist > tolerance) return null;
    return { va: best[0], vb: best[1] };
  }

  function setHoveredSeam(va, vb) {
    if ((va == null) !== (hoveredSeam == null)
      || (va != null && (hoveredSeam.va !== va || hoveredSeam.vb !== vb))) {
      hoveredSeam = (va != null) ? { va, vb } : null;
      if (!miniHoverLine || !miniBodyGeometry) return;
      const pos = miniBodyGeometry.attributes.position;
      if (va == null) {
        // Clear the hover geometry.
        miniHoverLine.geometry.dispose();
        miniHoverLine.geometry = new THREE.BufferGeometry();
      } else {
        const positions = new Float32Array([
          pos.getX(va), pos.getY(va), pos.getZ(va),
          pos.getX(vb), pos.getY(vb), pos.getZ(vb),
        ]);
        miniHoverLine.geometry.dispose();
        miniHoverLine.geometry = new THREE.BufferGeometry();
        miniHoverLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      }
    }
  }

  function onMiniSeamPointerMove(e) {
    // Only respond when the orbit isn't being dragged (so the
    // hover doesn't fight the orbit gesture).
    if (orbit.drag) { setHoveredSeam(null); return; }
    const picked = pickClosestEdge(e.clientX, e.clientY);
    if (picked) {
      setHoveredSeam(picked.va, picked.vb);
      // Alt+hover suggests a loop-selection action.
      miniCanvas.style.cursor = e.altKey ? 'crosshair' : 'pointer';
    } else {
      setHoveredSeam(null);
      miniCanvas.style.cursor = orbit.drag ? 'grabbing' : 'grab';
    }
  }
  function onMiniSeamPointerLeave() {
    setHoveredSeam(null);
  }
  function onMiniSeamClick(e) {
    if (orbit.drag) return; // suppress click after an orbit drag
    if (!uvViewer || typeof uvViewer.toggleSeamFrom3D !== 'function') return;
    const picked = pickClosestEdge(e.clientX, e.clientY);
    if (!picked) return;
    if (e.altKey && miniBodyGeometry) {
      // Alt+Click: toggle every edge in the loop (Blender
      // "Mark Loop as Seam" workflow). Walks the 3D loop and
      // toggles each edge's seam via the 2D editor's API so
      // the 2D panel and seam overlay stay in sync.
      const loop = walkEdgeLoop(miniBodyGeometry, picked.va, picked.vb);
      let addedCount = 0;
      let removedCount = 0;
      for (const { va, vb } of loop) {
        const wasAdded = uvViewer.toggleSeamFrom3D(va, vb);
        if (wasAdded) addedCount++; else removedCount++;
      }
      if (statusEl) {
        const state = uvViewer.getSeamState ? uvViewer.getSeamState() : null;
        const live = state ? state.isLiveUnwrapEnabled : true;
        statusEl.textContent = `Alt+Click loop: toggled ${loop.length} edge${loop.length === 1 ? '' : 's'} ` +
          `(${addedCount} added, ${removedCount} removed). ${live ? 'Live re-unwrap in progress.' : 'Press W (or click UNWRAP) to apply.'}`;
      }
      return;
    }
    const added = uvViewer.toggleSeamFrom3D(picked.va, picked.vb);
    if (statusEl) {
      const state = uvViewer.getSeamState ? uvViewer.getSeamState() : null;
      const live = state ? state.isLiveUnwrapEnabled : true;
      statusEl.textContent = added
        ? (live
            ? 'Marked seam (3D). Live re-unwrap in progress.'
            : 'Marked seam (3D). Press W (or click UNWRAP) to apply.')
        : (live
            ? 'Cleared seam (3D). Live re-unwrap in progress.'
            : 'Cleared seam (3D). Press W (or click UNWRAP) to apply.');
    }
  }

  // ===========================================================================
  // Pick mode (click on the main 3D canvas to pick an asteroid)
  // ===========================================================================

  function onPickClickCapture(e) {
    if (state !== 'pick') return;
    const entity = pickEntity(e.clientX, e.clientY);
    if (entity) {
      openFor(entity);
    } else {
      // No asteroid under the cursor — give visual feedback.
      flashPickHint('No asteroid there — try again.');
    }
  }

  function pickEntity(clientX, clientY) {
    if (!renderer || !camera) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pickNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pickNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    pickRaycaster.setFromCamera(pickNdc, camera);
    const asteroids = getAsteroids() || [];
    const meshes = [];
    const meshToEntity = new Map();
    for (const a of asteroids) {
      if (!a || !a.mesh || !a.mesh.children) continue;
      const body = a.mesh.children[0];
      if (!body) continue;
      if (body.isLOD) {
        for (const level of body.levels) {
          if (level.object) {
            meshes.push(level.object);
            meshToEntity.set(level.object, a);
          }
        }
      } else {
        meshes.push(body);
        meshToEntity.set(body, a);
      }
    }
    if (meshes.length === 0) return null;
    const hits = pickRaycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      const entity = meshToEntity.get(hit.object);
      if (entity) return entity;
    }
    return null;
  }

  // ===========================================================================
  // Pick hint overlay (small banner at the top of the screen)
  // ===========================================================================

  function showPickHint() {
    if (!pickHintEl) {
      pickHintEl = document.createElement('div');
      pickHintEl.className = 'edit-screen__pick-hint';
      pickHintEl.setAttribute('data-edit-screen-pick-hint', '');
      document.body.appendChild(pickHintEl);
    }
    pickHintEl.innerHTML = `
      <strong>EDIT MODE</strong> — Click an asteroid to edit it.
      <span class="edit-screen__pick-hint__sub">Press <kbd>Esc</kbd> or click EDIT OBJECT again to cancel.</span>
    `;
    pickHintEl.classList.remove('edit-screen__pick-hint--hidden');
  }
  function hidePickHint() {
    if (pickHintEl) pickHintEl.classList.add('edit-screen__pick-hint--hidden');
  }
  function flashPickHint(msg) {
    if (!pickHintEl) return;
    const sub = pickHintEl.querySelector('.edit-screen__pick-hint__sub');
    if (sub) {
      const prev = sub.textContent;
      sub.textContent = msg;
      setTimeout(() => { if (sub.textContent === msg) sub.textContent = prev; }, MINI_VIEWPORT_CONFIG.pickHint.flashDurationMs);
    }
  }

  // ===========================================================================
  // UV viewer (lazy-loaded into the sidebar)
  // ===========================================================================

  async  function ensureUvViewer() {
    if (uvViewer) return uvViewer;
    if (uvViewerPromise) return uvViewerPromise;
    const factory = typeof createUvViewer === 'function'
      ? Promise.resolve({ default: createUvViewer })
      : import('./uv-unwrap-viewer.js');
    uvViewerPromise = factory.then((mod) => {
      const ctor = mod.default || mod.createUvUnwrapViewer;
      return ctor({
        canvas: renderer.domElement,
        camera,
        getAsteroids,
      });
    });
    uvViewer = await uvViewerPromise;
    // Subscribe to seam changes so the 3D mini viewport's seam
    // overlay (yellow lines for user seams, red for auto) stays
    // in sync with the 2D UV editor. The listener also drives
    // the seam-count status line in the corner of the mini
    // viewport.
    if (typeof uvViewer.addSeamChangeListener === 'function') {
      miniSeamListenerOff = uvViewer.addSeamChangeListener(() => {
        rebuildSeamOverlay();
        updateSeamHint();
      });
    }
    return uvViewer;
  }

  // ===========================================================================
  // Info box
  // ===========================================================================

  function refreshInfo() {
    if (!infoRowsEl) return;
    if (nameEl) {
      nameEl.textContent = currentEntity ? describeEntity(currentEntity) : 'No object selected';
    }
    if (!currentEntity) {
      infoRowsEl.innerHTML = '<div class="edit-screen__info-empty">No object selected.</div>';
      return;
    }
    const spec = currentEntity.spec;
    const mesh = currentEntity.mesh && currentEntity.mesh.children[0];
    const geom = mesh ? (mesh.isLOD ? mesh.levels[0].object.geometry : mesh.geometry) : null;
    const positionCount = geom && geom.attributes.position ? geom.attributes.position.count : 0;
    const indexCount = geom && geom.index ? geom.index.count : positionCount;
    const triCount = geom ? Math.floor(indexCount / 3) : 0;
    const uvRange = geom && geom.attributes.uv ? computeUvRange(geom) : null;
    const rows = [
      ['Kind', (spec.seed & 1) ? 'capsule' : 'icosphere'],
      ['ID', String(spec.id || '?')],
      ['Radius', spec.radius != null ? spec.radius.toFixed(2) : '—'],
      ['Size', String(spec.size)],
      ['Position', `(${spec.position.x.toFixed(1)}, ${spec.position.y.toFixed(1)}, ${spec.position.z.toFixed(1)})`],
      ['Spin', spec.spin != null ? spec.spin.toFixed(2) : '—'],
      ['Vertices', String(positionCount)],
      ['Triangles', String(triCount)],
      ['UV range', uvRange ? `[${uvRange.minU.toFixed(2)}, ${uvRange.maxU.toFixed(2)}] × [${uvRange.minV.toFixed(2)}, ${uvRange.maxV.toFixed(2)}]` : '—'],
    ];
    infoRowsEl.innerHTML = rows.map(([k, v]) =>
      `<div class="edit-screen__info-row"><span class="edit-screen__info-key">${escapeHtml(k)}</span><span class="edit-screen__info-val">${escapeHtml(v)}</span></div>`,
    ).join('');
  }

  function describeEntity(entity) {
    if (!entity || !entity.spec) return 'Unknown';
    const s = entity.spec;
    const kind = s.seed & 1 ? 'capsule' : 'icosphere';
    return `${kind} #${s.id} (r=${s.radius.toFixed(1)})`;
  }

  function computeUvRange(geom) {
    const uv = geom.attributes.uv.array;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < uv.length / 2; i++) {
      const u = uv[i * 2], v = uv[i * 2 + 1];
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    return { minU, maxU, minV, maxV };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ===========================================================================
  // Keyboard
  // ===========================================================================

  function onKeyDown(e) {
    if (state === 'pick' && e.key === 'Escape') {
      e.preventDefault();
      cancelPick();
    } else if (state === 'edit' && e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  return {
    mount, unmount, dispose,
    beginPick, openFor, close, cancelPick,
    isOpen, isPicking, isMounted, getEntity,
    updateMini,
  };
}
