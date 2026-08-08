/**
 * SSAO tunables — the single source of truth for the v0.73.0
 * screen-space ambient occlusion postprocessing pass.
 *
 * @fileoverview Mirrors the SSOT pattern of `src/scene/camera-constants.js`
 * and `src/scene/lighting-constants.js`: a dedicated module owns the literal
 * values; consumers import the names rather than inlining magic numbers.
 * Adjust here — every consumer follows.
 *
 * The pass is a three.js EffectComposer chain:
 *   RenderPass → GTAOPass (ground-truth ambient occlusion) → OutputPass.
 * The OutputPass is REQUIRED because three r152+ only applies tone mapping
 * (ACES) + output color space when rendering to the null (screen) render
 * target — inside a composer the scene renders linear, so the final pass
 * re-applies ACES + sRGB. Without it the whole frame would look washed out.
 */

/**
 * Whether SSAO is enabled at boot. `window.SSAO` (devtools) + the
 * `#debug-toggle-ssao` HUD button override it at runtime; the getter/
 * setter routes to `ssao.setEnabled(...)` so the toggle is live.
 *
 * Default OFF (v0.73.0 initial ship): the GTAO GBuffer pass re-renders
 * the whole scene once with a normal-material override — a second full
 * scene draw per frame. Measured in headless Chrome (software
 * rasterizer): 20.3 FPS → 4.7 FPS on a 300-asteroid demo field (real
 * GPUs are far faster, but the doubling of rasterization work is real).
 * The feature is the A/B realism lever: flip it ON with the HUD button
 * or `window.SSAO = true` to see contact shadows in craters/rock gaps,
 * OFF for the fast path. Flip this to true if the field of play is
 * small enough that the double pass stays at 60 FPS on target hardware.
 */
export const SSAO_ENABLED_DEFAULT = false;

/**
 * GTAO sampling radius, in VIEW-SPACE (world) units. Samples within this
 * distance of a fragment can occlude it. Asteroids are 8–30 units wide
 * and the showcase/game cameras sit ~24 units out, so crater rims and
 * boulder gaps (features ~1–3u) need a radius of ~2u to catch contact
 * shadows; the three.js stock example (radius 0.25) targets unit-scale
 * demo scenes and is far too small here.
 */
export const SSAO_RADIUS = 3.5;

/**
 * GTAO thickness — the view-space depth range that counts as "nearby"
 * geometry for occlusion. Too small → AO fades instantly on angled
 * surfaces; too large → bleeding/dark halos across gaps. 2.0 balances
 * both for the field's asteroid scale.
 */
export const SSAO_THICKNESS = 3.5;

/**
 * Falloff exponent over the sample steps: higher concentrates samples
 * near the fragment (crisper contact shadows), lower spreads them out
 * (softer, wider AO). 1.5 is a middle ground for rocky surfaces.
 */
export const SSAO_DISTANCE_EXPONENT = 1.5;

/** Extra falloff applied to far samples (1.0 = stock behavior). */
export const SSAO_DISTANCE_FALL_OFF = 1.0;

/**
 * Power applied to the raw AO term (`ao = pow(ao, scale)`). >1 darkens
 * the final occlusion (more visible contact shadows), <1 lightens it.
 */
export const SSAO_SCALE = 1.3;

/** GTAO hemisphere samples per fragment (16 = stock example quality). */
export const SSAO_SAMPLES = 16;

/**
 * AO resolution divider: GTAO renders at (width/SSAO_RESOLUTION_DIVIDER,
 * height/...) — 2 = half resolution, the standard perf/quality tradeoff
 * (AO is a low-frequency signal; the Poisson denoise pass hides the
 * undersampling). 1 = full resolution for max quality.
 */
export const SSAO_RESOLUTION_DIVIDER = 2;

/**
 * Final AO blend strength (0 = no AO, 1 = full, >1 = boosted). Wired to
 * `gtaoPass.blendIntensity`.
 */
export const SSAO_BLEND_INTENSITY = 1.0;

/**
 * Poisson-denoise parameters (smooths the GTAO undersampling into soft
 * gradients). Tuned conservatively: luma/depth/normal edge-phis low
 * enough to preserve crater rim detail while killing noise speckle.
 */
export const SSAO_DENOISE = Object.freeze({
  lumaPhi: 10,
  depthPhi: 2,
  normalPhi: 3,
  radius: 8,
  radiusExponent: 2,
  rings: 2,
  samples: 16,
});
