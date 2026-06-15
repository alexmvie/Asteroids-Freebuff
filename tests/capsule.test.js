import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Capsule } from '../src/geometry/capsule.js';
import { mulberry32 } from '../src/world/rng.js';

const DEFAULTS = { radius: 1, length: 1, capSegments: 4, radialSegments: 8 };

test('Capsule: vertex count matches expected (2 body rings + 2 caps + 2 poles)', () => {
  const { radius, length, capSegments, radialSegments } = DEFAULTS;
  const geom = new Capsule(radius, length, capSegments, radialSegments);
  // body: 2 * (radialSegments + 1)
  // top cap: (capSegments - 1) * (radialSegments + 1) + 1
  // bottom cap: same
  const expected =
    2 * (radialSegments + 1) +
    2 * ((capSegments - 1) * (radialSegments + 1) + 1);
  assert.equal(geom.attributes.position.count, expected);
});

test('Capsule: index buffer is populated (indexed geometry)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  assert.ok(geom.index, 'Capsule should have an index buffer');
  assert.ok(geom.index.count > 0);
});

test('Capsule: position attribute is 3D (itemSize = 3)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  assert.equal(geom.attributes.position.itemSize, 3);
});

test('Capsule: pole vertices are at the cap tips (top and bottom)', () => {
  const radius = 2;
  const length = 3;
  const geom = new Capsule(radius, length, 4, 8);
  const positions = geom.attributes.position;
  // Find the pole vertices by their extreme y values (the highest y
  // is the top pole, the lowest y is the bottom pole). Robust against
  // changes in the vertex layout.
  let topPoleIdx = 0;
  let bottomPoleIdx = 0;
  let maxY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    if (y > maxY) { maxY = y; topPoleIdx = i; }
    if (y < minY) { minY = y; bottomPoleIdx = i; }
  }
  const topPole = {
    x: positions.getX(topPoleIdx),
    y: positions.getY(topPoleIdx),
    z: positions.getZ(topPoleIdx),
  };
  const bottomPole = {
    x: positions.getX(bottomPoleIdx),
    y: positions.getY(bottomPoleIdx),
    z: positions.getZ(bottomPoleIdx),
  };
  // Top pole should be at (0, +length/2 + radius, 0)
  assert.ok(Math.abs(topPole.x) < 1e-6, `topPole.x = ${topPole.x}, expected 0`);
  assert.ok(Math.abs(topPole.y - (length / 2 + radius)) < 1e-6, `topPole.y = ${topPole.y}, expected ${length / 2 + radius}`);
  assert.ok(Math.abs(topPole.z) < 1e-6, `topPole.z = ${topPole.z}, expected 0`);
  // Bottom pole should be at (0, -length/2 - radius, 0)
  assert.ok(Math.abs(bottomPole.x) < 1e-6, `bottomPole.x = ${bottomPole.x}, expected 0`);
  assert.ok(Math.abs(bottomPole.y - (-length / 2 - radius)) < 1e-6, `bottomPole.y = ${bottomPole.y}, expected ${-length / 2 - radius}`);
  assert.ok(Math.abs(bottomPole.z) < 1e-6, `bottomPole.z = ${bottomPole.z}, expected 0`);
});

test('Capsule: body ring vertices are at the cylinder radius', () => {
  const radius = 5;
  const length = 2;
  const radialSegments = 8;
  const geom = new Capsule(radius, length, 4, radialSegments);
  const positions = geom.attributes.position;
  // First ring (bottom) is at indices 0..radialSegments, all at y = -length/2
  for (let ix = 0; ix <= radialSegments; ix++) {
    const x = positions.getX(ix);
    const y = positions.getY(ix);
    const z = positions.getZ(ix);
    const r = Math.sqrt(x * x + z * z);
    assert.ok(Math.abs(r - radius) < 1e-5, `ring vertex ${ix} at r=${r}, expected ${radius}`);
    assert.ok(Math.abs(y - (-length / 2)) < 1e-6, `ring vertex ${ix} at y=${y}, expected ${-length / 2}`);
  }
});

test('Capsule: jitter preserves the vertex count (no duplicates created)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  const countBefore = geom.attributes.position.count;
  geom.jitter(0.1, () => Math.random());
  assert.equal(geom.attributes.position.count, countBefore);
});

test('Capsule: jitter does not change the index buffer (shared topology preserved)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  const indicesBefore = Array.from(geom.index.array);
  geom.jitter(0.1, () => Math.random());
  const indicesAfter = Array.from(geom.index.array);
  assert.deepEqual(indicesAfter, indicesBefore);
});

test('Capsule: jitter offsets each vertex along its normal by (rng*2-1)*amount', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  // Snapshot original positions and normals
  const positions = geom.attributes.position;
  const normals = geom.attributes.normal;
  const original = [];
  for (let i = 0; i < positions.count; i++) {
    original.push({
      x: positions.getX(i),
      y: positions.getY(i),
      z: positions.getZ(i),
      nx: normals.getX(i),
      ny: normals.getY(i),
      nz: normals.getZ(i),
    });
  }
  const amount = 0.3;
  const { radialSegments, capSegments } = DEFAULTS;
  const ringSize = radialSegments + 1;
  const totalRings = 2 * capSegments;
  // Wrap indices — the +1 offset for r > capSegments accounts for
  // the top pole at index 2*ringSize + (capSegments-1)*ringSize
  // (see the comment in "jitter syncs the UV-seam wrap vertex" below).
  const wrapIndices = new Set();
  for (let r = 0; r < totalRings; r++) {
    const ringStart = r * ringSize + (r > capSegments ? 1 : 0);
    wrapIndices.add(ringStart + radialSegments);
  }
  // rng=0 → offset = -amount along each normal
  geom.jitter(amount, () => 0);
  for (let i = 0; i < positions.count; i++) {
    // Wrap vertices share ix=0's offset (so the UV seam stays closed).
    // Their position is original[ix=0] + amount * normal[ix=0], not
    // original[i] + amount * normal[i]. Skip them here; they're
    // covered by the dedicated "jitter syncs the UV-seam wrap
    // vertex" test.
    if (wrapIndices.has(i)) continue;
    const o = original[i];
    const dx = positions.getX(i) - o.x;
    const dy = positions.getY(i) - o.y;
    const dz = positions.getZ(i) - o.z;
    assert.ok(Math.abs(dx - (-amount * o.nx)) < 1e-5, `vertex ${i} x offset wrong: ${dx}, expected ${-amount * o.nx}`);
    assert.ok(Math.abs(dy - (-amount * o.ny)) < 1e-5, `vertex ${i} y offset wrong: ${dy}, expected ${-amount * o.ny}`);
    assert.ok(Math.abs(dz - (-amount * o.nz)) < 1e-5, `vertex ${i} z offset wrong: ${dz}, expected ${-amount * o.nz}`);
  }
});

test('Capsule: jitter with rng=0.5 leaves vertices unchanged (offset = 0)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  const original = [];
  for (let i = 0; i < geom.attributes.position.count; i++) {
    original.push({
      x: geom.attributes.position.getX(i),
      y: geom.attributes.position.getY(i),
      z: geom.attributes.position.getZ(i),
    });
  }
  geom.jitter(0.5, () => 0.5);
  // With rng=0.5, offset=0 for every vertex, so positions are
  // unchanged. Wrap vertices already share their position with
  // ix=0 in the un-jittered geometry, so the post-jitter state
  // matches the pre-jitter state.
  for (let i = 0; i < geom.attributes.position.count; i++) {
    assert.ok(Math.abs(geom.attributes.position.getX(i) - original[i].x) < 1e-6);
    assert.ok(Math.abs(geom.attributes.position.getY(i) - original[i].y) < 1e-6);
    assert.ok(Math.abs(geom.attributes.position.getZ(i) - original[i].z) < 1e-6);
  }
});

test('Capsule: jitter with rng=1 moves vertices in the +normal direction by `amount`', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  const positions = geom.attributes.position;
  const normals = geom.attributes.normal;
  const original = [];
  for (let i = 0; i < positions.count; i++) {
    original.push({
      x: positions.getX(i),
      y: positions.getY(i),
      z: positions.getZ(i),
      nx: normals.getX(i),
      ny: normals.getY(i),
      nz: normals.getZ(i),
    });
  }
  const amount = 0.2;
  const { radialSegments, capSegments } = DEFAULTS;
  const ringSize = radialSegments + 1;
  const totalRings = 2 * capSegments;
  // Wrap indices — the +1 offset for r > capSegments accounts for
  // the top pole at index 2*ringSize + (capSegments-1)*ringSize
  // (see the comment in "jitter syncs the UV-seam wrap vertex" below).
  const wrapIndices = new Set();
  for (let r = 0; r < totalRings; r++) {
    const ringStart = r * ringSize + (r > capSegments ? 1 : 0);
    wrapIndices.add(ringStart + radialSegments);
  }
  geom.jitter(amount, () => 1); // offset = +amount along normal
  for (let i = 0; i < positions.count; i++) {
    if (wrapIndices.has(i)) continue; // covered by the dedicated wrap-seam test
    const o = original[i];
    assert.ok(Math.abs(positions.getX(i) - (o.x + amount * o.nx)) < 1e-5);
    assert.ok(Math.abs(positions.getY(i) - (o.y + amount * o.ny)) < 1e-5);
    assert.ok(Math.abs(positions.getZ(i) - (o.z + amount * o.nz)) < 1e-5);
  }
});

test('Capsule: all vertices are finite after jitter (no NaN / Infinity)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  geom.jitter(0.5, () => Math.random());
  for (let i = 0; i < geom.attributes.position.count; i++) {
    assert.ok(Number.isFinite(geom.attributes.position.getX(i)), `vertex ${i} x is not finite`);
    assert.ok(Number.isFinite(geom.attributes.position.getY(i)), `vertex ${i} y is not finite`);
    assert.ok(Number.isFinite(geom.attributes.position.getZ(i)), `vertex ${i} z is not finite`);
  }
});

test('Capsule: normals are recomputed after jitter (attribute exists and is unit-ish)', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  geom.jitter(0.2, () => Math.random());
  const normals = geom.attributes.normal;
  assert.ok(normals, 'normal attribute should exist after jitter');
  assert.equal(normals.count, geom.attributes.position.count);
  // Spot-check: most normals should be roughly unit length (allow jitter-induced variation)
  for (let i = 0; i < normals.count; i += 7) {
    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    assert.ok(len > 0.5 && len < 1.5, `normal ${i} length ${len} not near unit`);
  }
});

test('Capsule: handles degenerate (zero) length (body collapses to a sphere)', () => {
  const geom = new Capsule(1, 0, 4, 8);
  // No crash, all vertices finite
  for (let i = 0; i < geom.attributes.position.count; i++) {
    assert.ok(Number.isFinite(geom.attributes.position.getX(i)));
    assert.ok(Number.isFinite(geom.attributes.position.getY(i)));
    assert.ok(Number.isFinite(geom.attributes.position.getZ(i)));
  }
});

test('Capsule: different parameter combinations all build without error', () => {
  // Sweep a few combinations
  for (const capSegments of [2, 4, 6]) {
    for (const radialSegments of [4, 8, 16]) {
      const g = new Capsule(1, 1, capSegments, radialSegments);
      assert.ok(g.attributes.position.count > 0);
      assert.ok(g.index.count > 0);
    }
  }
});

// ---------------------------------------------------------------------------
// "No visible holes" regression test for the capsule jitter.
//
// The capsule uses merged (indexed) vertices, and `jitter` moves each
// vertex along its local z axis (the surface normal). The index buffer
// is never modified, so the surface stays connected — there are no
// holes, no gaps, and the topology is preserved. The remaining concern
// is back-facing triangles: a back-facing triangle is invisible with
// back-face culling, which would appear as a hole from the outside.
//
// With a clean normal-direction displacement, the body-to-cap transition
// triangles are not the vulnerability they used to be — the cap vertex
// moves along a vector with a small Y component, and the body vertex
// moves purely radially. The relative Y shift between the two is bounded
// by `amount × 0.383` (the cap normal's Y component magnitude), so the
// centroid's Y component is far from zero for any reasonable jitter
// amount. Empirically (see scripts/probe.mjs), 15% jitter (the
// production value) produces 0 back-facing triangles out of 128.
//
// The checks below assert that:
//   - no triangle is degenerate (zero area)
//   - no triangle is back-facing (cos(angle) > 0 for every face)
// The tripwire test asserts that an extreme multiplier DOES flip
// faces, so the tripwire stays calibrated if the geometry ever
// regresses.
//
// Note on the capsule's topology: the capsule has wrap vertices
// (radialSegments+1 vertices per ring) to give a clean UV seam. This
// means the wrap edge is shared by exactly 1 quad — that's a valid
// closed-mesh-with-seam topology, NOT a hole.
//
// Note on RNG: the tests use `mulberry32` (the project's own RNG,
// see src/world/rng.js) with seed 0xC0FFEE. mulberry32 is the same
// RNG used by the production code in src/entities/asteroid.js, so
// the test jitter sequence matches the production jitter sequence
// (modulo the seed, which is hardcoded here for determinism). If
// mulberry32's implementation ever changes, the worst-case jitter
// values will change too, and "safe" jitter amounts may start
// failing.
// ---------------------------------------------------------------------------

const PROD_JITTER_FRACTION = 0.15; // must match src/entities/asteroid.js

function triangulate(capsule) {
  // Build a list of { a, b, c, normal } for every triangle. `normal` is
  // the geometric face normal (NOT the vertex normal) computed from the
  // post-jitter vertex positions.
  const idx = capsule.index.array;
  const pos = capsule.attributes.position;
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    const ia = idx[i], ib = idx[i + 1], ic = idx[i + 2];
    const ax = pos.getX(ia), ay = pos.getY(ia), az = pos.getZ(ia);
    const bx = pos.getX(ib), by = pos.getY(ib), bz = pos.getZ(ib);
    const cx = pos.getX(ic), cy = pos.getY(ic), cz = pos.getZ(ic);
    // (b - a) × (c - a)
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    out.push({
      ax, ay, az, bx, by, bz, cx, cy, cz,
      nx: uy * vz - uz * vy,
      ny: uz * vx - ux * vz,
      nz: ux * vy - uy * vx,
    });
  }
  return out;
}

test('Capsule: jitter at production amount (15%) creates no degenerate (zero-area) triangles', () => {
  const radius = 1;
  const length = 1.5;
  const geom = new Capsule(radius, length, 4, 8);
  const rng = mulberry32(0xC0FFEE);
  geom.jitter(radius * PROD_JITTER_FRACTION, rng);
  const tris = triangulate(geom);
  assert.ok(tris.length > 0);
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const len2 = t.nx * t.nx + t.ny * t.ny + t.nz * t.nz;
    assert.ok(len2 > 1e-6, `triangle ${i} is degenerate (normal length² = ${len2})`);
  }
});

test('Capsule: jitter at production amount (15%) creates no back-facing triangles (no visible holes)', () => {
  // With merged-vertex topology and normal-direction displacement,
  // there are no holes by construction. The remaining concern is
  // back-facing triangles: a back-facing triangle is invisible with
  // back-face culling, which would appear as a hole from the outside.
  //
  // The check: the geometric face normal (normalized) must agree with
  // the radial direction at the centroid (cos(angle) > 0) for every
  // triangle. The face normal is normalized first — small pole
  // triangles have small normal magnitudes, so dividing by |normal|
  // is required to get the true cosine.
  //
  // With the clean normal-direction displacement (see
  // src/geometry/capsule.js), the body-to-cap transition triangles
  // are NOT the vulnerability they used to be. The cap vertex's
  // normal has a small Y component (~0.383 for default params), and
  // the body vertex's normal is purely radial. The relative Y shift
  // is bounded by `amount × 0.383`, which is small for any
  // reasonable jitter. Empirically (15% jitter), 0 of 128 triangles
  // are back-facing.
  const radius = 1;
  const length = 1.5;
  const geom = new Capsule(radius, length, 4, 8);
  const rng = mulberry32(0xC0FFEE);
  geom.jitter(radius * PROD_JITTER_FRACTION, rng);

  const tris = triangulate(geom);
  let backFacing = 0;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const cx = (t.ax + t.bx + t.cx) / 3;
    const cy = (t.ay + t.by + t.cy) / 3;
    const cz = (t.az + t.bz + t.cz) / 3;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    assert.ok(cl > 0, `triangle ${i} has zero centroid`);
    const nLen = Math.sqrt(t.nx * t.nx + t.ny * t.ny + t.nz * t.nz);
    assert.ok(nLen > 0, `triangle ${i} has zero normal magnitude`);
    // cos(angle) = (n · r) / (|n| * |r|)
    const cosAngle = (t.nx * cx + t.ny * cy + t.nz * cz) / (nLen * cl);
    if (cosAngle <= 0) backFacing += 1;
  }
  assert.equal(
    backFacing, 0,
    `${backFacing} of ${tris.length} triangles are back-facing after jitter (expected 0)`,
  );
});

test('Capsule: jitter at 6× production amount (90%) flags a winding flip (regression guard)', () => {
  // This is the tripwire: at extreme jitter, the surface should
  // start to flip faces. This documents the current upper limit
  // explicitly. If the tripwire starts failing (e.g. faces flip at
  // production), the production jitter has crept too high or the
  // geometry has regressed.
  const radius = 1;
  const length = 1.5;
  const geom = new Capsule(radius, length, 4, 8);
  const rng = mulberry32(0xC0FFEE);
  geom.jitter(radius * PROD_JITTER_FRACTION * 6, rng);
  const tris = triangulate(geom);
  let backFacing = 0;
  for (const t of tris) {
    const cx = (t.ax + t.bx + t.cx) / 3;
    const cy = (t.ay + t.by + t.cy) / 3;
    const cz = (t.az + t.bz + t.cz) / 3;
    const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const nLen = Math.sqrt(t.nx * t.nx + t.ny * t.ny + t.nz * t.nz);
    const cosAngle = (t.nx * cx + t.ny * cy + t.nz * cz) / (nLen * cl);
    if (cosAngle <= 0) backFacing += 1;
  }
  // 6× production (90% jitter) should flip some faces. If this ever
  // changes (e.g. the geometry becomes even more robust), the
  // tripwire multiplier needs to be raised.
  assert.ok(backFacing > 0, `6× production jitter should flip faces (no flips = tripwire needs re-tuning)`);
});

test('Capsule: jitter syncs the UV-seam wrap vertex (ix === radialSegments) with ix === 0 of each ring', () => {
  // Each ring stores a wrap vertex at ix === radialSegments (the
  // same world position as ix === 0 in the un-jittered geometry,
  // there for clean UV continuity). The jitter method must keep
  // the wrap and ix === 0 at the same world position throughout
  // (so the UV seam doesn't visibly tear). They share a single
  // jitter offset — the wrap does NOT consume its own rng() call.
  //
  // Ring layout (must match the build):
  //   r in [0, capSegments]            : ringStart = r * ringSize
  //                                      (body + top cap intermediate)
  //   r in [capSegments+1, 2*capSeg-1] : ringStart = r * ringSize + 1
  //                                      (bottom cap intermediate;
  //                                       the +1 accounts for the top
  //                                       pole at index capSegments*ringSize)
  const radius = 1;
  const length = 1.5;
  const radialSegments = 8;
  const capSegments = 4;
  const geom = new Capsule(radius, length, capSegments, radialSegments);
  // Apply a non-trivial jitter so the wrap-share invariant is
  // actually exercised (rng=0.5 would give offset=0, a degenerate
  // case where the test passes regardless of whether wrap-share
  // is implemented). rng=0.7 yields offset = +0.4*amount.
  geom.jitter(radius * 0.15, () => 0.7);
  const pos = geom.attributes.position;
  const ringSize = radialSegments + 1;
  const totalRings = 2 * capSegments;
  for (let r = 0; r < totalRings; r++) {
    const ringStart = r * ringSize + (r > capSegments ? 1 : 0);
    const wrapIdx = ringStart + radialSegments;
    const baseIdx = ringStart;
    const dx = pos.getX(wrapIdx) - pos.getX(baseIdx);
    const dy = pos.getY(wrapIdx) - pos.getY(baseIdx);
    const dz = pos.getZ(wrapIdx) - pos.getZ(baseIdx);
    const dist2 = dx * dx + dy * dy + dz * dz;
    assert.ok(
      dist2 < 1e-12,
      `ring ${r} (start=${ringStart}): wrap vertex drifted from base by sqrt(${dist2.toFixed(3)}) units (should be 0)`,
    );
  }
});

test('Capsule: jitter wrap-share leaves the cap-ring count and total vertex count unchanged', () => {
  // The wrap-share only mutates already-existing positions, so
  // position.count, index.count, and the ring layout must be
  // identical before and after.
  const geom = new Capsule(1, 1.5, 4, 8);
  const pc = geom.attributes.position.count;
  const ic = geom.index.count;
  geom.jitter(0.3, () => Math.random());
  assert.equal(geom.attributes.position.count, pc);
  assert.equal(geom.index.count, ic);
});

test('Capsule: jitter consumes one rng() call per non-wrap vertex (66 calls for default params)', () => {
  // Ring vertices: 2 body rings + 2 × (capSegments-1) cap rings
  // = 2 × capSegments rings. Each ring has radialSegments non-wrap
  // vertices (ix=0..radialSegments-1). Plus 2 poles.
  // Total: 2 × capSegments × radialSegments + 2 = 2×4×8 + 2 = 66.
  // (The wrap vertices share ix=0's offset and don't consume rng.)
  const geom = new Capsule(1, 1.5, 4, 8);
  let calls = 0;
  geom.jitter(0.1, () => { calls++; return 0.5; });
  assert.equal(calls, 66, `expected 66 rng() calls, got ${calls}`);
});

// ---------------------------------------------------------------------------
// computeUVs
//
// `computeUVs()` is a one-shot post-process that adds a 2-component
// `uv` attribute to the capsule. Cylindrical unwrap: U = atan2(z, x) /
// (2π) + 0.5 (longitude, [0, 1)), V = (y - yMin) / (yMax - yMin)
// (latitude, [0, 1]). Called by `buildCapsuleBody` in
// src/entities/asteroid.js AFTER `geom.jitter(...)` so the UVs align
// with the displaced surface. The function is pure and depends only
// on the live position attribute, so it's testable in Node.
// ---------------------------------------------------------------------------

test('Capsule.computeUVs: creates a 2-component uv attribute with one entry per vertex', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  geom.computeUVs();
  assert.ok(geom.attributes.uv, 'uv attribute should exist after computeUVs()');
  assert.equal(geom.attributes.uv.itemSize, 2, 'uv attribute should be 2D (itemSize = 2)');
  assert.equal(
    geom.attributes.uv.count, geom.attributes.position.count,
    'uv entry count should match vertex count',
  );
});

test('Capsule.computeUVs: U and V values are all in [0, 1]', () => {
  // Cylindrical unwrap with atan2-based U produces values in [0, 1)
  // (the atan2 of (0, 0) at the pole yields 0.5); V is normalized to
  // [0, 1] from yMin/yMax. Combined, both components should fit
  // within [0, 1] for every vertex.
  const geom = new Capsule(2, 3, 4, 8);
  geom.computeUVs();
  const uvs = geom.attributes.uv;
  for (let i = 0; i < uvs.count; i++) {
    const u = uvs.getX(i);
    const v = uvs.getY(i);
    assert.ok(u >= 0 && u <= 1, `vertex ${i}: U = ${u} out of [0, 1]`);
    assert.ok(v >= 0 && v <= 1, `vertex ${i}: V = ${v} out of [0, 1]`);
  }
});

test('Capsule.computeUVs: U is seam-continuous (wrap and base have the same U)', () => {
  // Each ring stores a wrap vertex at ix === radialSegments, which
  // shares its world position with ix === 0 (the same point on the
  // cylinder). After jitter, the wrap still shares the position, so
  // atan2(z, x) gives the same U for both. Without this, the UV
  // seam would visibly tear when the texture is sampled.
  const radius = 1;
  const length = 1.5;
  const radialSegments = 8;
  const capSegments = 4;
  const geom = new Capsule(radius, length, capSegments, radialSegments);
  // Apply a non-trivial jitter first to make this a real test
  // (computeUVs reads the post-jitter positions). rng=0.7 yields
  // offset = (0.7*2-1)*amount = +0.4*amount — a real displacement
  // that exercises the wrap-share invariant. (rng=0.5 would give
  // offset=0, a degenerate case where wrap and base are at the
  // same position by construction.)
  geom.jitter(radius * 0.15, () => 0.7);
  geom.computeUVs();
  const uvs = geom.attributes.uv;
  const ringSize = radialSegments + 1;
  const totalRings = 2 * capSegments;
  for (let r = 0; r < totalRings; r++) {
    // Mirror the ring-layout logic from the jitter wrap-share test.
    const ringStart = r * ringSize + (r > capSegments ? 1 : 0);
    const wrapIdx = ringStart + radialSegments;
    const baseIdx = ringStart;
    const uWrap = uvs.getX(wrapIdx);
    const uBase = uvs.getX(baseIdx);
    assert.ok(
      Math.abs(uWrap - uBase) < 1e-6,
      `ring ${r} (start=${ringStart}): wrap U = ${uWrap} differs from base U = ${uBase} (UV seam would tear)`,
    );
  }
});

test('Capsule.computeUVs: V spans the full [0, 1] range (bottom pole is 0, top pole is 1)', () => {
  // V is normalized from yMin (bottom pole) to yMax (top pole), so
  // the minimum V across all vertices should be 0 and the maximum
  // should be 1. This is the regression guard for the (yMax - yMin)
  // divisor — if it ever flips to 1 - (y - yMin) / yRange, the V
  // axis would invert (texture upside-down).
  const geom = new Capsule(1, 1.5, 4, 8);
  geom.computeUVs();
  const uvs = geom.attributes.uv;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < uvs.count; i++) {
    const v = uvs.getY(i);
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  assert.ok(vMin < 0.01, `V_min = ${vMin}, expected ~0 (bottom pole)`);
  assert.ok(vMax > 0.99, `V_max = ${vMax}, expected ~1 (top pole)`);
});

test('Capsule.computeUVs: is idempotent (calling it twice gives the same result)', () => {
  // Re-calling computeUVs should be a no-op (it always reads the
  // current positions, so the result is deterministic regardless of
  // how many times it's called). This matches the JSDoc contract.
  const geom = new Capsule(1, 1.5, 4, 8);
  geom.jitter(0.1, () => 0.3);
  geom.computeUVs();
  const first = new Float32Array(geom.attributes.uv.array);
  geom.computeUVs();
  const second = new Float32Array(geom.attributes.uv.array);
  assert.deepEqual(Array.from(second), Array.from(first), 'second computeUVs() call should match the first');
});

test('Capsule.computeUVs: pole vertices land at U = 0.5 (atan2(0, 0) convention)', () => {
  // The two pole vertices sit at (0, ±yMax, 0) (or post-jitter
  // near there). atan2(0, 0) returns 0 by JS convention, so
  // U = 0 + 0.5 = 0.5. The V coordinate is 0 (bottom pole) or
  // 1 (top pole). This is the well-defined degenerate case of
  // a cylindrical unwrap at the pole.
  const radius = 1;
  const length = 1.5;
  const capSegments = 4;
  const geom = new Capsule(radius, length, capSegments, 8);
  geom.computeUVs();
  const uvs = geom.attributes.uv;
  const positions = geom.attributes.position;
  // Find top / bottom pole by y extremes (same approach as the
  // existing pole-position test above).
  let topIdx = 0;
  let bottomIdx = 0;
  let maxY = -Infinity;
  let minY = Infinity;
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    if (y > maxY) { maxY = y; topIdx = i; }
    if (y < minY) { minY = y; bottomIdx = i; }
  }
  assert.ok(
    Math.abs(uvs.getX(topIdx) - 0.5) < 1e-6,
    `top pole U = ${uvs.getX(topIdx)}, expected 0.5`,
  );
  assert.ok(
    Math.abs(uvs.getY(topIdx) - 1) < 1e-6,
    `top pole V = ${uvs.getY(topIdx)}, expected 1`,
  );
  assert.ok(
    Math.abs(uvs.getX(bottomIdx) - 0.5) < 1e-6,
    `bottom pole U = ${uvs.getX(bottomIdx)}, expected 0.5`,
  );
  assert.ok(
    Math.abs(uvs.getY(bottomIdx) - 0) < 1e-6,
    `bottom pole V = ${uvs.getY(bottomIdx)}, expected 0`,
  );
});

// ---------------------------------------------------------------------------
// computePlanarUVs
//
// `computePlanarUVs(plane)` is a one-shot post-process that adds a
// 2-component `uv` attribute to the capsule by projecting the live
// (post-jitter) local positions onto one of the 3 axis-aligned
// planes ('xy' / 'xz' / 'yz') and normalizing to [0, 1]. Used by
// the asteroid entity in src/entities/asteroid.js for the capsule
// body — gives a proper per-mesh UV unwrap (no world-space tricks)
// that the standard MeshStandardMaterial can sample with its
// built-in map / normalMap / roughnessMap / bumpMap slots.
// ---------------------------------------------------------------------------

test('Capsule.computePlanarUVs: creates a 2-component uv attribute with one entry per vertex', () => {
  const geom = new Capsule(...Object.values(DEFAULTS));
  geom.computePlanarUVs('xy');
  assert.ok(geom.attributes.uv, 'uv attribute should exist after computePlanarUVs()');
  assert.equal(geom.attributes.uv.itemSize, 2, 'uv attribute should be 2D (itemSize = 2)');
  assert.equal(
    geom.attributes.uv.count, geom.attributes.position.count,
    'uv entry count should match vertex count',
  );
});

test('Capsule.computePlanarUVs: U and V values are all in [0, 1]', () => {
  // The normalize-to-bounding-box pass keeps every UV in [0, 1].
  const geom = new Capsule(2, 3, 4, 8);
  geom.computePlanarUVs('xy');
  const uvs = geom.attributes.uv;
  for (let i = 0; i < uvs.count; i++) {
    const u = uvs.getX(i);
    const v = uvs.getY(i);
    assert.ok(u >= 0 && u <= 1, `vertex ${i}: U = ${u} out of [0, 1]`);
    assert.ok(v >= 0 && v <= 1, `vertex ${i}: V = ${v} out of [0, 1]`);
  }
});

test('Capsule.computePlanarUVs: U and V are a planar projection of the local positions', () => {
  // For the 'xy' plane: U should be a normalized x and V should be
  // a normalized y. The normalization uses the live positions, so
  // after jitter, U and V still correspond to the (post-jitter) x
  // and y, normalized to [0, 1].
  const radius = 1;
  const length = 1.5;
  const geom = new Capsule(radius, length, 4, 8);
  geom.computePlanarUVs('xy');
  const uvs = geom.attributes.uv;
  const positions = geom.attributes.position;
  // Find x/y bounding box from positions.
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  // Check that U is a normalized x and V is a normalized y.
  for (let i = 0; i < uvs.count; i++) {
    const expectedU = (positions.getX(i) - xMin) / xRange;
    const expectedV = (positions.getY(i) - yMin) / yRange;
    assert.ok(
      Math.abs(uvs.getX(i) - expectedU) < 1e-6,
      `vertex ${i}: U = ${uvs.getX(i)}, expected ${expectedU} (from x=${positions.getX(i)})`,
    );
    assert.ok(
      Math.abs(uvs.getY(i) - expectedV) < 1e-6,
      `vertex ${i}: V = ${uvs.getY(i)}, expected ${expectedV} (from y=${positions.getY(i)})`,
    );
  }
});

test('Capsule.computePlanarUVs: different planes produce different UVs', () => {
  // 'xy' projects onto the XY plane, 'xz' onto the XZ plane, 'yz'
  // onto the YZ plane. The U and V values should be different
  // (because the projection axes are different), but the UV-space
  // is still in [0, 1] for each.
  const radius = 1;
  const length = 1.5;
  const geomA = new Capsule(radius, length, 4, 8);
  geomA.computePlanarUVs('xy');
  const geomB = new Capsule(radius, length, 4, 8);
  geomB.computePlanarUVs('xz');
  const geomC = new Capsule(radius, length, 4, 8);
  geomC.computePlanarUVs('yz');
  const uvsA = geomA.attributes.uv.array;
  const uvsB = geomB.attributes.uv.array;
  const uvsC = geomC.attributes.uv.array;
  let anyAB = false;
  let anyAC = false;
  for (let i = 0; i < uvsA.length; i++) {
    if (uvsA[i] !== uvsB[i]) anyAB = true;
    if (uvsA[i] !== uvsC[i]) anyAC = true;
  }
  assert.ok(anyAB, "'xy' and 'xz' should produce different UVs");
  assert.ok(anyAC, "'xy' and 'yz' should produce different UVs");
});

test('Capsule.computePlanarUVs: is idempotent (calling it twice gives the same result)', () => {
  // The function is purely a function of the live positions, so
  // calling it again gives the same result. (This is the same
  // contract as computeUVs.)
  const geom = new Capsule(1, 1.5, 4, 8);
  geom.jitter(0.1, () => 0.3);
  geom.computePlanarUVs('xy');
  const first = new Float32Array(geom.attributes.uv.array);
  geom.computePlanarUVs('xy');
  const second = new Float32Array(geom.attributes.uv.array);
  assert.deepEqual(Array.from(second), Array.from(first), 'second computePlanarUVs() call should match the first');
});

test('Capsule.computePlanarUVs: uses local (live) positions, not world space', () => {
  // The "local not world" property is the whole point of this
  // function (vs the previous triplanar world-space mapping).
  // The strongest evidence: jittering the capsule (which moves the
  // local positions) changes the UVs, even though the world
  // position of the mesh is still (0, 0, 0). A world-space mapping
  // would give the same UVs regardless of jitter.
  const geom = new Capsule(1, 1.5, 4, 8);
  geom.computePlanarUVs('xy');
  const before = new Float32Array(geom.attributes.uv.array);
  // Jitter with a non-trivial RNG so the live positions move.
  geom.jitter(0.3, () => 0.7);
  geom.computePlanarUVs('xy');
  const after = new Float32Array(geom.attributes.uv.array);
  let anyDifference = false;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) { anyDifference = true; break; }
  }
  assert.ok(
    anyDifference,
    'UVs should change after jitter (the function reads live local positions)',
  );
});
