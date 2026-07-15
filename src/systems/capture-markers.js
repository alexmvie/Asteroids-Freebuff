/**
 * Capture markers — high-contrast visual overlays for video analysis.
 *
 * Adds bright, easily-detectable markers to the active ship, every
 * asteroid, and the pending power-up so that frame-analysis scripts
 * (scripts/analyze_frames.py) can locate objects with simple color
 * thresholding instead of relying on motion/brightness heuristics.
 *
 *   - Ship: large green wireframe ring on the play plane
 *   - Asteroids: red wireframe spheres (slightly larger than the rock)
 *   - Powerup: large yellow wireframe ring on the play plane
 *
 * The markers are toggled at runtime via `window.CAPTURE_MARKERS`.
 * When disabled, the helper removes its meshes from the scene and
 * releases their geometry/material.
 *
 * Public API:
 *   createCaptureMarkers({ scene }) → { setEnabled, isEnabled, update }
 *
 * @param {{ scene: import('three').Scene }} opts
 */

import * as THREE from 'three';

export function createCaptureMarkers({ scene } = {}) {
  if (!scene) throw new Error('createCaptureMarkers: scene is required');

  let enabled = false;
  let group = new THREE.Group();
  group.name = 'capture-markers';
  scene.add(group);

  // Reusable materials.
  const shipMat = new THREE.MeshBasicMaterial({
    color: 0x00ff00,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const asteroidMat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    wireframe: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const powerupMat = new THREE.MeshBasicMaterial({
    color: 0xffff00,
    wireframe: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });

  // Object pools keyed by type. We reuse meshes/geometry across frames.
  // Cap pool sizes to avoid unbounded growth in dense asteroid fields.
  const MAX_POOL_SIZES = {
    ship: 1,
    asteroid: 64,
    powerup: 1,
  };
  const pools = {
    ship: [],
    asteroid: [],
    powerup: [],
  };

  function acquire(type, factory) {
    const pool = pools[type];
    for (let i = 0; i < pool.length; i++) {
      const item = pool[i];
      if (!item.userData.inUse) {
        item.userData.inUse = true;
        item.visible = true;
        return item;
      }
    }
    if (pool.length >= MAX_POOL_SIZES[type]) {
      // Pool exhausted for this frame; reuse the oldest unused mesh.
      // Because we always scan from the front, the first unused item we
      // would have returned above is guaranteed not to exist, so we fall
      // back to reusing the oldest mesh in the pool. Rotate the pool so
      // the reused item moves to the end and gets a fair turn next time.
      const item = pool.shift();
      item.userData.inUse = true;
      item.visible = true;
      pool.push(item);
      return item;
    }
    const item = factory();
    item.userData.inUse = true;
    item.visible = true;
    group.add(item);
    pool.push(item);
    return item;
  }

  function resetPool(type) {
    for (const item of pools[type]) {
      item.userData.inUse = false;
      item.visible = false;
    }
  }

  function clear() {
    resetPool('ship');
    resetPool('asteroid');
    resetPool('powerup');
  }

  function setEnabled(v) {
    enabled = !!v;
    group.visible = enabled;
    if (!enabled) clear();
  }

  function isEnabled() {
    return enabled;
  }

  /**
   * Update the markers for the current frame.
   * @param {{
   *   subject: { position: {x,y,z}, rotation?: {yaw:number} } | null,
   *   asteroids: Array<{ getPosition: () => {x,y,z}, getRadius: () => number }>,
   *   powerup: { getPosition: () => {x,y,z}, getRadius: () => number } | null,
   * }} params
   */
  function update({ subject, asteroids, powerup }) {
    if (!enabled) return;

    // Mark all as unused, then re-acquire as needed.
    clear();

    // Ship marker: green ring on the play plane, radius 6u.
    if (subject && subject.position) {
      const ring = acquire('ship', () => {
        const geom = new THREE.RingGeometry(4, 6, 32);
        const mesh = new THREE.Mesh(geom, shipMat);
        mesh.rotation.x = -Math.PI / 2;
        return mesh;
      });
      ring.position.set(subject.position.x, 0.05, subject.position.z);
    }

    // Asteroid markers: red wireframe spheres.
    if (asteroids) {
      for (const a of asteroids) {
        if (!a || typeof a.getPosition !== 'function') continue;
        const p = a.getPosition();
        const r = typeof a.getRadius === 'function' ? a.getRadius() : 4;
        const mesh = acquire('asteroid', () => {
          const geom = new THREE.IcosahedronGeometry(1, 1);
          const m = new THREE.Mesh(geom, asteroidMat);
          return m;
        });
        mesh.scale.setScalar(r * 1.2);
        mesh.position.set(p.x, p.y, p.z);
      }
    }

    // Powerup marker: yellow ring on the play plane.
    if (powerup && typeof powerup.getPosition === 'function') {
      const p = powerup.getPosition();
      const r = typeof powerup.getRadius === 'function' ? powerup.getRadius() : 1.5;
      const ring = acquire('powerup', () => {
        const geom = new THREE.RingGeometry(1.5, 2.5, 32);
        const m = new THREE.Mesh(geom, powerupMat);
        m.rotation.x = -Math.PI / 2;
        return m;
      });
      ring.scale.setScalar(r);
      ring.position.set(p.x, 0.05, p.z);
    }
  }

  function dispose() {
    clear();
    for (const type of Object.keys(pools)) {
      for (const item of pools[type]) {
        if (item.geometry) item.geometry.dispose();
      }
      pools[type].length = 0;
    }
    shipMat.dispose();
    asteroidMat.dispose();
    powerupMat.dispose();
    scene.remove(group);
  }

  return { setEnabled, isEnabled, update, dispose };
}
