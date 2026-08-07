# 3D Asteroids — full asset regeneration prompt

Build the complete visible art-asset set for the chunked asteroid field
+ ship of an open-space Asteroids → Elite MVP. Output: **16 PNGs total**
(15 asteroid PBR maps + 1 ship hull albedo) at 1024×1024 each, all
seamlessly tileable on a power-of-two grid.

---

## ENGINE CONTEXT (wire-in targets, do not violate)

The renderer is Three.js `MeshStandardMaterial` with these exact params
(per `createAsteroidMaterial` in `src/entities/asteroid.js`):

```
metalness = 0          // vacuum has no specular
roughness = 0.95       // baseline, modulated by roughnessMap
flatShading = true     // faceted rock look, not smooth stone
map = <albedo, sRGB>
normalMap = <normal, NoColorSpace/linear>
roughnessMap = <roughness, NoColorSpace/linear>
// NO bumpMap — was removed in v0.69.5 because interpolated bumpMap
// values create visible discontinuities at flat-shaded UV seams.
```

The ship body uses `MeshStandardMaterial`:
```
metalness = 0.85, roughness = 0.45, color = #9aa5b8
flat-shaded facets; lit side reads as brushed metal.
```

Lighting in scene:
- Single warm-yellow DirectionalLight at intensity 5.2, hard shadows
  (PCFShadowMap, no atmospheric scatter).
- Color clamp at 8-bit, so albedo must stay inside [0.05..0.85] LDR to
  avoid tone-map washout.

Failure modes to avoid:
- Black seams crossing asteroid silhouettes (UV unwrap artifacts.
  Seams must tile cleanly).
- Specular highlights on "stone" surface (use matte regolith only).
- Atmospheric blue tint (we are in vacuum — no Rayleigh scatter).
- Too-low contrast on the sun-lit vs shadow side (the hard-shadow
  aesthetic demands albedo dark enough that the shadow side reads as
  shadow, not as black).

---

## REQUIRED FILE LIST

Drop into `public/textures/` after generation:

```
realistic-1-albedo.png    realistic-1-normal.png    realistic-1-roughness.png
realistic-2-albedo.png    realistic-2-normal.png    realistic-2-roughness.png
realistic-3-albedo.png    realistic-3-normal.png    realistic-3-roughness.png
realistic-4-albedo.png    realistic-4-normal.png    realistic-4-roughness.png
realistic-5-albedo.png    realistic-5-normal.png    realistic-5-roughness.png
ship-hull-albedo.png
```

Selection: `(spec.seed >> 3) % 5 + 1` → idx 1..5. Each variant must be
visually distinct enough that the player can read "this one is dusty,
this one is rocky" at a glance, but consistent enough that the overall
field reads as a single asteroid family.

OPTIONAL extras (skip if short on time, do not gate on it):
- Bump map per variant (4 maps × 5 = 20 more) — wireframe does not
  consume these; only useful for a future iteration.
- Roughness-map variant per metallic-style asteroid.

---

## STYLE ANCHORS (binding)

- **Genre:** Star Wars asteroid belt realism (Empire Strikes Back +
  Return of the Jedi's Hoth sequence, but smaller and closer).
- **Lighting baked into albedo:** single warm-yellow sun light ~10°
  above horizon plane, hard baked shadows in the texture itself.
- **Vacuum, not atmosphere:** matte surfaces only, NO specular
  highlights in the albedo for rock textures.
- **Color palette:** neutral gray-brown. NO blues (no atmospheric
  Rayleigh in vacuum). NO obvious metallics on rock surfaces (real
  asteroids are regolith, not metal).
- **All albedo/roughness maps must tile seamlessly** — paging
  through the bubble at cruising speed should show no albedo
  discontinuity across a geometry facet. This was the v0.69.4
  "black lines" bug; preventing it at generation time is much
  easier than UV-unwrap work post-generation.
- **Normal maps encode tangent-space normals** in OpenGL convention
  (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)). Standard.

---

## 5 ASTEROID SURFACE VARIANTS

For ALL variants: 1024×1024 PNG, no transparency (alpha ignored),
no mipmap artifacts baked in. Albedo is sRGB-tagged; normal +
roughness are linear.

### 1. CARBONACEOUS CHONDRITE — most common, darkest
- Color: very dark gray, ~#2a2520, almost matte black.
- Surface character: powdery, mostly homogeneous dust with
  occasional embedded chondrules (round pebble inclusions, ~10–30
  per tile).
- Normal map: low-frequency, very subtle dust ripples. Gentle, not
  pronounced. Reads as soft dust under hard sun light.
- Roughness: ~0.95 average (very matte). Tight band, low variation.
- Texture-pick-rate: ~40% of the field (most common real type).

### 2. STONY S-TYPE — medium gray, slight reddish tint
- Color: ~#807060.
- Surface character: mid-frequency craters + occasional cracks.
  Craters should be visibly 3D in the normal map, not flat circles.
  Cracks should form thin dark lines (lighter shadow at the rim,
  lighter bump at the floor).
- Normal map: medium-frequency crater rims, medium cast-shadow depth.
  Aim for 8–15 distinguishable craters per tile at varying scales.
- Roughness: ~0.85 average. Slight variation across surfaces —
  crater floors slightly less rough (the powder fill is fine-grain).
- Texture-pick-rate: ~30% of the field.

### 3. VOLCANIC BASALT — sharp fractures, dark
- Color: very dark, sharp-edged, ~#3a3530.
- Surface character: angular, crystalline, sharp-edged impact
  fractures; minimal large-scale craters. The texture reads as
  "blade-broken rock", not "smooth impact-melted".
- Normal map: high-frequency SHARP ridges; high contrast.
  Edges should be crisp (not blurred). This is the variant where
  flat-shading + sharp normal map creates the most faceted look.
- Roughness: ~0.80 average, allowing subtle specular highlights off
  fresh-fracture surfaces (still matte overall, but those edges
  catch the sun).
- Texture-pick-rate: ~10% of the field.

### 4. CRATERED ICE-ROCK — pale gray, blue-gray tint
- Color: pale gray, slight blue-gray tint, ~#9aa0a8.
- Surface character: many small impact craters (saturation
  bombardment look), some larger overlapping craters. Should look
  HEAVILY cratered — busy, not minimalist.
- Normal map: medium-frequency crater rims. Aim for 30–50
  distinguishable craters per tile, ranging from tiny pock-marks
  to a few ~200px-wide ones.
- Roughness: ~0.85 average, with bright spots at crater peaks where
  the ice has smoother reflectance (0.6-ish at peaks, 0.9 in
  shadow-side flats). The variant that benefits most from a
  varying roughness map.
- Texture-pick-rate: ~15% of the field.

### 5. NICKEL-IRON METALLIC — the only metallic variant
- Color: silver-gray, ~#6a6a70, with darker oxidation streaks
  (dark blue-gray oxidation patches, ~#3a4048).
- Surface character: mostly smooth metal surfaces with embedded
  metal flakes/crystals + a few oxidation patches.
- Normal map: subtle metal-crystal facets — sharp angles, small
  scale. Less high-frequency than basalt, more like brushed metal
  with little crystalline inclusions.
- Roughness: HIGH variation. Metal peaks ~0.4 (lets some specular
  through), oxidation patches ~0.9 (matte). The contrast between
  smooth metal and matte rust is what makes this variant read as
  "metallic-with-history".
- Texture-pick-rate: ~5% of the field (rare).

---

## SHAPE-TYPE GUIDANCE (variant × shape interaction)

The 4 shape types are deterministically derived from `spec.shape` via
`shapeToIndex`. For each shape, here is how the texture will be
projected:

### shape 0 — CRYSTALLINE SHARD (cylinder geometry, ~16% radial segments)
A faceted cylinder. The texture stretches along the cylinder
length, wraps around the cylinder radially. The texture should
emphasize LONGITUDINAL FEATURES (cracks running parallel to the
cylinder axis, vertical streaks) more than isotropic crater
patterns. Cratered variants read badly on cylindrical bodies;
prefer S-type or icy on crystalline shards for visual coherence.

### shape 1 — CRATERED POTATO (capsule geometry, cylindrical UV unwrap)
A potato-shaped body. The texture is unwrapped cylindrical (U =
angle around the body's long axis, V = position along the body).
Wide bands of distinct surface features preferred. S-type textures
read best here.

### shape 2 — CONTACT BINARY (two overlapping icospheres in a sub-group)
A peanut / dumbbell of two sphere lobes. The same texture is wrapped
around BOTH lobes. Avoid placing a "single distinguished crater" in
the texture — duplication across the two lobes would look like a
copy-paste artifact. Carbonaceous or nickel-iron read cleanly here.

### shape 3 — CRAGGY ROCK (icosahedron with craggy displacement, default)
The dominant shape. Spherical UV projection. All variants work.
This is where the strongest crater detail pays off — make sure
normal-map work is not wasted here.

---

## v0.71.0 CONSIDERATIONS

### HUGE tier (radius 30, 5% spawn rate)
A HUGE asteroid is 10× the ship radius (which is 3 units). The same
texture (idx 1..5 by `(spec.seed >> 3) % 5 + 1`) is used — but on
a much larger surface, where pattern tiles become obvious. The
texture-pick should bias toward the more "iconic / broadly shaped"
variants (carbonaceous chondrite, stony S-type). Nickel-iron
metallic on a HUGE tier reads especially well — the player can
see the oxidation patches from far away.

### CreatureCrevice thermal-weathering layer (v0.71.0)
The engine subtracts a narrow negative-displacement channel layer
on top of the base displacement, creating thin valleys / grooves.
The texture should be designed assuming some \"weathering detail\"
will overlay the visible silhouette. Keep macro crater features
clean (no random small dark cracks in the texture ITSELF —
let the displacement layer handle the conversation).

---

## SHIP HULL ALBEDO (replaces the procedural cone body)

- **Style:** brushed aluminum — slightly warmer-than-neutral gray,
  ~#7a8088. The ship is faceted + flat-shaded (4-sided pyramid body
  + cyan wings), so the texture should read on faceted geometry
  without looking like a clean white polished surface.
- **Sub-detail:** subtle panel-line details, ~1px-thick dark seams
  arranged in a grid (not too dense — 4-6 lines per axis across
  the texture, not 40). A few small rectangular \"access hatch\"
  details (4-6 spots, each ~50px wide) for visual interest.
- **Style anchor:** generic Star Wars X-Wing/Y-Wing aesthetic
  WITHOUT being a recognizable Star Wars ship. Must not look like
  fan art.
- **Tileable:** the body + 2 angled wing boxes share the same
  material. The texture needs to tile across non-square geometry
  without obvious repetition.

---

## FILE OUTPUT SPECS

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-two, required for WebGL mipmapping) |
| Format | PNG-8 with alpha. NEVER JPEG (normal maps hit JPEG artifact hell) |
| Color space (albedo, ship hull) | sRGB-tagged |
| Color space (normal/roughness) | Linear (NoColorSpace tag) |
| Transparency | None; alpha ignored |
| Mipmaps | None baked in (Three.js generates at runtime) |

---

## DROP-IN LOCATIONS

```
public/textures/
├── realistic-1-albedo.png
├── realistic-1-normal.png
├── realistic-1-roughness.png
├── realistic-2-albedo.png
├── realistic-2-normal.png
├── realistic-2-roughness.png
├── realistic-3-albedo.png
├── realistic-3-normal.png
├── realistic-3-roughness.png
├── realistic-4-albedo.png
├── realistic-4-normal.png
├── realistic-4-roughness.png
├── realistic-5-albedo.png
├── realistic-5-normal.png
├── realistic-5-roughness.png
└── ship-hull-albedo.png
```

The renderer already wires up these URLs:
`/textures/realistic-{1..5}-{albedo|normal|roughness}.png` + the
ship uses `/textures/ship-hull-albedo.png` if you wire it into
`ship.js`. The asset loader registers at module-load (`getRealistic*`
caches), so the order in which files exist on disk does not matter.

---

## WIRING (after generation)

The asteroid render path is `createAsteroidFromSpec` → `buildAsteroidMesh`
→ `createAsteroidMaterial(idx)` and **already reads from the paths
above** via the `getRealisticAlbedo` / `getRealisticNormal` /
`getRealisticRoughness` cache. Just drop the files into
`public/textures/` and the next page-load picks them up.

For the ship hull texture to actually take effect, edit
`src/entities/ship.js` to load it as the body material's `.map`:

```js
import { TextureLoader, SRGBColorSpace, RepeatWrapping } from 'three';

const hullTex = new TextureLoader().load('/textures/ship-hull-albedo.png');
hullTex.colorSpace = SRGBColorSpace;
hullTex.wrapS = RepeatWrapping;
hullTex.wrapT = RepeatWrapping;
bodyMat.map = hullTex;
```

without overriding the body material's `color`, `metalness`,
`roughness`, or `flatShading` (the brushed-metal look is in those
params, not the albedo).

---

## VALIDATION CHECKLIST AFTER APPLYING

1. **Seamlessness:** cruise through the bubble (PageDown held). Every
   asteroid should have NO sharp albedo discontinuity across a
   geometry facet.
2. **Material interaction:** lit asteroids should be visibly darker
   than lit ship (the ship is metalness 0.85, asteroids 0). Lit
   side of the ship reflects more than the asteroids.
3. **Shadow realism:** the sun's DirectionalLight (PCFShadowMap)
   should cast defined shadows ON the new textures. Press the
   thrust key and observe the wing shadow on the play plane.
4. **LOD smooth:** between LOD levels (0u, 30u, 100u) the detail
   drop should be invisible thanks to v0.69.5's fuzziness=0.5
   crossfade.
5. **HUGE tier visible:** rarest variant — confirm that the ~15 huge
   asteroids per bubble all use the same idx and read as giant
   compared to ship.

---

## COMMON REGENERATION TRAPS

- **Gemini gets normal-map orientations wrong.** The OpenGL standard
  is G = up, B = towards viewer. If your normal maps look \"inside
  out\" on the asteroids, the channels are flipped — fix by setting
  G = 1 - G in image processing.
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048) — anything
  else breaks the mipmap chain.
- **No transparent pixels.** Asteroids do not use alpha; any
  accidental transparency will render as z-fighting in the bubble.
- **No JPEG.** JPEG artifacts on normal maps look like a bumpy
  waxy surface, not clean rock.

---

*Generated for the v0.71.0 visual push. The current assets work but
were the v0.69.5 first-cut. This prompt covers the field as the
material wireframe + the displacement pipeline + the chunk random
distribution expect to receive.*
