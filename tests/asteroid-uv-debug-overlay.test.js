import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createAsteroidUvDebugOverlay } from '../src/systems/asteroid-uv-debug-overlay.js';
import { Capsule } from '../src/geometry/capsule.js';

// A minimal geometry the overlay can attach to. The icosphere and
// capsule both have a `uv` attribute after their respective unwrap
// step; for the bare-geometry tests we just need a 2-component uv
// attribute so the shader has something to read.
function makeGeometryWithUv() {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0,   1, -1, 0,   1, 1, 0,   -1, 1, 0,
  ]), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0,   1, 0,   1, 1,   0, 1,
  ]), 2));
  geom.setIndex([0, 1, 2, 0, 2, 3]);
  return geom;
}

test('Overlay: starts disabled and exposes the expected API', () => {
  const overlay = createAsteroidUvDebugOverlay();
  assert.equal(overlay.isEnabled(), false, 'starts disabled');
  assert.equal(typeof overlay.setEnabled, 'function');
  assert.equal(typeof overlay.setCapsulePlane, 'function');
  assert.equal(typeof overlay.getCapsulePlane, 'function');
  assert.equal(typeof overlay.attach, 'function');
  assert.equal(typeof overlay.detach, 'function');
  assert.equal(typeof overlay.dispose, 'function');
  overlay.dispose();
});

test('Overlay: setEnabled flips isEnabled and the attached mesh visibility', () => {
  const overlay = createAsteroidUvDebugOverlay();
  const geom = makeGeometryWithUv();
  const mesh = overlay.attach(geom, 'icosphere');
  assert.equal(mesh.visible, false, 'starts hidden (overlay disabled)');
  overlay.setEnabled(true);
  assert.equal(overlay.isEnabled(), true);
  assert.equal(mesh.visible, true, 'mesh becomes visible when overlay enabled');
  overlay.setEnabled(false);
  assert.equal(overlay.isEnabled(), false);
  assert.equal(mesh.visible, false, 'mesh becomes hidden when overlay disabled');
  overlay.dispose();
});

test('Overlay: attach throws on missing geometry or invalid kind', () => {
  const overlay = createAsteroidUvDebugOverlay();
  // Source uses backticks around the parameter name (matches the
  // existing project convention, e.g. `createAsteroidFromSpec`).
  assert.throws(() => overlay.attach(null, 'icosphere'), /`geometry` is required/);
  assert.throws(() => overlay.attach(makeGeometryWithUv(), 'wat'), /`kind`/);
  overlay.dispose();
});

test('Overlay: attached mesh shares the geometry (no copies)', () => {
  const overlay = createAsteroidUvDebugOverlay();
  const geom = makeGeometryWithUv();
  const mesh = overlay.attach(geom, 'icosphere');
  assert.equal(mesh.geometry, geom, 'attached mesh should share the geometry (no copy)');
  overlay.dispose();
});

test('Overlay: setCapsulePlane returns false for invalid values', () => {
  const overlay = createAsteroidUvDebugOverlay();
  // Original warnings from `console.warn` would pollute test output,
  // so we silence them for this test.
  const origWarn = console.warn;
  console.warn = () => {};
  assert.equal(overlay.setCapsulePlane('xy123'), false, 'invalid plane rejected');
  assert.equal(overlay.setCapsulePlane('XYZ'), false, 'invalid plane rejected');
  assert.equal(overlay.setCapsulePlane(''), false, 'empty plane rejected');
  console.warn = origWarn;
  overlay.dispose();
});

test('Overlay: setCapsulePlane returns true for the 3 valid planes', () => {
  const overlay = createAsteroidUvDebugOverlay();
  assert.equal(overlay.setCapsulePlane('xy'), true);
  assert.equal(overlay.getCapsulePlane(), 'xy');
  assert.equal(overlay.setCapsulePlane('xz'), true);
  assert.equal(overlay.getCapsulePlane(), 'xz');
  assert.equal(overlay.setCapsulePlane('yz'), true);
  assert.equal(overlay.getCapsulePlane(), 'yz');
  overlay.dispose();
});

test('Overlay: setCapsulePlane recomputes UVs on every attached capsule', () => {
  // Build two capsules and attach them to the overlay. Set the
  // plane to 'xz' (which uses x and z, not y) and verify the UV
  // values reflect the new projection.
  const overlay = createAsteroidUvDebugOverlay();
  const geomA = new Capsule(1, 1, 4, 8);
  const geomB = new Capsule(2, 3, 4, 8);
  geomA.computePlanarUVs('xy');
  geomB.computePlanarUVs('xy');
  overlay.attach(geomA, 'capsule');
  overlay.attach(geomB, 'capsule');
  // Snapshot the UVs in the 'xy' state.
  const beforeA = Array.from(geomA.attributes.uv.array);
  const beforeB = Array.from(geomB.attributes.uv.array);
  // Switch to 'xz' — the UVs should change.
  overlay.setCapsulePlane('xz');
  const afterA = Array.from(geomA.attributes.uv.array);
  const afterB = Array.from(geomB.attributes.uv.array);
  let anyA = false, anyB = false;
  for (let i = 0; i < beforeA.length; i++) if (beforeA[i] !== afterA[i]) anyA = true;
  for (let i = 0; i < beforeB.length; i++) if (beforeB[i] !== afterB[i]) anyB = true;
  assert.ok(anyA, 'capsule A UVs should change when the plane is switched');
  assert.ok(anyB, 'capsule B UVs should change when the plane is switched');
  // Switching to 'yz' should change them again.
  overlay.setCapsulePlane('yz');
  const afterC = Array.from(geomA.attributes.uv.array);
  let anyC = false;
  for (let i = 0; i < afterA.length; i++) if (afterA[i] !== afterC[i]) anyC = true;
  assert.ok(anyC, 'capsule A UVs should change again on a second switch');
  // icosphere attachments should NOT be touched.
  const geomIco = makeGeometryWithUv();
  const beforeIco = Array.from(geomIco.attributes.uv.array);
  overlay.attach(geomIco, 'icosphere');
  overlay.setCapsulePlane('xy');
  const afterIco = Array.from(geomIco.attributes.uv.array);
  for (let i = 0; i < beforeIco.length; i++) {
    assert.equal(afterIco[i], beforeIco[i], `icosphere UV[${i}] should be unchanged after setCapsulePlane`);
  }
  overlay.dispose();
});

test('Overlay: shader source contains the expected UV-grid symbols', () => {
  // We read the GLSL source from the shared material's cached
  // program. Reading the source is the closest thing to a static
  // test we can do without a WebGL context.
  const overlay = createAsteroidUvDebugOverlay();
  const mat = overlay.attach(makeGeometryWithUv(), 'icosphere').material;
  // The vertex shader should pass `vUv` through.
  const vert = mat.vertexShader;
  assert.ok(vert.includes('vUv'), 'vertex shader should declare vUv');
  assert.ok(vert.includes('uv'), 'vertex shader should read the uv attribute');
  // The fragment shader should implement the 10x10 grid.
  const frag = mat.fragmentShader;
  assert.ok(frag.includes('fract(vUv'), 'fragment shader should wrap the UV (fract)');
  assert.ok(frag.includes('* 10.0'), 'fragment shader should scale to 10 cells');
  assert.ok(frag.includes('hsv2rgb') || frag.includes('hsv'), 'fragment shader should color cells');
  assert.ok(frag.includes('smoothstep'), 'fragment shader should anti-alias the grid lines');
  overlay.dispose();
});

test('Overlay: material has polygonOffset to avoid z-fighting', () => {
  // The debug mesh shares the body's geometry, so without
  // polygonOffset the fragments would be at the same depth as
  // the body and z-fight. The fix is the standard polygonOffset
  // hack (factor -1, units -1). This test pins the property so
  // a future "tidy up" doesn't accidentally remove it.
  const overlay = createAsteroidUvDebugOverlay();
  const mat = overlay.attach(makeGeometryWithUv(), 'icosphere').material;
  assert.equal(mat.polygonOffset, true, 'polygonOffset should be enabled');
  assert.equal(mat.polygonOffsetFactor, -1, 'polygonOffsetFactor should be -1');
  assert.equal(mat.polygonOffsetUnits, -1, 'polygonOffsetUnits should be -1');
  overlay.dispose();
});

test('Overlay: detach unregisters the mesh (subsequent setEnabled does not flip its visibility)', () => {
  const overlay = createAsteroidUvDebugOverlay();
  const geom = makeGeometryWithUv();
  const mesh = overlay.attach(geom, 'icosphere');
  overlay.detach(mesh);
  // After detach, the overlay no longer tracks the mesh.
  overlay.setEnabled(true);
  // Mesh's visibility is whatever it was at detach time (false)
  // — it does NOT flip on because the overlay no longer knows
  // about it.
  assert.equal(mesh.visible, false, 'detached mesh should not be touched by setEnabled');
  overlay.dispose();
});
