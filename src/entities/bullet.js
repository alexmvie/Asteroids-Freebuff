import { Color, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';

/**
 * Bullet pool — a fixed-size pool of Three.js meshes that are reused on
 * fire. No allocations in the hot path. Designed to be cheap to spin up
 * and tear down.
 *
 * Tunables (inline; extract to src/entities/constants.js later):
 *   - `POOL_CAPACITY`        max simultaneous live bullets (default 64)
 *   - `BULLET_LIFETIME_S`    seconds before despawn (default 1.5)
 *   - `FIRE_COOLDOWN_S`      seconds between fires (default 0.18)
 *   - `BULLET_RADIUS`        collision radius (for narrow-phase; default 0.15)
 *
 * Public API:
 *   - `bullets.fire({ origin, direction, speed? })` → fired bullet index, or
 *     `-1` if on cooldown, no inactive slot, or missing args.
 *   - `bullets.update(dt)`            advance physics + despawn by lifetime
 *   - `bullets.dispose()`             release geometry + material + meshes
 *   - `bullets.getActiveCount()`      number of live bullets right now
 *   - `bullets.getCapacity()`         pool size
 *   - `bullets.forEachActive(fn)`     iterate over live bullets
 *
 * @param {{ scene: import('three').Scene, capacity?: number }} opts
 */
export function createBulletPool({ scene, capacity = 64 } = {}) {
  if (!scene) throw new Error('createBulletPool: `scene` is required');
  if (capacity < 1) throw new Error('createBulletPool: `capacity` must be >= 1');

  // ---- Tunables --------------------------------------------------------
  const BULLET_LIFETIME_S = 1.5;
  const FIRE_COOLDOWN_S = 0.18;
  const BULLET_RADIUS = 0.15;
  const BULLET_COLOR = 0xfff3a0;

  // ---- Shared mesh resources (one geometry + one material for the whole pool)
  const geometry = new SphereGeometry(BULLET_RADIUS, 8, 6);
  const material = new MeshBasicMaterial({
    color: new Color(BULLET_COLOR),
    toneMapped: false, // pop against the dark background
  });

  // ---- Pre-allocate the pool ------------------------------------------
  const pool = new Array(capacity);
  for (let i = 0; i < capacity; i++) {
    const mesh = new Mesh(geometry, material);
    mesh.visible = false;
    scene.add(mesh);
    pool[i] = {
      index: i,
      mesh,
      active: false,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      age: 0,
      lifetime: 0,
    };
  }

  // ---- Cooldown state -------------------------------------------------
  let cooldownRemaining = 0;

  // ---- Helpers --------------------------------------------------------
  function findInactive() {
    for (let i = 0; i < pool.length; i++) {
      if (!pool[i].active) return i;
    }
    return -1;
  }

  /**
   * Fire a bullet. Returns the bullet's index in the pool on success, or
   * `-1` if the fire was rejected (cooldown, no free slot, missing args,
   * zero-length direction).
   *
   * @param {{
   *   origin: { x: number, y: number, z: number },
   *   direction: { x: number, y: number, z: number },
   *   speed?: number,
   * }} opts
   * @returns {number}
   */
  function fire({ origin, direction, speed = 400 } = {}) {
    if (cooldownRemaining > 0) return -1;
    if (!origin || typeof origin.x !== 'number') return -1;
    if (!direction || typeof direction.x !== 'number') return -1;

    const len = Math.hypot(direction.x, direction.y, direction.z);
    if (len < 1e-6) return -1;

    const idx = findInactive();
    if (idx < 0) return -1; // pool exhausted

    const inv = 1 / len;
    const b = pool[idx];
    b.active = true;
    b.position.x = origin.x;
    b.position.y = origin.y;
    b.position.z = origin.z;
    b.velocity.x = direction.x * inv * speed;
    b.velocity.y = direction.y * inv * speed;
    b.velocity.z = direction.z * inv * speed;
    b.age = 0;
    b.lifetime = BULLET_LIFETIME_S;
    b.mesh.position.set(b.position.x, b.position.y, b.position.z);
    b.mesh.visible = true;

    cooldownRemaining = FIRE_COOLDOWN_S;
    return idx;
  }

  /**
   * Advance physics for all active bullets. `dt` in seconds.
   * Despawns bullets whose age exceeds their lifetime.
   * @param {number} dt
   */
  function update(dt) {
    if (dt <= 0) return;

    if (cooldownRemaining > 0) {
      cooldownRemaining = Math.max(0, cooldownRemaining - dt);
    }

    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (!b.active) continue;

      b.age += dt;
      if (b.age >= b.lifetime) {
        b.active = false;
        b.mesh.visible = false;
        continue;
      }

      b.position.x += b.velocity.x * dt;
      b.position.y += b.velocity.y * dt;
      b.position.z += b.velocity.z * dt;
      b.mesh.position.set(b.position.x, b.position.y, b.position.z);
    }
  }

  /**
   * Manually despawn a bullet (e.g. on collision). The slot becomes
   * available for re-use on the next `fire()`. Out-of-range indices
   * are silently ignored.
   * @param {number} index
   */
  function despawn(index) {
    if (typeof index !== 'number') return;
    if (index < 0 || index >= pool.length) return;
    const b = pool[index];
    b.active = false;
    b.mesh.visible = false;
  }

  /**
   * Release all resources. After dispose, the pool is empty and the
   * pool object should not be used.
   */
  function dispose() {
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      b.active = false;
      b.mesh.visible = false;
      scene.remove(b.mesh);
    }
    geometry.dispose();
    material.dispose();
  }

  function getActiveCount() {
    let n = 0;
    for (let i = 0; i < pool.length; i++) if (pool[i].active) n++;
    return n;
  }

  function getCapacity() {
    return pool.length;
  }

  /**
   * Iterate over currently-live bullets. `fn(bullet, index)`.
   * @param {(b: any, i: number) => void} fn
   */
  function forEachActive(fn) {
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].active) fn(pool[i], i);
    }
  }

  return {
    fire,
    update,
    dispose,
    despawn,
    getActiveCount,
    getCapacity,
    forEachActive,
  };
}
