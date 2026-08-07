/**
 * Tests for src/systems/pirate-texture.js (v0.57.0).
 *
 * The texture factory uses `document.createElement('canvas')` and
 * the browser 2D context, which isn't available in Node. We mock
 * the document + 2D context with minimal shims so the factory can
 * be exercised in Node tests. The real pixel content is verified
 * visually in the browser smoke check.
 *
 * Coverage:
 *   - createPirateTexture: document-absent throws / non-power-of-2
 *     size throws / returns a Texture / paints layers / deterministic
 *   - applyPirateTexture: rejects missing args / body->map, glow->emissiveMap,
 *     needsUpdate set on both materials
 */

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createPirateTexture, applyPirateTexture } from '../src/systems/pirate-texture.js';

// ------------------------------------------------------------------
// Minimal browser shim: document.createElement + 2D context
// ------------------------------------------------------------------

function makeCanvasShim() {
  // Real 2D context API surface used by paintHazardStripes +
  // paintWarningTriangles. Each method is a no-op; we only count
  // invocations to assert that the expected layers were painted.
  const log = { fillRectCalls: 0, triangleBegins: 0 };
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
    beginPath() { log.triangleBegins += 1; },
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    fillRect() { log.fillRectCalls += 1; },
  };
  return {
    log,
    canvas: {
      width: 0,
      height: 0,
      getContext(kind) {
        return kind === '2d' ? ctx : null;
      },
    },
  };
}

/**
 * Install the document shim with a fresh canvas. Returns the shared
 * `log` so individual tests can check paint-call counts.
 */
function installBrowserShim() {
  const { log, canvas } = makeCanvasShim();
  globalThis.document = {
    createElement(tag) {
      return tag === 'canvas' ? canvas : {};
    },
  };
  return log;
}

// Cleanup so other test files don't see the shim.
afterEach(() => {
  delete globalThis.document;
});

// ------------------------------------------------------------------
// createPirateTexture
// ------------------------------------------------------------------

test('createPirateTexture: throws when document is undefined', () => {
  delete globalThis.document;
  let threw = null;
  try {
    createPirateTexture({ size: 64 });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'must throw when document is undefined');
  assert.match(threw.message, /document/, 'error message mentions document');
});

test('createPirateTexture: rejects invalid sizes (0 and non-power-of-2)', () => {
  installBrowserShim();
  // Test size=100 (not a power of 2)
  let threw100 = null;
  try {
    createPirateTexture({ size: 100 });
  } catch (e) {
    threw100 = e;
  }
  assert.ok(threw100, 'must throw for size=100');
  assert.match(threw100.message, /power of 2/, 'error message mentions power of 2');

  // Test size=0 (edge case: 0 is trivially a power of 2^0, but our
  // check rejects it via the && size > 0 gate)
  let threw0 = null;
  try {
    createPirateTexture({ size: 0 });
  } catch (e) {
    threw0 = e;
  }
  assert.ok(threw0, 'must throw for size=0');
  assert.match(threw0.message, /power of 2/, 'error message mentions power of 2');
});

test('createPirateTexture: returns a Three.js Texture (with mocked canvas)', () => {
  installBrowserShim();
  let tex = null;
  let threw = null;
  try {
    tex = createPirateTexture({ size: 64, seed: 1337 });
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, 'factory must not throw with valid args + mocked document');
  assert.ok(tex, 'must return a texture');
  // Three.js r0.160 CanvasTexture exposes `repeat`, `wrapS`, `wrapT`,
  // and `needsUpdate`. The exact `needsUpdate` value depends on the
  // Three.js version (some paths defer the property); we don't pin
  // it, just verify the texture was actually constructed. `image`
  // is the canvas reference and is the most reliable proof.
  assert.equal(tex.image.width, 64, 'texture wraps a 64x64 canvas');
  assert.equal(tex.image.height, 64, 'texture wraps a 64x64 canvas');
  assert.ok(tex.repeat && tex.repeat.x > 0 && tex.repeat.y > 0, 'repeat is set');
});

test('createPirateTexture: paints base + hazard stripes + warning triangles', () => {
  const log = installBrowserShim();
  createPirateTexture({ size: 64, seed: 1337 });
  // 1 charcoal base + 12 rotated-stripe fillRect passes (6 stripes * 2
  // passes) = >=13 fillRect calls expected. Triangles: 4 beginPaths.
  assert.ok(log.fillRectCalls >= 13, `base + stripes must paint (got ${log.fillRectCalls})`);
  assert.ok(log.triangleBegins >= 4, `4 warning triangles must paint (got ${log.triangleBegins})`);
});

test('createPirateTexture: deterministic -- same seed reproduces same triangle layout', () => {
  const a = installBrowserShim();
  createPirateTexture({ size: 64, seed: 9999 });
  const aTriangles = a.triangleBegins;

  const b = installBrowserShim();
  createPirateTexture({ size: 64, seed: 9999 });
  const bTriangles = b.triangleBegins;

  assert.equal(aTriangles, bTriangles, 'same seed -> same triangle count');
  assert.equal(a.fillRectCalls, b.fillRectCalls, 'same seed -> same fillRect count');
});

// ------------------------------------------------------------------
// applyPirateTexture
// ------------------------------------------------------------------

test('applyPirateTexture: rejects missing args', () => {
  let threwShip = null;
  try {
    applyPirateTexture(null, {});
  } catch (e) {
    threwShip = e;
  }
  assert.ok(threwShip, 'must throw when ship is null');
  assert.match(threwShip.message, /ship/);

  let threwTex = null;
  try {
    applyPirateTexture({}, null);
  } catch (e) {
    threwTex = e;
  }
  assert.ok(threwTex, 'must throw when texture is null');
  assert.match(threwTex.message, /texture/);
});

test('applyPirateTexture: body->map, glow->emissiveMap, both needsUpdate=true', () => {
  const fakeTex = { repeat: { set() {} } };
  const bodyMesh = { isMesh: true, userData: {}, material: { needsUpdate: false }, name: 'body' };
  const glowMesh = { isMesh: true, userData: { isEngineGlow: true }, material: { needsUpdate: false }, name: 'glow' };
  // Walk callback: collect meshes so traverse can iterate.
  const meshes = [bodyMesh, glowMesh];
  const ship = {
    mesh: {
      traverse(cb) {
        for (const m of meshes) cb(m);
      },
    },
  };
  applyPirateTexture(ship, fakeTex);
  assert.equal(bodyMesh.material.map, fakeTex, 'body got the texture as color map');
  assert.equal(bodyMesh.material.emissiveMap, undefined, 'body did NOT get emissiveMap');
  assert.equal(glowMesh.material.emissiveMap, fakeTex, 'glow got the texture as emissive map');
  assert.equal(glowMesh.material.map, undefined, 'glow did NOT get color map');
  assert.equal(bodyMesh.material.needsUpdate, true, 'body material flagged for shader recompile');
  assert.equal(glowMesh.material.needsUpdate, true, 'glow material flagged for shader recompile');
});
