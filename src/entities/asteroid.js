import * as THREE from 'three';
import { Capsule } from '../geometry/capsule.js';
import { mulberry32 } from '../world/rng.js';
// v0.69.6 — shapeToIndex is the inverse of SHAPE_TYPES; the data-
// model layer owns the shape taxonomy so the entity factory stays
// decoupled from the named-string IDs.
import { shapeToIndex } from '../world/chunks.js';

// ---------------------------------------------------------------------------
// Deterministic 3D value noise + fbm (fractal Brownian motion). Used to
// displace the geometry vertices into asteroid-shaped silhouettes.
// ---------------------------------------------------------------------------
function hash3D(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function noise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = smoothstep(fx);
  const uy = smoothstep(fy);
  const uz = smoothstep(fz);

  const c000 = hash3D(ix, iy, iz);
  const c100 = hash3D(ix + 1, iy, iz);
  const c010 = hash3D(ix, iy + 1, iz);
  const c110 = hash3D(ix + 1, iy + 1, iz);
  const c001 = hash3D(ix, iy, iz + 1);
  const c101 = hash3D(ix + 1, iy, iz + 1);
  const c011 = hash3D(ix, iy + 1, iz + 1);
  const c111 = hash3D(ix + 1, iy + 1, iz + 1);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uz;

  return y0 + (y1 - y0) * uz;
}

function fbm3D(x, y, z, octaves = 4) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxValue;
}

// ---------------------------------------------------------------------------
// v0.71.0 -- thermal-weathering crevice layer. Models micro-erosion:
// narrow negative-displacement valleys carved into the asteroid surface
// at a decorrelated frequency. Position-based-hash (zero rng consumed):
// per-asteroid (ox, oy, oz) is the only varying input, so the erosion
// pattern for any (seed, ox, oy, oz) asteroid is fully deterministic.
//
// Tunables (SSOT-local; exposed for unit testing):
//   EROSION_SCALE_RATIO = 7 -- decorrelate from BASE (×1) and MICRO (×4).
//     7 is prime so its multiples don't align with the powers-of-2 used
//     by the base/micro fbm frequencies -- guarantees the erosion noise
//     pattern is independent of the shape-defining frequencies.
//   EROSION_AMOUNT_RATIO = 0.15 -- crevice amplitude as a fraction of
//     noiseAmount. 0.15 is small enough that the silhouette variation
//     from BASE stays the dominant visual signal (the carve "deepens"
//     existing features rather than reshaping the silhouette), and
//     large enough that a ~15%-of-radius valley is visible.
//   EROSION_EXPONENT = 2.0 -- falloff exponent for creviceDepth().
//     At exponent 2.0, only ~half the surface (where n < 0.5) gets
//     carved, and the carving is biased toward sharp narrow channels
//     rather than wide shallow dips. Increase to 3+ for narrower/more
//     sparse crevices; decrease to 1 for wider/more uniform carving.
// ---------------------------------------------------------------------------
const EROSION_SCALE_RATIO = 7;
const EROSION_AMOUNT_RATIO = 0.15;
const EROSION_EXPONENT = 2.0;

/**
 * Pure helper: returns erosion depth ∈ [0, 1] (pre-amount scaling).
 *   - n <  0.5  -> Math.pow(0.5 - n, exponent)  (valley depth)
 *   - n >= 0.5  -> 0                                (no carving)
 *
 * Exponent=2.0 -> range [0, 0.25]. Exponent=3.0 -> range [0, 0.125]
 * (narrower, more sparse). Exponent=1.0 -> range [0, 0.5] (uniform).
 *
 * Always non-negative, so the carve contributes only a negative-
 * displacement subtraction at the call site. Exposed for direct
 * unit testing (range + amplitude pinning).
 *
 * @param {number} n           fbm noise value, typically in [0, 1].
 * @param {number} [exponent]  falloff exponent (default EROSION_EXPONENT=2.0).
 * @returns {number}           erosion depth ∈ [0, 0.5^exponent]
 */
function creviceDepth(n, exponent = EROSION_EXPONENT) {
  if (!Number.isFinite(n) || n >= 0.5) return 0;
  if (n <= 0) return Math.pow(0.5, exponent);
  return Math.pow(0.5 - n, exponent);
}

// ---------------------------------------------------------------------------
// v0.71.5 -- Worley-style impact craters (research-backed: Bennu,
// Ryugu, Eros, Lutetia are covered in bowl-shaped craters with raised
// rims — real geometry, not just texture). Deterministic placement:
// crater centers are sampled on the unit sphere from a seed derived
// ONLY from (ox, oy, oz), so every (seed, ox, oy, oz) asteroid gets
// the same crater field at every LOD level (the placement ignores
// `detail`).
//
// Tunables (SSOT-local; exposed for unit testing):
//   CRATER_SCALE = 0.36 -- crater depth as a fraction of the vertex
//     radius (v0.71.6: 0.28 → 0.36). Bowl depth range [0.7..1.6] ×
//     CRATER_SCALE ≈ 0.25..0.58 of the local radius — deep enough to
//     read as real impact bowls (Bennu's craters are deep, not flat
//     stains). Rim height [0.2..0.55] × CRATER_SCALE is a visible
//     raised lip outside the bowl edge.
//   Crater angular radii 0.15..0.50 rad — a medium asteroid (r=4)
//     gets craters 0.6..2.0u across; a HUGE (r=30) gets 4.5..15u
//     craters, matching the "really huge" scale.
// ---------------------------------------------------------------------------
const CRATER_SCALE = 0.36;

/**
 * Place `count` crater centers deterministically on the unit sphere.
 * Seed = hash of (ox, oy, oz) only (no `detail`, no `seed`), so the
 * same asteroid geometry gets the same craters at every LOD level.
 * Sampling is the same uniform-on-sphere formula as
 * `randomUnitVec3` in the world layer.
 *
 * @param {number} ox  per-instance noise offset X
 * @param {number} oy  per-instance noise offset Y
 * @param {number} oz  per-instance noise offset Z
 * @param {number} count  number of craters to place
 * @returns {Array<{x:number,y:number,z:number,angularRadius:number,depth:number,rim:number}>}
 */
function placeCraterCenters(ox, oy, oz, count) {
  const rng = mulberry32(
    ((Math.floor(ox) * 73856093) ^ (Math.floor(oy) * 19349663) ^ (Math.floor(oz) * 83492791)) >>> 0,
  );
  const centers = [];
  for (let i = 0; i < count; i++) {
    const z = 1 - 2 * rng();
    const phi = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    centers.push({
      x: r * Math.cos(phi),
      y: r * Math.sin(phi),
      z,
      angularRadius: 0.15 + rng() * 0.35, // radians
      depth: 0.7 + rng() * 0.9,            // bowl depth (× CRATER_SCALE) — v0.71.6 deeper bowls
      rim: 0.2 + rng() * 0.35,             // rim height (× CRATER_SCALE) — v0.71.6 stronger rims
    });
  }
  return centers;
}

/**
 * Crater displacement contribution at a vertex direction.
 * Returns signed "crater units":
 *   - t < 1        → bowl depression −depth·(1−t)²  (deepest at center)
 *   - t ≈ 1..1.4  → gaussian raised rim (peak just outside the bowl edge)
 *   - t ≥ 1.6     → 0 (no influence)
 * Caller scales by CRATER_SCALE × vertex radius.
 *
 * @param {{x:number,y:number,z:number}} n  unit vertex direction
 * @param {{x:number,y:number,z:number,angularRadius:number,depth:number,rim:number}} c  crater center
 * @returns {number}
 */
function craterContribution(n, c) {
  const cosAngle = Math.max(-1, Math.min(1, n.x * c.x + n.y * c.y + n.z * c.z));
  const angle = Math.acos(cosAngle);
  const t = angle / c.angularRadius;
  if (t >= 1.6) return 0;
  const bowl = t < 1 ? -c.depth * Math.pow(1 - t, 2) : 0;
  const rimDist = (t - 1) / 0.25;
  const rim = c.rim * Math.exp(-rimDist * rimDist);
  return bowl + rim;
}

// ---------------------------------------------------------------------------
// v0.71.6 -- Boulder layer (research-backed: Bennu's surface is
// covered in hundreds of rocks — OSIRIS-REx counted >200 boulders
// >10 m across on a 500 m body; Ryugu and Itokawa show the same
// boulder-strewn regolith). This is the single most distinguishing
// surface feature of a real asteroid, and the v0.71.5 pass had no
// way to produce it — only craters (negative bowls) and noise bumps
// (which read as smooth hills, not discrete rocks).
//
// Boulders are positive mounds with a STEEP falloff near the edge
// (rock profile: rounded top, sharp base where the rock meets the
// regolith). Placement is deterministic from (ox, oy, oz) only (same
// seed contract as craters), so every LOD level shows the same rocks.
//
// Tunables (SSOT-local; exposed for unit testing):
//   BOULDER_SCALE = 0.22 -- rock height as a fraction of the local
//     vertex radius. A r=4 asteroid gets boulders 0.6..1.7u tall —
//     clearly protruding rocks, matching the 10-30%-of-radius
//     boulders photographed on Bennu.
//   Angular radii 0.08..0.28 rad -- rocks smaller than craters so
//     the surface reads as "big bowl craters + small pebbles" (the
//     real Bennu hierarchy).
//   sharpness 1.5..4.0 -- (1 - t²)^sharpness falloff. >2 gives the
//     rock a steep base + flat-ish top; <1.5 would read as smooth
//     hills.
// ---------------------------------------------------------------------------
const BOULDER_SCALE = 0.22;

/**
 * Place `count` boulder centers deterministically on the unit sphere.
 * Seed = hash of (ox, oy, oz) only, using a DIFFERENT prime mix than
 * `placeCraterCenters` so boulders and craters don't share placement
 * (real impact fields are decorrelated from the boulder population).
 *
 * @param {number} ox  per-instance noise offset X
 * @param {number} oy  per-instance noise offset Y
 * @param {number} oz  per-instance noise offset Z
 * @param {number} count  number of boulders to place
 * @returns {Array<{x:number,y:number,z:number,angularRadius:number,height:number,sharpness:number}>}
 */
function placeBoulderCenters(ox, oy, oz, count) {
  const rng = mulberry32(
    ((Math.floor(ox) * 2654435761) ^ (Math.floor(oy) * 1597334677) ^ (Math.floor(oz) * 805459861)) >>> 0,
  );
  const centers = [];
  for (let i = 0; i < count; i++) {
    const z = 1 - 2 * rng();
    const phi = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    centers.push({
      x: r * Math.cos(phi),
      y: r * Math.sin(phi),
      z,
      angularRadius: 0.08 + rng() * 0.2, // radians — smaller than craters
      height: 0.6 + rng() * 1.0,          // × BOULDER_SCALE
      sharpness: 1.5 + rng() * 2.5,       // rock-profile falloff exponent
    });
  }
  return centers;
}

/**
 * Boulder displacement contribution at a vertex direction.
 * Returns a POSITIVE-only mound (0 outside the rock's angular
 * radius):
 *   - t < 1 → height · (1 − t²)^sharpness  (rounded top, steep base)
 *   - t ≥ 1 → 0
 * Caller scales by BOULDER_SCALE × vertex radius.
 *
 * @param {{x:number,y:number,z:number}} n  unit vertex direction
 * @param {{x:number,y:number,z:number,angularRadius:number,height:number,sharpness:number}} b  boulder
 * @returns {number}  mound height ∈ [0, height]
 */
function boulderContribution(n, b) {
  const cosAngle = Math.max(-1, Math.min(1, n.x * b.x + n.y * b.y + n.z * b.z));
  const angle = Math.acos(cosAngle);
  const t = angle / b.angularRadius;
  if (t >= 1) return 0;
  return b.height * Math.pow(1 - t * t, b.sharpness);
}

// ---------------------------------------------------------------------------
// Geometry noise displacement. Displaces each vertex along its surface
// normal by an fbm (or crater/craggy variant) value.
// ---------------------------------------------------------------------------
function displaceGeometry(geom, noiseAmount, noiseScale, ox, oy, oz, noiseType = 'fbm', craterCount = 0, boulderCount = 0) {
  const positions = geom.attributes.position;
  const normals = geom.attributes.normal;
  if (!positions || !normals) return;

  const posArray = positions.array;
  const normArray = normals.array;

  // v0.71.5 — Worley-style impact craters. Precompute the deterministic
  // crater field once (same centers for every LOD level — placement
  // derives from ox/oy/oz only). Each vertex then adds its crater
  // contribution scaled by CRATER_SCALE × local radius, so big
  // asteroids get proportionally big craters.
  const craters = craterCount > 0 ? placeCraterCenters(ox, oy, oz, craterCount) : [];

  // v0.71.6 — Worley-style boulder field (Bennu/Ryugu signature
  // surface feature). Same deterministic contract as craters: positive
  // mounds computed once, scaled by BOULDER_SCALE × local radius.
  const boulders = boulderCount > 0 ? placeBoulderCenters(ox, oy, oz, boulderCount) : [];

  // v0.70.0 — multi-layer frequency displacement (modern game technique
  // for realistic rocky surfaces; classical id Tech / Source engine
  // approach). The BASE layer is the existing 4-octave fbm at the
  // supplied noiseScale; the MICRO layer is a 2-octave fbm at 4× scale
  // (high-frequency sub-detail that reads as crater rim roughness,
  // grain texture, and micro-occlusion under the directional light).
  // The micro layer is composited at 0.12 × amount so it stays visually
  // subordinate — the silhouette variation from the base layer still
  // dominates.
  //
  // Both noise calls operate on the existing position-based hash (no
  // external rng consumption), so the per-asteroid deterministic
  // invariant on (seed, ox, oy, oz) is preserved: same inputs →
  // same shape, just with the new high-frequency component now layered
  // on top.

  for (let i = 0; i < positions.count; i++) {
    const x = posArray[i * 3 + 0];
    const y = posArray[i * 3 + 1];
    const z = posArray[i * 3 + 2];

    const nx = normArray[i * 3 + 0];
    const ny = normArray[i * 3 + 1];
    const nz = normArray[i * 3 + 2];

    const nBase = fbm3D(
      (x + ox) * noiseScale,
      (y + oy) * noiseScale,
      (z + oz) * noiseScale,
      4,
    );
    const nMicro = fbm3D(
      (x + ox) * noiseScale * 4.0,
      (y + oy) * noiseScale * 4.0,
      (z + oz) * noiseScale * 4.0,
      2,
    );

    // v0.71.0 — thermal-weathering EROSION layer (third layer). A
    // fresh fbm3D call at EROSION_SCALE_RATIO=7 (prime, decorrelated
    // from BASE=1 and MICRO=4) drives a NEGATIVE-ONLY carve via
    // creviceDepth(). The carve is always subtracted, never added,
    // so the BASE silhouette variation stays dominant — only the
    // surface texture gets deeper narrow channels carved into it.
    // 2 octaves matches MICRO layer cost; position-based-hash (zero
    // rng consumption) → per-asteroid deterministic on
    // (seed, ox, oy, oz).
    const nErosion = fbm3D(
      (x + ox) * noiseScale * EROSION_SCALE_RATIO,
      (y + oy) * noiseScale * EROSION_SCALE_RATIO,
      (z + oz) * noiseScale * EROSION_SCALE_RATIO,
      2,
    );
    const erosionCarve = creviceDepth(nErosion) * EROSION_AMOUNT_RATIO * noiseAmount;

    // v0.71.5 — crater displacement at this vertex (world units).
    // Direction = unit vertex direction; scale = CRATER_SCALE × |v|.
    let craterMod = 0;
    if (craters.length > 0) {
      const vLen = Math.hypot(x, y, z) || 1e-6;
      const dir = { x: x / vLen, y: y / vLen, z: z / vLen };
      for (let c = 0; c < craters.length; c++) {
        craterMod += craterContribution(dir, craters[c]);
      }
      craterMod *= CRATER_SCALE * vLen;
      // v0.71.6 review fix — clamp the summed crater contribution to
      // [-0.5, 0.4] × local radius. Overlapping crater bowls (5-8
      // random placements on a small sphere) can otherwise stack the
      // negative carve to hollow-out depths on SMALL (r=2) and HUGE
      // (r=30) tiers. Single craters stay deep (real Bennu bowls are
      // ~0.2-0.35× radius); only pathological overlap gets capped.
      craterMod = Math.max(-vLen * 0.5, Math.min(vLen * 0.4, craterMod));
    }

  // v0.71.6 — boulder mounds (positive-only, added last so rocks
  // protrude FROM the cratered/noise surface).
  let boulderMod = 0;
  if (boulders.length > 0) {
    const vLen = Math.hypot(x, y, z) || 1e-6;
    const dir = { x: x / vLen, y: y / vLen, z: z / vLen };
    for (let b = 0; b < boulders.length; b++) {
      boulderMod += boulderContribution(dir, boulders[b]);
    }
    boulderMod *= BOULDER_SCALE * vLen;
    // v0.71.6 review fix — clamp the summed contribution so
    // overlapping boulder fields can't stack the mound beyond a
    // rock-plausible 0.45× radius (5-8 random placements on a small
    // body WILL overlap; without the cap a SMALL r=2 asteroid could
    // read as a blob of fused mounds).
    boulderMod = Math.min(boulderMod, vLen * 0.45);
  }

    let displacement = 0;
    if (noiseType === 'crater') {
      // Existing crater formula + micro overlay so potato craters get
      // sub-detail (sharp crater rim micro-roughness).
      const crater = nBase < 0.45
        ? -Math.pow((0.45 - nBase) * 2.2, 2.0) * noiseAmount
        : (nBase - 0.5) * 0.4 * noiseAmount;
      displacement = crater + (nMicro - 0.5) * 0.12 * noiseAmount - erosionCarve + craterMod + boulderMod;
    } else if (noiseType === 'craggy') {
      // v0.71.5 — ridged multifractal (classic Musgrave ridged noise).
      // `1 - |2n - 1|` produces sharp V-creases where the fbm crosses
      // 0.5 — real impact-fractured rock has sharp crests + flat-ish
      // valleys, not smooth sine bumps. Replaces the v0.69.5
      // `(abs(n-0.5)*2 - 0.5)` formula which read as soft rounded
      // lumps at low detail. The base noiseAmount (0.50 below) + the
      // micro layer are kept; the ridged term now drives the
      // silhouette with angular facets.
      const ridge = 1 - Math.abs(2 * nBase - 1); // [0,1], crest at n=0.5
      displacement = (ridge - 0.5) * 2 * noiseAmount
                   + (nMicro - 0.5) * 0.12 * noiseAmount
                   - erosionCarve
                   + craterMod
                   + boulderMod;
    } else {
      // Standard smooth fbm (used by spinning tops + elongated
      // potatoes) — with the micro layer + craters + boulders
      // composited on top.
      displacement = (nBase - 0.5) * 2 * noiseAmount
                   + (nMicro - 0.5) * 0.12 * noiseAmount
                   - erosionCarve
                   + craterMod
                   + boulderMod;
    }

    posArray[i * 3 + 0] = x + nx * displacement;
    posArray[i * 3 + 1] = y + ny * displacement;
    posArray[i * 3 + 2] = z + nz * displacement;
  }

  positions.needsUpdate = true;
  geom.computeVertexNormals();
}

// ---------------------------------------------------------------------------
// Geometry builders. Each shape picks a different base geometry and a
// different noise type/displacement amount so the field has visible variety.
// Shape index is derived deterministically from spec.seed % 5.
// ---------------------------------------------------------------------------
function buildSpinningTopGeometry(radius, detail, ox, oy, oz) {
  // v0.71.5 — Bennu/Ryugu-style "spinning top": an icosphere with a
  // latitudinal profile — poles pulled in, equator bulged out into a
  // ridge. Real imagery (OSIRIS-REx, Hayabusa2) shows this is one of
  // the two most common large-asteroid silhouettes (the other being
  // the contact-binary/rubble pile). Replaces the v0.69.x
  // crystalline shard, which read as a gemstone, not an asteroid.
  //
  // The latitudinal warp is a pure function of radius (no rng): the
  // per-instance (ox, oy, oz) noise offsets then add the irregular
  // rock character on top.
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const lat = y / radius;                 // -1 (south pole) .. +1 (north)
    // v0.71.6 — `Math.max(0, ...)` guard: IcosahedronGeometry detail 3
    // produces 12 vertices whose |y|/radius = 1.0000000397 (floating-
    // point overshoot past the pole). The old `1 - Math.abs(lat)` went
    // slightly negative → `Math.pow(negative, 1.5)` = NaN → the vertex
    // silently became NaN → Three.js logged "computed radius is NaN"
    // and the asteroid rendered corrupted (or vanished). The clamp
    // keeps the bulge term at exactly 0 at the poles.
    const squash = 1 - 0.32 * Math.abs(lat); // pull poles inward
    const bulge = 1 + 0.26 * Math.pow(Math.max(0, 1 - Math.abs(lat)), 1.5); // equatorial ridge
    pos.setXYZ(i, x * bulge, y * squash, z * bulge);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  // v0.71.6 — stronger base displacement (0.24 → 0.30) so the top's
  // silhouette isn't a smooth ellipsoid, plus a boulder field (5 rocks)
  // on top of the 3 craters — Bennu's equatorial ridge is littered
  // with boulders.
  displaceGeometry(geom, radius * 0.30, 2.0 / radius, ox, oy, oz, 'fbm', 3, 5);
  return geom;
}

function buildElongatedPotatoGeometry(radius, detail, ox, oy, oz) {
  // v0.71.5 — Eros-style elongated body: an icosphere stretched 1.6×
  // along X before displacement. NEAR Shoemaker photographed Eros as
  // a 34×11×11 km peanut-ish "shoe"; the stretch produces the
  // signature long-axis silhouette without the contact-binary neck.
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) * 1.6, pos.getY(i) * 0.9, pos.getZ(i) * 1.1);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  // v0.71.6 — craggy (ridged) noise at 0.38 gives Eros-style angular
  // facets; 3 craters + 6 boulders make the long axis read as a
  // rock-strewn ridge rather than a stretched ball.
  displaceGeometry(geom, radius * 0.38, 2.0 / radius, ox, oy, oz, 'craggy', 3, 6);
  return geom;
}

function buildCrateredPotatoGeometry(radius, detail, ox, oy, oz) {
  // v0.70.0 — denser segments to match the new detail=4 close-up level.
  const capSegments = detail === 4 ? 8 : (detail === 3 ? 6 : (detail === 2 ? 4 : 2));
  const radialSegments = detail === 4 ? 16 : (detail === 3 ? 12 : (detail === 2 ? 8 : 4));
  const heightSegments = detail === 4 ? 12 : (detail === 3 ? 8 : (detail === 2 ? 4 : 2));
  const length = radius * 1.5;
  const geom = new Capsule(radius, length, capSegments, radialSegments, heightSegments);
  // v0.71.6 — stronger displacement (0.22 → 0.28) + 5 craters + 7
  // boulders: the capsule body reads as a densely-cratered, boulder-
  // strewn potato (Ryugu-style) instead of a smooth bean.
  displaceGeometry(geom, radius * 0.28, 2.0 / radius, ox, oy, oz, 'crater', 5, 7);
  geom.computePlanarUVs('xy');
  return geom;
}

function buildTorusGeometry(radius, detail, ox, oy, oz) {
  // Retained for backward compat / shapeToIndex fallback path (v0.69.5
  // dropped torus asteroids from the v0.69.5 front-end, but the
  // helper still exists in case a future shape brings it back).
  const radialSegments = detail === 4 ? 16 : (detail === 3 ? 12 : (detail === 2 ? 8 : 4));
  const tubularSegments = detail === 4 ? 32 : (detail === 3 ? 24 : (detail === 2 ? 16 : 8));
  const torusRadius = radius * 0.65;
  const tubeRadius = radius * 0.28;
  const geom = new THREE.TorusGeometry(torusRadius, tubeRadius, radialSegments, tubularSegments);
  displaceGeometry(geom, radius * 0.16, 2.2 / radius, ox, oy, oz);
  return geom;
}

function buildCraggyRockGeometry(radius, detail, ox, oy, oz) {
  // v0.69.5 — bigger craggy displacement to break the soft-ball silhouette.
  // v0.70.0 — bumped amount further 0.40*radius -> 0.50*radius, paired with
  // the new high-frequency micro-displacement layer in displaceGeometry()
  // and the LOD detail bump 0..2 -> 2..4 in buildAsteroidMesh. Together
  // these deliver the v0.70.0 "really do geometry displacement mapping"
  // goal (per user feedback "all looks so flat on the asteroids"): the
  // close-up mesh now has 16× more vertices (12 -> 2562 at detail 4) so
  // the silhouette reads as a real irregular rock, the base displacement
  // is 25% bigger for stronger feature pop, and the new micro layer
  // adds sub-detail rough surface texture under the directional light.
  const geom = new THREE.IcosahedronGeometry(radius, detail);
  // v0.71.6 — ridged at 0.55 + 4 craters + 8 boulders: the classic
  // "rocky rubble" shape gets the densest boulder field of all shapes
  // (matches Bennu's boulder-strewn regolith imagery).
  displaceGeometry(geom, radius * 0.55, 2.0 / radius, ox, oy, oz, 'craggy', 4, 8);
  return geom;
}

// ---------------------------------------------------------------------------
// Texture loading + caching. Five indexed texture sets (realistic-1-
// albedo/normal/roughness/bump through realistic-5-...) are loaded
// lazily and shared via module-scope Maps. Browser-only: a stub
// THREE.Texture is returned in Node/test environments.
// ---------------------------------------------------------------------------
const albedoCache = new Map();
const normalCache = new Map();
const roughnessCache = new Map();
const bumpCache = new Map();

function loadTextureSafely(url, colorSpace) {
  let texture;
  try {
    const loader = new THREE.TextureLoader();
    texture = loader.load(url);
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  } catch (e) {
    texture = new THREE.Texture();
    texture.colorSpace = colorSpace;
  }
  return texture;
}

function getRealisticAlbedo(idx) {
  if (albedoCache.has(idx)) return albedoCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-albedo.png`, THREE.SRGBColorSpace);
  albedoCache.set(idx, tex);
  return tex;
}

function getRealisticNormal(idx) {
  if (normalCache.has(idx)) return normalCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-normal.png`, THREE.NoColorSpace);
  normalCache.set(idx, tex);
  return tex;
}

function getRealisticRoughness(idx) {
  if (roughnessCache.has(idx)) return roughnessCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-roughness.png`, THREE.NoColorSpace);
  roughnessCache.set(idx, tex);
  return tex;
}

function getRealisticBump(idx) {
  if (bumpCache.has(idx)) return bumpCache.get(idx);
  const tex = loadTextureSafely(`/textures/realistic-${idx}-bump.png`, THREE.NoColorSpace);
  bumpCache.set(idx, tex);
  return tex;
}

// v0.72.0 — per-texture-set albedo correction. The Antigravity albedo
// sets were generated brighter + cooler than real asteroids (measured
// avg luminance: set1=33, set2=104, set3=44, set4=54, set5=72). NASA
// reference albedos: C-type (carbonaceous, set1) 0.03-0.10 (~8-25),
// S-type (stony/basalt/ice, sets 2-4) 0.10-0.25 (~25-64), M-type
// (nickel-iron, set5) ~0.10-0.20. The material `color` multiplies the
// albedo map, so we can darken each set toward its physical target AND
// warm the nickel-iron set (its blue-gray cast reads as unphysical —
// real M-types are neutral gray). Indexed by textureIdx (1..5).
const ALBEDO_TINT_BY_SET = Object.freeze({
  1: 0x8a8a80, // carbonaceous: dark warm charcoal (was 33 -> target ~18)
  2: 0x56564e, // stony: darkest — measured 104 is way over S-type target
  3: 0x7a7a6e, // basalt: slight darken + warm
  4: 0x6e6e68, // ice-rock: slight darken
  5: 0x6f6a64, // nickel-iron: darken + remove blue cast (neutral-warm gray)
});

function createAsteroidMaterial(idx) {
  // v0.69.5 — matte regolith for vacuum-exposed asteroids. Per user
  // feedback "die asteroiden sollten nicht glänzen" + "alle objekte
  // glänzen viel zu viel":
  //   - metalness = 0 everywhere (was 0.1 default or 0.65 for idx=3).
  //     Real asteroids are dust/regolith exposed to vacuum; the
  //     idx=3 nickel-iron variant's higher metalness was visually
  //     wrong — there is no specular reflection in a vacuum without
  //     atmosphere.
  //   - roughness = 0.95 (was 0.9 / 0.75 / 0.45). Pushed above 0.9
  //     so the lit surface of every asteroid reads as matte dust,
  //     not polished stone. The roughnessMap still modulates per-
  //     texel detail.
  //   - bumpedScale + bumpMap REMOVED. The bumpMap was the cause of
  //     "teils sind auch schwarze linien in den asteroiden": on
  //     flat-shaded geometry, interpolated bumpMap values create
  //     visible discontinuities at texture seams (UV unwrap lines).
  //     The normalMap (which Three.js evaluates per-fragment AFTER
  //     the flat-shading normal calculation) keeps the surface
  //     detail without the seam artifact. Dropping the bumpMap also
  //     removes 4 mapped textures per asteroid slot (4 sets ×
  //     idx=1..5 = 20 cached textures, of which 4 (=1 per set) are
  //     now freed).
  return new THREE.MeshStandardMaterial({
    // v0.72.0 — per-set albedo tint (see ALBEDO_TINT_BY_SET above).
    color: ALBEDO_TINT_BY_SET[idx] ?? 0xffffff,
    metalness: 0,
    roughness: 0.95,
    flatShading: true,
    map: getRealisticAlbedo(idx),
    normalMap: getRealisticNormal(idx),
    // v0.72.0 — normalScale 1.5x. The Antigravity normal maps are weak
    // (set 2 measured meanB=167 vs ~230 for a proper tangent-space map),
    // so the surface reads as smooth plastic. Boosting the normal scale
    // makes the regolith grain + crater rim relief visible under the
    // directional sun without re-rolling the textures.
    // v0.72.2 — A/B probe (2.0 vs 1.5) measured on the showcase showed
    // NO meaningful micro-contrast gain (mean 16.5 vs 17.3, within
    // turntable-frame noise) — the geometry layers (boulders/craters/
    // micro-noise) dominate the surface read, so the weak normal maps
    // have nothing left to amplify. 1.5 stays; a real relief win needs
    // re-rolled normal maps, not more scale.
    normalScale: new THREE.Vector2(1.5, 1.5),
    roughnessMap: getRealisticRoughness(idx),
  });
}

// ---------------------------------------------------------------------------
// Main factory. Constants: split-radius, ambient-drift cap from the
// SSOT in src/world/chunk-constants.js (PLAY_PLANE_Y).
// ---------------------------------------------------------------------------
const SPLIT_RADIUS_RATIO = 0.6;
const SPLIT_KICK = 8;
const PLAY_PLANE_Y = 0;
const LOD_CLOSE_DIST = 0;
const LOD_MID_DIST = 30;
const LOD_FAR_DIST = 100;
const _scratchAxis = new THREE.Vector3();

// Tag every body mesh so the scene renderer can cast shadows. v0.68.0
// adds castShadow + receiveShadow flags at construction time so the
// sun's DirectionalLight (added in src/systems/space-lighting.js) can
// project clean asteroid-on-asteroid shadows without a per-frame
// scene walk. The ground plane (PlaneGeometry footer) receives
// shadows but does not cast them (a flat plane casting a shadow would
// be visually wrong — no shadow source above it).
function tagForShadows(mesh, { cast = true, receive = true } = {}) {
  if (!mesh) return;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
}

function buildAsteroidMesh(spec) {
  const rng = mulberry32(spec.seed);
  const group = new THREE.Group();

  // Consume a dummy RNG pull to keep the rng sequence stable across
  // species so the deterministic-asteroid tests still pass.
  rng();

  // v0.69.6 — shape distribution lifted into the data-model layer.
  // v0.69.5 (and earlier) used `spec.seed % 5` for a uniform
  // integer mapping that made craggy_rock a 40% monolith after the
  // donut was removed. Specs now carry a named-shape field
  // (`spec.shape` ∈ SHAPE_TYPES), translated to the entity-layer
  // integer via `shapeToIndex`. The `spec.seed % 5` fallback
  // preserves the v0.69.5 dispatch for any spec that lacks the
  // new field (legacy test fixtures, hand-crafted mocks) — both
  // paths produce the same geom builder for any given shape.
  const shapeType = spec.shape !== undefined
    ? shapeToIndex(spec.shape)
    : (spec.seed % 5);
  const textureIdx = ((spec.seed >> 3) % 5) + 1; // 1 through 5

  const material = createAsteroidMaterial(textureIdx);
  const radius = spec.radius;

  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const oz = rng() * 1000;

  let lod = null;

  if (shapeType === 2) {
    // v0.71.5 — Rubble Pile (Itokawa-style): 3–6 displaced lobes in a
    // loose contact pile. Hayabusa photographed Itokawa as two big
    // lobes fused by a narrow neck; the rubble-pile generalizes that
    // to N lobes of varying size so the field reads as loose
    // gravitationally-bound debris rather than a solid body. Lobe
    // layout is deterministic from a seeded rng (spec.seed), so every
    // LOD level rebuilds the SAME pile — only the mesh density
    // changes.
    lod = new THREE.LOD();

    const buildLobes = (detail) => {
      const g = new THREE.Group();
      const lobeRng = mulberry32((spec.seed ^ 0x5bd1e995) >>> 0);
      const lobeCount = 3 + Math.floor(lobeRng() * 4); // 3..6
      for (let i = 0; i < lobeCount; i++) {
        const fr = 0.45 + lobeRng() * 0.4; // lobe radius fraction of parent
        const phi = lobeRng() * Math.PI * 2;
        const dist = radius * (0.25 + lobeRng() * 0.55);
        const lobeR = radius * fr;
        const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(lobeR, detail), material);
        mesh.position.set(
          Math.cos(phi) * dist,
          (lobeRng() - 0.5) * radius * 0.6,
          Math.sin(phi) * dist,
        );
        // Per-lobe noise offsets so each rock displaces differently.
        // v0.71.6 — each lobe also gets 2-3 boulders of its own so the
        // pile reads as "loose rocks made of rocks" (Itokawa's lobes
        // are themselves covered in boulders).
        displaceGeometry(
          mesh.geometry,
          lobeR * 0.32,
          2.2 / lobeR,
          ox + i * 137,
          oy + i * 173,
          oz + i * 211,
          'craggy',
          1 + (i % 2),
          2 + (i % 2),
        );
        tagForShadows(mesh);
        g.add(mesh);
      }
      return g;
    };

    // v0.70.0 — LOD detail 4/3/2 (same rationale as the single-mesh
    // path below). The pile layout is deterministic (seeded), so all
    // three levels show the same arrangement.
    lod.addLevel(buildLobes(4), LOD_CLOSE_DIST);
    lod.addLevel(buildLobes(3), LOD_MID_DIST);
    lod.addLevel(buildLobes(2), LOD_FAR_DIST);

    group.add(lod);
  } else {
    // Single-mesh LOD shapes: crystalline, cratered potato, torus, or
    // craggy rock. The geometry builder is selected once per detail
    // level so each LOD level reads its own vertex count.
    lod = new THREE.LOD();

    const getGeom = (detail) => {
      if (shapeType === 0) return buildSpinningTopGeometry(radius, detail, ox, oy, oz);
      if (shapeType === 1) return buildCrateredPotatoGeometry(radius, detail, ox, oy, oz);
      if (shapeType === 3) return buildElongatedPotatoGeometry(radius, detail, ox, oy, oz);
      // shapeType 4 (craggy_rock) + defensive fallback for unknown
      // types (v0.69.5 removed the torus "donut"; v0.71.5 keeps the
      // craggy builder as the safe default).
      return buildCraggyRockGeometry(radius, detail, ox, oy, oz);
    };

    // v0.70.0 — LOD detail 0..2 -> 2..4 (modern-game dense meshes to do
    // real geometry displacement mapping). detail=4 gives IcosahedronGeometry
    // 2562 vertices (was 162 at detail=2) — 16× more vertices for the
    // close-up level, making the silhouette + the new high-frequency
    // micro-displacement layer visible. Performance budget: at ~150
    // asteroids in the streaming bubble, only those within LOD_MID_DIST
    // (30u) of the camera render detail=4 — typically 30-50 — so total
    // vertex count stays well under WebGL2 limits. Shadow-map pass
    // doubles the cost but is still negligible on modern GPUs.
    const meshHigh = new THREE.Mesh(getGeom(4), material);
    tagForShadows(meshHigh);
    lod.addLevel(meshHigh, LOD_CLOSE_DIST);

    const meshMid = new THREE.Mesh(getGeom(3), material);
    tagForShadows(meshMid);
    lod.addLevel(meshMid, LOD_MID_DIST);

    const meshLow = new THREE.Mesh(getGeom(2), material);
    tagForShadows(meshLow);
    lod.addLevel(meshLow, LOD_FAR_DIST);

    group.add(lod);
  }

  // v0.71.6 — debug ground footprint REMOVED. The v0.5x-era debug
  // plane (a semi-transparent dark square under every asteroid that
  // caught a fake sun shadow) was the #1 photoreal killer: in space
  // there is no ground, and the plane read as a floating dark halo
  // around each rock. Real asteroid lighting = sun shadow falls on
  // OTHER asteroids / nothing (deep space = pitch black). castShadow
  // on the body meshes already produces asteroid-on-asteroid shadows;
  // no ground plane needed.

  group.position.set(spec.position.x, spec.position.y, spec.position.z);
  group.userData.lod = lod;

  return group;
}

/**
 * Create an asteroid entity from a spec and add it to the scene.
 * @param {{
 *   spec: import('../world/types.js').AsteroidSpec,
 *   scene: import('three').Scene,
 * }} opts
 */
export function createAsteroidFromSpec({ spec, scene } = {}) {
  if (!scene) throw new Error('createAsteroidFromSpec: `scene` is required');
  if (!spec) throw new Error('createAsteroidFromSpec: `spec` is required');

  const mesh = buildAsteroidMesh(spec);
  scene.add(mesh);

  let rotation = 0;

  function update(dt, camera) {
    if (dt <= 0) return;
    rotation += spec.spin * dt;
    _scratchAxis.set(spec.axis.x, spec.axis.y, spec.axis.z);
    mesh.quaternion.setFromAxisAngle(_scratchAxis, rotation);
    mesh.position.x += spec.velocity.x * dt;
    mesh.position.z += spec.velocity.z * dt;
    mesh.position.y = PLAY_PLANE_Y;

    // v0.69.5 — fuzziness=0.5 second argument enables smooth LOD
    // transitions (per Three.js LOD API: 0 = crisp (snap at threshold),
    // 1 = maximum blur (no visible switch)). Was 0 (default) so the
    // user reported visible LOD popping when crossing the 30u
    // (mid->high) or 100u (low->mid) thresholds. 0.5 is the standard
    // crossfade value — both levels render during the transition
    // window so the change is invisible.
    const lod = mesh.userData.lod;
    if (lod && camera) lod.update(camera, 0.5);
  }

  function split() {
    if (spec.size >= 2) return [];
    const nextSize = spec.size + 1;
    const childRadius = spec.radius * SPLIT_RADIUS_RATIO;
    // Per-child seed derived from the parent — children are fully
    // deterministic so re-streaming reproduces the same split graph.
    const rng = mulberry32((spec.seed ^ (nextSize * 0x8a3779b1)) >>> 0);

    const children = [];
    for (let i = 0; i < 2; i++) {
      const angle = (i / 2) * Math.PI * 2 + rng() * 0.5;
      const offset = spec.radius * 0.4;
      const px = mesh.position.x + Math.cos(angle) * offset;
      const pz = mesh.position.z + Math.sin(angle) * offset;

      const vx = spec.velocity.x + Math.cos(angle) * SPLIT_KICK;
      const vz = spec.velocity.z + Math.sin(angle) * SPLIT_KICK;

      const uz = 1 - rng() * 2;
      const phi = rng() * Math.PI * 2;
      const ur = Math.sqrt(Math.max(0, 1 - uz * uz));
      const ax = ur * Math.cos(phi);
      const ay = ur * Math.sin(phi);
      const az = uz;

      children.push({
        id: `${spec.id}-r${i}`,
        position: { x: px, y: PLAY_PLANE_Y, z: pz },
        radius: childRadius,
        size: nextSize,
        axis: { x: ax, y: ay, z: az },
        spin: 0.5 + rng() * 1.5,
        velocity: { x: vx, y: 0, z: vz },
        seed: (rng() * 1e9) | 0,
      });
    }
    return children;
  }

  function dispose() {
    scene.remove(mesh);
    mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    });
  }

  return {
    mesh,
    spec,
    update,
    split,
    dispose,
    getRadius() { return spec.radius; },
    getSize() { return spec.size; },
    getPosition() { return mesh.position; },
    getVelocity() { return { x: spec.velocity.x, z: spec.velocity.z }; },
    setVelocity(vx, vz) {
      spec.velocity.x = vx;
      spec.velocity.z = vz;
    },
  };
}

// v0.71.0 -- crevice helper + erosion tunables exposed for direct
// unit testing (range + amplitude pin tests live in
// tests/asteroid.test.js). These are the SSOT for the erosion layer:
// if you want to retune visual impact, edit the constants here.
export {
  creviceDepth,
  EROSION_SCALE_RATIO,
  EROSION_AMOUNT_RATIO,
  EROSION_EXPONENT,
};

// v0.71.5 -- Worley-crater helpers + scale exposed for direct unit
// testing (determinism, bowl/rim geometry, world-scale pin tests live
// in tests/asteroid.test.js). SSOT for the crater layer: retune
// visual impact via CRATER_SCALE + the depth/rim ranges in
// placeCraterCenters.
export {
  placeCraterCenters,
  craterContribution,
  CRATER_SCALE,
};

// v0.71.6 -- Boulder-layer helpers + scale exposed for direct unit
// testing (determinism, positive-only mounds, steep-edge falloff,
// world-scale pin tests live in tests/asteroid.test.js). SSOT for
// the boulder layer: retune visual impact via BOULDER_SCALE + the
// height/radius ranges in placeBoulderCenters.
export {
  placeBoulderCenters,
  boulderContribution,
  BOULDER_SCALE,
};
