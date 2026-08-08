import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSsaoPostprocess,
  shouldExcludeFromAoGBuffer,
} from '../src/systems/ssao.js';
import {
  SSAO_ENABLED_DEFAULT,
  SSAO_RADIUS,
  SSAO_THICKNESS,
  SSAO_RESOLUTION_DIVIDER,
  SSAO_BLEND_INTENSITY,
  SSAO_SAMPLES,
} from '../src/scene/ssao-constants.js';

// ---------------------------------------------------------------------------
// v0.73.0 — SSAO postprocessing unit tests. The real three.js composer
// chain needs a WebGL context + `window`, so construction is tested via
// an injected fake `buildComposer` (the same DI pattern as `shipFactory`
// in ai.js). The pure GBuffer-exclusion predicate is tested directly.
// ---------------------------------------------------------------------------

function makeFakeRenderer() {
  return {
    render: () => { throw new Error('renderer.render should not be called directly (goes through ssao.render)'); },
    getPixelRatio: () => 1,
  };
}

function makeFakeComposer() {
  const calls = [];
  return {
    calls,
    composer: {
      render: () => { calls.push('composer.render'); },
      setSize: (w, h) => { calls.push(`composer.setSize:${w}:${h}`); },
      dispose: () => { calls.push('composer.dispose'); },
    },
    gtaoPass: {
      setSize: (w, h) => { calls.push(`gtao.setSize:${w}:${h}`); },
      dispose: () => { calls.push('gtao.dispose'); },
    },
  };
}

function makeScene() { return { isScene: true }; }
function makeCamera() { return { isPerspectiveCamera: true, near: 0.1, far: 6000 }; }

// ---- shouldExcludeFromAoGBuffer ------------------------------------------

test('shouldExcludeFromAoGBuffer: transparent meshes are excluded (FX: laser/glow/nebula)', () => {
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, material: { transparent: true } }), true);
});

test('shouldExcludeFromAoGBuffer: opaque solids stay in the GBuffer (asteroids/ships/sun)', () => {
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, material: { transparent: false } }), false);
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, material: { transparent: undefined } }), false);
});

test('shouldExcludeFromAoGBuffer: tagged FX excluded by userData (decorativeFx/isEngineGlow/ssaoExclude)', () => {
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, userData: { decorativeFx: true }, material: {} }), true);
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, userData: { isEngineGlow: true }, material: {} }), true);
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, userData: { ssaoExclude: true }, material: {} }), true);
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, userData: {}, material: {} }), false);
});

test('shouldExcludeFromAoGBuffer: sprites (particles) are excluded even with opaque material', () => {
  assert.equal(shouldExcludeFromAoGBuffer({ isSprite: true, material: { transparent: false } }), true);
});

test('shouldExcludeFromAoGBuffer: material arrays handled (multi-material meshes)', () => {
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, material: [{ transparent: false }, { transparent: true }] }), true);
  assert.equal(shouldExcludeFromAoGBuffer({ isMesh: true, material: [{ transparent: false }, { transparent: false }] }), false);
});

test('shouldExcludeFromAoGBuffer: garbage input → false, no throw', () => {
  assert.equal(shouldExcludeFromAoGBuffer(null), false);
  assert.equal(shouldExcludeFromAoGBuffer(undefined), false);
  assert.equal(shouldExcludeFromAoGBuffer(42), false);
  assert.equal(shouldExcludeFromAoGBuffer('mesh'), false);
});

// ---- createSsaoPostprocess (DI builder) -----------------------------------

test('createSsaoPostprocess: missing deps throw', () => {
  assert.throws(() => createSsaoPostprocess({}), /renderer/);
  assert.throws(() => createSsaoPostprocess({ renderer: {}, scene: {} }), /camera/);
});

test('createSsaoPostprocess: default is OFF (perf-safe fast path) → render() uses renderer.render', () => {
  const fake = makeFakeComposer();
  let directRenders = 0;
  const ssao = createSsaoPostprocess({
    renderer: { render: () => { directRenders += 1; }, getPixelRatio: () => 1 },
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
  });
  assert.equal(ssao.isEnabled(), SSAO_ENABLED_DEFAULT);
  assert.equal(SSAO_ENABLED_DEFAULT, false, 'v0.73.0 ships SSAO OFF by default (A/B toggle; double scene render is costly)');
  ssao.render();
  assert.equal(directRenders, 1, 'default-off → plain renderer.render fast path');
  assert.ok(!fake.calls.includes('composer.render'));
});

test('createSsaoPostprocess: enabled → render() goes through composer', () => {
  const fake = makeFakeComposer();
  const ssao = createSsaoPostprocess({
    renderer: makeFakeRenderer(),
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
    enabled: true,
  });
  assert.equal(ssao.isEnabled(), true);
  ssao.render();
  assert.ok(fake.calls.includes('composer.render'), 'composer.render must be called when enabled');
});

test('createSsaoPostprocess: disabled → render() falls back to renderer.render (fast path)', () => {
  let directRenders = 0;
  const fake = makeFakeComposer();
  const ssao = createSsaoPostprocess({
    renderer: { render: () => { directRenders += 1; }, getPixelRatio: () => 1 },
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
    enabled: false,
  });
  ssao.render();
  assert.equal(directRenders, 1);
  assert.ok(!fake.calls.includes('composer.render'), 'composer must be skipped when disabled');
});

test('createSsaoPostprocess: setEnabled toggles the render path live', () => {
  const fake = makeFakeComposer();
  const ssao = createSsaoPostprocess({
    renderer: { render: () => {}, getPixelRatio: () => 1 },
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
    enabled: false,
  });
  ssao.setEnabled(true);
  assert.equal(ssao.isEnabled(), true);
  ssao.render();
  assert.ok(fake.calls.includes('composer.render'));

  fake.calls.length = 0;
  ssao.setEnabled(false);
  assert.equal(ssao.isEnabled(), false);
  ssao.render();
  assert.ok(!fake.calls.includes('composer.render'));
});

test('createSsaoPostprocess: setSize propagates to composer + half-res GTAO pass', () => {
  const fake = makeFakeComposer();
  const ssao = createSsaoPostprocess({
    renderer: makeFakeRenderer(),
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
  });
  ssao.setSize(1280, 720);
  const hw = Math.floor(1280 / SSAO_RESOLUTION_DIVIDER);
  const hh = Math.floor(720 / SSAO_RESOLUTION_DIVIDER);
  assert.ok(fake.calls.includes(`composer.setSize:1280:720`));
  assert.ok(fake.calls.includes(`gtao.setSize:${hw}:${hh}`));
});

test('createSsaoPostprocess: dispose releases composer + gtaoPass', () => {
  const fake = makeFakeComposer();
  const ssao = createSsaoPostprocess({
    renderer: makeFakeRenderer(),
    scene: makeScene(),
    camera: makeCamera(),
    buildComposer: () => fake,
  });
  ssao.dispose();
  assert.ok(fake.calls.includes('composer.dispose'));
  assert.ok(fake.calls.includes('gtao.dispose'));
});

// ---- Tunables SSOT sanity ------------------------------------------------

test('SSAO constants: tunables are sane for the asteroid scale', () => {
  assert.ok(SSAO_RADIUS > 0, 'radius must be positive (2.0 catches crater rims)');
  assert.ok(SSAO_THICKNESS > 0, 'thickness must be positive');
  assert.ok(SSAO_SAMPLES >= 8, 'samples >= 8 for a clean result');
  assert.ok(SSAO_RESOLUTION_DIVIDER >= 1, 'resolution divider >= 1');
  assert.ok(SSAO_BLEND_INTENSITY > 0, 'blend intensity must be positive');
  assert.equal(typeof SSAO_ENABLED_DEFAULT, 'boolean');
});
