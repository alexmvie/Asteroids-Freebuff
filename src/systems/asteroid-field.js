/**
 * Asteroid field — wraps the world streaming layer with entity lifecycle
 * (spawn Three.js meshes for new chunks, dispose meshes for evicted chunks).
 *
 * Owns:
 *   - `world`           — the data-model streaming layer (createWorld)
 *   - `entities[]`      — live asteroid entities (Three.js Groups)
 *   - `entityByChunkKey` — Map<chunkKey, entity[]> for O(1) eviction
 *   - `streamTimeS`     — wall-clock accumulator for TTL
 *
 * Public API:
 *   - `field.update(shipPos, dt, camera)`  — streaming + per-asteroid LOD update
 *   - `field.clearAll()`                    — wipe the field (game restart)
 *   - `field.getEntities()`                 — read-only ref to the entity array
 *   - `field.getWorld()`                    — the world object (for powerupSystem, debug HUD)
 *
 * @param {{
 *   scene: import('three').Scene,
 *   uvDebugOverlay: { attach: (entity: any) => void },
 *   systemSeed?: number,
 * }} opts
 */

import { createAsteroidFromSpec } from '../entities/asteroid.js';
import {
  INITIAL_SYSTEM_SEED,
  createWorld,
  chunkKey,
  updateStreamingBubble,
  evictStaleChunks,
} from '../world/index.js';

export function createAsteroidField({
  scene,
  uvDebugOverlay,
  systemSeed = INITIAL_SYSTEM_SEED,
} = {}) {
  if (!scene) throw new Error('createAsteroidField: `scene` is required');

  // ---- World layer ----------------------------------------------------
  const world = createWorld({ systemSeed });

  // ---- Entity state ---------------------------------------------------
  const entities = [];
  const entityByChunkKey = new Map();
  let streamTimeS = 0;

  // ---- Spawn / despawn helpers ----------------------------------------

  /**
   * Spawn meshes for every asteroid spec in `chunks` and register
   * them under the chunk's Map key. Idempotent: if the chunk's key
   * is already in `entityByChunkKey`, the new spawn is skipped.
   */
  function spawnChunkEntities(chunks) {
    for (const chunk of chunks) {
      const key = chunkKey(chunk.id.cx, chunk.id.cz);
      if (entityByChunkKey.has(key)) continue;
      const batch = [];
      for (const spec of chunk.asteroids) {
        const entity = createAsteroidFromSpec({ spec, scene, uvDebugOverlay });
        entities.push(entity);
        batch.push(entity);
      }
      entityByChunkKey.set(key, batch);
    }
  }

  /**
   * Despawn the meshes for every asteroid in `chunks` and unregister
   * the chunks from `entityByChunkKey`. Uses reverse-order splice
   * so removing items from the middle of `entities` doesn't shift
   * the indices of the remaining removals.
   */
  function despawnChunkEntities(chunks) {
    for (const chunk of chunks) {
      const key = chunkKey(chunk.id.cx, chunk.id.cz);
      const batch = entityByChunkKey.get(key);
      if (!batch) continue;
      const indices = [];
      for (const entity of batch) {
        const idx = entities.indexOf(entity);
        if (idx >= 0) indices.push(idx);
      }
      indices.sort((a, b) => b - a);
      for (const idx of indices) {
        entities[idx].dispose();
        entities.splice(idx, 1);
      }
      entityByChunkKey.delete(key);
    }
  }

  // ---- Public API -----------------------------------------------------

  /**
   * Per-frame update. Advances streaming, spawns/despawns entities,
   * and calls each asteroid's LOD update.
   *
   * @param {{x:number,y:number,z:number}} shipPos
   * @param {number} dt
   * @param {import('three').Camera} camera
   */
  function update(shipPos, dt, camera) {
    streamTimeS += dt;
    const delta = updateStreamingBubble(world, shipPos, streamTimeS);
    spawnChunkEntities(delta.added);
    spawnChunkEntities(delta.reactivated);
    despawnChunkEntities(delta.evicted);
    evictStaleChunks(world, streamTimeS);

    for (const a of entities) a.update(dt, camera);
  }

  /** Wipe the entire field. Next update() repopulates from scratch. */
  function clearAll() {
    for (const batch of entityByChunkKey.values()) {
      for (const entity of batch) {
        entity.dispose();
      }
    }
    entities.length = 0;
    entityByChunkKey.clear();
    world.active.clear();
    world.recentlyGone.clear();
    streamTimeS = 0;
  }

  function getEntities() { return entities; }
  function getWorld() { return world; }

  return { update, clearAll, getEntities, getWorld };
}
