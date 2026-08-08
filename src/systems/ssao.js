import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  SSAO_ENABLED_DEFAULT,
  SSAO_RADIUS,
  SSAO_THICKNESS,
  SSAO_DISTANCE_EXPONENT,
  SSAO_DISTANCE_FALL_OFF,
  SSAO_SCALE,
  SSAO_SAMPLES,
  SSAO_RESOLUTION_DIVIDER,
  SSAO_BLEND_INTENSITY,
  SSAO_DENOISE,
} from '../scene/ssao-constants.js';

// ---------------------------------------------------------------------------
// v0.73.0 — Screen-Space Ambient Occlusion (GTAO) postprocessing.
//
// The realism-lever pass: darkens the contact shadows where asteroid
// boulders, crater rims and rock facets touch each other, which is the
// single biggest "matte/floaty" tell in the current renders (without
// AO, every crater interior reads as a flat gradient).
//
// Chain (three.js EffectComposer):
//   RenderPass  — renders the scene LINEAR into the composer's buffer.
//                 (three r152+ skips tone mapping when the target is a
//                 render target, not the screen — that's why the final
//                 pass MUST re-apply ACES + sRGB.)
//   GTAOPass    — ground-truth ambient occlusion at half resolution:
//                 renders its own depth+normal GBuffer, computes AO,
//                 Poisson-denoises, blends AO onto the scene color.
//   OutputPass  — re-applies the renderer's ACES filmic tone mapping +
//                 output color space conversion to the final image.
//
// Subclass `GameGTAOPass` fixes two stock-pass issues for this game:
//   1. The stock GBuffer visibility walk only excludes Points/Lines.
//      Decorative transparent FX (laser beam, engine glow, powerup
//      ring/beam, particle sprites) would otherwise render into the
//      depth+normal buffer with the MeshNormalMaterial override and
//      stamp fake AO halos onto the scene around them. We extend the
//      exclusion predicate (`shouldExcludeFromAoGBuffer`) to drop
//      sprites, transparent materials, and the existing
//      ssaoExclude/decorativeFx/isEngineGlow tags.
//   2. The GBuffer re-render calls renderer.render() which would ALSO
//      re-render the whole shadow map (doubling the per-frame shadow
//      pass). The GBuffer needs neither shadows nor depth from them,
//      so we toggle renderer.shadowMap.enabled off for the duration of
//      the pass. The main RenderPass still renders shadows normally.
//
// Toggle: `window.SSAO = true/false` (devtools) or the
// `#debug-toggle-ssao` HUD button. When disabled, `render()` falls back
// to a plain `renderer.render(scene, camera)` — pixel-identical to the
// pre-v0.73.0 fast path (tone mapping applied by the renderer since the
// target is null). When enabled, the composer chain runs.
//
// Known tradeoff of the composer chain: OutputPass re-applies ACES tone
// mapping to the WHOLE final image, so `toneMapped: false` materials
// (starfield points, bullets, laser, particles) lose their no-ACES
// "pop" while SSAO is on. Inherent to any three.js postprocessing
// chain; the stars/bullets shift slightly, the asteroids behave
// correctly. Requirements: WebGL2 (GTAO's HalfFloat + UnsignedInt248Type
// depth textures); the renderer is created without an explicit context
// so modern browsers default to it.
// ---------------------------------------------------------------------------

/**
 * Pure predicate: should `obj` be excluded from the GTAO depth+normal
 * GBuffer pass? Excluded objects never contribute occlusion (and never
 * get occluded BY), so transparent FX can't stamp fake AO halos.
 *
 * Rule: anything tagged `ssaoExclude` / `decorativeFx` / `isEngineGlow`,
 * any THREE.Sprite (particles), and any mesh/sprite whose material is
 * transparent. Opaque solids (asteroids, ships, power-up bodies, the
 * sun) stay in — they're the real occlusion geometry.
 *
 * Exported for direct unit testing (no WebGL needed).
 *
 * @param {import('three').Object3D} obj
 * @returns {boolean}
 */
export function shouldExcludeFromAoGBuffer(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.userData?.ssaoExclude) return true;
  if (obj.userData?.decorativeFx) return true;
  if (obj.userData?.isEngineGlow) return true;
  if (obj.isSprite) return true;
  if (obj.isMesh || obj.isSprite) {
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (mats.some((m) => m && m.transparent === true)) return true;
  }
  return false;
}

/**
 * Game-aware GTAO pass: excludes decorative FX from the GBuffer and
 * skips the shadow pass while rendering the GBuffer (it needs neither).
 */
class GameGTAOPass extends GTAOPass {
  /** @override */
  overrideVisibility() {
    super.overrideVisibility();
    // `super` already cached every object's original visibility, so we
    // can simply hide the decorative FX — restoreVisibility() (inherited)
    // will put them back.
    this.scene.traverse((obj) => {
      if (shouldExcludeFromAoGBuffer(obj) && obj.visible) {
        obj.visible = false;
      }
    });
  }

  /** @override — GBuffer needs no shadow maps; skip the double shadow pass. */
  render(renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    const shadowMap = renderer.shadowMap;
    const shadowEnabled = shadowMap ? shadowMap.enabled : false;
    if (shadowMap) shadowMap.enabled = false;
    try {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    } finally {
      if (shadowMap) shadowMap.enabled = shadowEnabled;
    }
  }
}

/**
 * Build the real three.js composer chain (browser only). Split out so
 * tests can inject a fake `buildComposer` and exercise the wrapper
 * logic in Node without a WebGL context.
 *
 * @param {{ renderer: import('three').WebGLRenderer, scene: import('three').Scene, camera: import('three').PerspectiveCamera }} deps
 * @returns {{ composer: EffectComposer, gtaoPass: GameGTAOPass }}
 */
function defaultBuildComposer({ renderer, scene, camera }) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aw = Math.max(1, Math.floor(w / SSAO_RESOLUTION_DIVIDER));
  const ah = Math.max(1, Math.floor(h / SSAO_RESOLUTION_DIVIDER));

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));

  const gtaoPass = new GameGTAOPass(scene, camera, aw, ah, null, {
    radius: SSAO_RADIUS,
    distanceExponent: SSAO_DISTANCE_EXPONENT,
    thickness: SSAO_THICKNESS,
    distanceFallOff: SSAO_DISTANCE_FALL_OFF,
    scale: SSAO_SCALE,
    samples: SSAO_SAMPLES,
    screenSpaceRadius: false,
  }, SSAO_DENOISE);
  gtaoPass.blendIntensity = SSAO_BLEND_INTENSITY;
  composer.addPass(gtaoPass);
  // REQUIRED in r152+: re-applies ACES tone mapping + output color
  // space (the RenderPass rendered linear because its target is a
  // render target, not the screen).
  composer.addPass(new OutputPass());

  return { composer, gtaoPass };
}

/**
 * Create the SSAO postprocessing wrapper. Safe in non-browser
 * environments: construction only touches the injectable builder
 * (the real three chain needs `window` + a WebGL renderer, so Node
 * tests must pass their own `buildComposer` fake).
 *
 * @param {{
 *   renderer: import('three').WebGLRenderer,
 *   scene: import('three').Scene,
 *   camera: import('three').PerspectiveCamera,
 *   buildComposer?: (deps: {renderer: unknown, scene: unknown, camera: unknown}) => { composer: {render: () => void, setSize: (w: number, h: number) => void, dispose: () => void}, gtaoPass: {setSize: (w: number, h: number) => void, dispose: () => void} },
 *   enabled?: boolean,
 * }} opts
 * @returns {{
 *   render: () => void,
 *   setEnabled: (v: boolean) => void,
 *   isEnabled: () => boolean,
 *   setSize: (w: number, h: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createSsaoPostprocess({ renderer, scene, camera, buildComposer, enabled = SSAO_ENABLED_DEFAULT } = {}) {
  if (!renderer || !scene || !camera) {
    throw new Error('createSsaoPostprocess: `renderer`, `scene`, and `camera` are required');
  }

  let on = !!enabled;
  const built = (buildComposer || defaultBuildComposer)({ renderer, scene, camera });
  const { composer, gtaoPass } = built;

  /**
   * Render the frame. Enabled → full composer chain (SSAO applied).
   * Disabled → plain renderer.render (identical to the pre-SSAO fast
   * path; tone mapping applied because the target is null).
   */
  function render() {
    if (on) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  function setEnabled(v) {
    on = !!v;
  }

  function isEnabled() {
    return on;
  }

  /** Resize the composer + half-res GTAO targets (call on window resize). */
  function setSize(w, h) {
    if (typeof composer.setSize === 'function') composer.setSize(w, h);
    if (typeof gtaoPass.setSize === 'function') {
      gtaoPass.setSize(Math.max(1, Math.floor(w / SSAO_RESOLUTION_DIVIDER)), Math.max(1, Math.floor(h / SSAO_RESOLUTION_DIVIDER)));
    }
  }

  function dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onResize);
    }
    if (typeof composer.dispose === 'function') composer.dispose();
    if (typeof gtaoPass.dispose === 'function') gtaoPass.dispose();
  }

  // Keep the composer in sync with window resizes (the scene.js resize
  // handler already resizes the renderer + camera; the composer + GTAO
  // targets need their own resize). Removed by dispose().
  function onResize() {
    setSize(window.innerWidth, window.innerHeight);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  return { render, setEnabled, isEnabled, setSize, dispose };
}
