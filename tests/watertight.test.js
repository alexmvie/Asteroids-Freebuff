import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAsteroidFromSpec } from '../src/entities/asteroid.js';
import { createShip } from '../src/entities/ship.js';
import { createPowerUp } from '../src/entities/powerup.js';
import { buildWatertightCone } from '../src/geometry/watertight-cone.js';

// ---------------------------------------------------------------------------
// v0.72.3 — Watertightness contract for EVERY solid object the game
// produces. The user reported \"manche haben total offene dreiecke\"
// (some have totally open triangles) — every object in the game must
// be watertight.
//
// Root cause found + fixed in this release:
//   1. `displaceGeometry` displaced vertices ALONG THEIR NORMALS. On
//      non-indexed geometry (all icosphere shapes) each vertex copy
//      carries a DIFFERENT face normal, so the copies of one
//      pre-noise position drifted apart — the surface tore open
//      (measured 1500 open boundary edges on a detail-4 spinning
//      top). Fixed: displace along the unit RADIAL direction, which
//      is identical for every coincident copy.
//   2. The indexed Capsule (cratered potato) was closed but its
//      UV-seam wrap column landed ~2e-16 off the base column, so the
//      seam split once displaced. Fixed: `_build` now copies the base
//      vertex's exact position onto the wrap (bit-exact seam).
//   3. THREE.ConeGeometry is NOT watertight (radiusTop=0 collapses to
//      a stack of coincident tip copies + a degenerate cap fan).
//      Ship body + engine glow + powerup `cone` shape now use
//      `buildWatertightCone` (src/geometry/watertight-cone.js).
//
// Definition of watertight (as asserted here): after merging vertices
// that occupy the same world position (within a tiny relative epsilon
// that absorbs sub-float UV-seam drift but is far below any real
// feature size), every undirected edge is shared by an EVEN number of
// triangles (0 boundary / odd-shared edges — a closed surface), there
// are NO degenerate (zero-area) triangles, and no NaN positions.
//
// Why "even" and not "exactly 2": closed indexed meshes that keep a
// UV-seam column (duplicate vertices at the same position, e.g. the
// capsule wrap column) merge those columns to a single geometric edge
// that 4 (or more) triangles share — geometrically closed, renders
// perfectly; only an ODD count (1 = hole, 3 = non-manifold pinch)
// indicates a real problem. (Caveat: an even count > 2 could in
// principle mask a genuine non-manifold pinch, e.g. two cones glued
// along an edge. None of this game's generators produce such
// configurations, and every even-count edge we ship is a UV-seam
// column — verified in the mesh builders.)
//
// Explicit exemptions (decorative, non-solid FX — tagged
// `userData.decorativeFx = true` at their build sites):
//   - power-up halo ring (flat 2D annulus — has 2 boundary loops by
//     design; it is a glow decal, not a solid)
//   - power-up beacon column (open-ended cylinder — a transparent
//     light column, no caps by design)
// ---------------------------------------------------------------------------

/**
 * Analyze a geometry for watertightness.
 * @param {import('three').BufferGeometry} geom
 * @returns {{ boundary: number, odd: number, degenerate: number, nan: number, tris: number }}
 */
function watertightInfo(geom) {
  const pos = geom.attributes.position;
  assert.ok(pos, 'geometry has a position attribute');
  const index = geom.index;
  const n = index ? index.count : pos.count;
  assert.ok(Number.isInteger(n) && n % 3 === 0, `triangle count is integral (n=${n})`);

  // Relative epsilon for vertex merging: 1e-9 of the bounding-box
  // diagonal (floor 1e-7). Absorbs sub-float seam drift (1e-15-ish),
  // far below any real feature (a real gap is > 1e-3 of the radius).
  const box = new THREE.Box3().setFromBufferAttribute(pos);
  const diag = box.getSize(new THREE.Vector3()).length();
  const eps = Math.max(1e-7, diag * 1e-9);
  const inv = 1 / eps;

  const vertId = new Array(n);
  const merged = new Map();
  let nan = 0;
  for (let t = 0; t < n / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const raw = index ? index.getX(t * 3 + k) : t * 3 + k;
      const x = pos.getX(raw);
      const y = pos.getY(raw);
      const z = pos.getZ(raw);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) nan++;
      const key = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      if (!merged.has(key)) merged.set(key, merged.size);
      vertId[t * 3 + k] = merged.get(key);
    }
  }

  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < n / 3; t++) {
    const a = vertId[t * 3];
    const b = vertId[t * 3 + 1];
    const c = vertId[t * 3 + 2];
    if (a === b || b === c || a === c) degenerate++;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }

  let boundary = 0;
  let odd = 0;
  for (const cnt of edges.values()) {
    if (cnt === 1) boundary++;
    if (cnt % 2 === 1) odd++;
  }
  return { boundary, odd, degenerate, nan, tris: n / 3 };
}

function assertWatertight(geom, label) {
  const info = watertightInfo(geom);
  assert.equal(info.nan, 0, `${label}: no NaN vertices`);
  assert.equal(info.boundary, 0, `${label}: 0 open boundary edges (got ${info.boundary})`);
  assert.equal(info.odd, 0, `${label}: 0 odd-shared edges — closed manifold (got ${info.odd})`);
  assert.equal(info.degenerate, 0, `${label}: 0 degenerate triangles (got ${info.degenerate})`);
}

/** Walk every solid mesh under `root` (skipping decorative FX) and assert watertight. */
function assertAllWatertight(root, label) {
  let meshesChecked = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (o.userData?.decorativeFx) return; // 2D/additive FX: exempt by design
    assertWatertight(o.geometry, `${label} mesh`);
    meshesChecked++;
  });
  assert.ok(meshesChecked >= 1, `${label}: at least one solid mesh checked`);
}

// ---- Asteroids: all 5 shapes × all LOD levels ---------------------------

const ASTEROID_SHAPES = [
  'spinning_top',
  'cratered_potato',
  'rubble_pile',
  'elongated_potato',
  'craggy_rock',
];

test('Watertight: every asteroid shape × LOD level is watertight (the v0.72.3 fix)', () => {
  const scene = new THREE.Scene();
  let meshes = 0;
  for (const shape of ASTEROID_SHAPES) {
    const spec = {
      id: `wt-${shape}`,
      position: { x: 0, y: 0, z: 0 },
      radius: 8,
      size: 0,
      axis: { x: 0, y: 1, z: 0 },
      spin: 0.3,
      velocity: { x: 0, y: 0, z: 0 },
      seed: 4242,
      shape,
    };
    const entity = createAsteroidFromSpec({ spec, scene });
    entity.mesh.traverse((o) => {
      if (o.isMesh && o.geometry) {
        assertWatertight(o.geometry, `${shape} LOD`);
        meshes++;
      }
    });
    entity.dispose();
  }
  assert.ok(meshes >= 3 * ASTEROID_SHAPES.length, `all LOD levels checked (${meshes} meshes)`);
});

test('Watertight: rubble pile lobes (per-lobe icospheres) are watertight', () => {
  const scene = new THREE.Scene();
  const spec = {
    id: 'wt-rubble',
    position: { x: 0, y: 0, z: 0 },
    radius: 8,
    size: 0,
    axis: { x: 0, y: 1, z: 0 },
    spin: 0.3,
    velocity: { x: 0, y: 0, z: 0 },
    seed: 1337,
    shape: 'rubble_pile',
  };
  const entity = createAsteroidFromSpec({ spec, scene });
  assertAllWatertight(entity.mesh, 'rubble pile');
  entity.dispose();
});

// ---- Ship ---------------------------------------------------------------

test('Watertight: ship body + wings + engine glow are watertight', () => {
  const scene = new THREE.Scene();
  const ship = createShip({ scene, position: { x: 0, y: 0, z: 0 } });
  assertAllWatertight(ship.mesh, 'ship');
  ship.dispose();
});

// ---- Power-ups (procedural fallback bodies) -----------------------------

const POWERUP_TYPES = ['shield', 'speed', 'energy', 'credits', 'hull', 'weapon'];

test('Watertight: every power-up procedural body is watertight (halo ring + beacon FX exempt)', () => {
  const scene = new THREE.Scene();
  for (const type of POWERUP_TYPES) {
    const powerup = createPowerUp({
      scene,
      spec: { type, position: { x: 0, y: 0, z: 0 }, lifetime: Infinity },
    });
    const root = powerup.mesh || powerup.group;
    assert.ok(root, `${type} has a root`);
    assertAllWatertight(root, `powerup ${type}`);
    if (typeof powerup.dispose === 'function') powerup.dispose();
    else scene.remove(root);
  }
});

test('Watertight: power-up halo ring + beacon are explicitly tagged decorativeFx', () => {
  const scene = new THREE.Scene();
  const powerup = createPowerUp({
    scene,
    spec: { type: 'shield', position: { x: 0, y: 0, z: 0 }, lifetime: Infinity },
  });
  const root = powerup.mesh || powerup.group;
  const tagged = [];
  root.traverse((o) => {
    if (o.isMesh && o.userData?.decorativeFx) tagged.push(o);
  });
  // Shield = icosahedron body + halo ring + beacon column → 2 FX meshes.
  assert.ok(tagged.length >= 2, `halo ring + beacon tagged (got ${tagged.length})`);
  if (typeof powerup.dispose === 'function') powerup.dispose();
  else scene.remove(root);
});

// ---- buildWatertightCone ------------------------------------------------

test('Watertight: buildWatertightCone is strictly watertight (no THREE.ConeGeometry degeneracy)', () => {
  for (const segments of [3, 4, 8, 16]) {
    const geom = buildWatertightCone(1.0, 2.5, segments);
    assertWatertight(geom, `cone ${segments}`);
    // Vertex budget: 1 tip + 1 base center + segments rim (no dupes).
    assert.equal(geom.attributes.position.count, segments + 2, 'no duplicate vertex column');
    assert.equal(geom.index.count, segments * 6, 'segments side tris + segments base tris');
  }
  assert.throws(() => buildWatertightCone(1, 1, 2), /radialSegments/);
});

test('Watertight: buildWatertightCone winding — sides face outward, base faces -Y', () => {
  const geom = buildWatertightCone(1.0, 2.5, 4);
  const pos = geom.attributes.position;
  const idx = geom.index;
  const normalOf = (i0, i1, i2) =>
    new THREE.Vector3().fromBufferAttribute(pos, i1)
      .sub(new THREE.Vector3().fromBufferAttribute(pos, i0))
      .cross(
        new THREE.Vector3().fromBufferAttribute(pos, i2)
          .sub(new THREE.Vector3().fromBufferAttribute(pos, i0)),
      )
      .normalize();

  // Side triangle 0 = (tip, rim[1], rim[0]) spans the 0°..90° quadrant;
  // its outward normal must point into that quadrant (x>0, z>0, y>0).
  const side = normalOf(idx.getX(0), idx.getX(1), idx.getX(2));
  assert.ok(side.x > 0.5 && side.z > 0.5 && side.y > 0, `side normal outward: ${side.toArray()}`);

  // Base triangle 0 = (center, rim[0], rim[1]) — index slots 3..5
  // (the loop interleaves side0, base0, side1, base1, ...). Faces -Y.
  const base = normalOf(idx.getX(3), idx.getX(4), idx.getX(5));
  assert.ok(Math.abs(base.x) < 1e-6 && base.y < -0.99 && Math.abs(base.z) < 1e-6,
    `base normal faces -Y: ${base.toArray()}`);
});
