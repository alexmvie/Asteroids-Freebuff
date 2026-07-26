# Asteroid + Ship Asset Generation — Master Prompt

> **Purpose:** Master entry point for the Antigravity 16-file asset
> generation. Paste this FIRST into Antigravity to establish project
> context, then trigger each sub-prompt under `variants/` (one at a
> time) to generate the actual PNGs.
>
> **Why split into sub-prompts:** The 16-file deliverable list
> confuses Antigravity when bundled into a single prompt — empirical
> v0.71.0 test showed it would only deliver the easiest single
> deliverable (ship hull). One sub-prompt per variant, each
> self-contained, gives consistent atomic per-variant quality.

---

## PROJECT CONTEXT — engine wire-in targets

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

Engine scene lighting:
- Single warm-yellow DirectionalLight at intensity 5.2, hard shadows
  (PCFShadowMap, no atmospheric scatter — we're in vacuum).
- Color clamp at 8-bit, so albedo must stay inside [0.05..0.85] LDR
  to avoid tone-map washout.

Failure modes to avoid:
- Black seams crossing asteroid silhouettes (UV unwrap artifacts.
  Seamlessness is mandatory).
- Specular highlights on "stone" texture (vacuum has no specular).
- Atmospheric blue tint (no Rayleigh scatter in vacuum).
- Too-low contrast between sun-lit and shadow sides (albedo must
  be dark enough that the shadow-side reads as shadow, not as black).

---

## 16 DELIVERABLES — exact file list

Drop into `public/textures/` after generation:

```
realistic-1-albedo.png    realistic-1-normal.png    realistic-1-roughness.png
realistic-2-albedo.png    realistic-2-normal.png    realistic-2-roughness.png
realistic-3-albedo.png    realistic-3-normal.png    realistic-3-roughness.png
realistic-4-albedo.png    realistic-4-normal.png    realistic-4-roughness.png
realistic-5-albedo.png    realistic-5-normal.png    realistic-5-roughness.png
ship-hull-albedo.png
```

Selection: `(spec.seed >> 3) % 5 + 1` → idx 1..5.

OPTIONAL (skip if short on time):
- `realistic-1-bump.png` … `realistic-5-bump.png` — wireframe does
  NOT consume these. Useful only for a future iteration.

---

## WORKFLOW — call order

Paste each sub-prompt into Antigravity as a fresh chat message in
this order:

1. `variants/01-carbonaceous-chondrite.md`  → 3 PNGs (albedo+normal+roughness)
2. `variants/02-stony-stype.md`             → 3 PNGs
3. `variants/03-volcanic-basalt.md`         → 3 PNGs
4. `variants/04-cratered-icerock.md`        → 3 PNGs
5. `variants/05-nickel-iron.md`             → 3 PNGs
6. `ship-hull.md`                            → 1 PNG  (last)

Save each iteration in `public/textures/v{n}/<variant>-<map>.png`
(n=1, 2, 3, ...) until you settle on the best one, then promote
the best to `public/textures/realistic-<idx>-<map>.png` /
`ship-hull-albedo.png`.

Total: 6 Antigravity calls. ~5 minutes each at typical image-gen
latencies. Schema-stable output is the goal, not uniqueness per
call — variants should look similar across regenerations within a
single ack-cycle so the field reads as one asteroid family.

---

## SHARED STYLE ANCHORS (binding for every sub-prompt)

The 5 style anchors below repeat INLINE in every sub-prompt
(self-contained) so Antigravity gets full context per chat without
needing to remember the master prompt:

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes
   Back / Return of the Jedi's Hoth sequence, but smaller and
   closer).
2. **Lighting baked into albedo:** single warm-yellow sun light
   ~10° above horizon plane, hard baked shadows in the texture
   itself.
3. **Vacuum, not atmosphere:** matte surfaces only, NO specular
   highlights in the albedo for rock textures.
4. **Color palette:** neutral gray-brown. NO blues (no Rayleigh
   scatter in vacuum). NO obvious metallics on rock surfaces
   (real asteroids are regolith, not metal).
5. **All albedo/roughness maps must tile seamlessly** — paging
   through the bubble at cruising speed should show no albedo
   discontinuity across a geometry facet. (This was the v0.69.4
   "black lines" bug; preventing at generation time is much
   easier than UV-unwrap work post-generation.)
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).

---

## SHAPE × VARIANT INTERACTION (binding for every sub-prompt)

The 4 shape types are deterministically derived from `spec.shape`
via `shapeToIndex` in `src/world/chunks.js`. The texture is
projected differently per shape — pick a consistent variant↔shape
pair so the visual character of the asteroid matches its silhouette:

| Shape | Geometry | UV unwrap | Best variant match |
|---|---|---|---|
| 0 — crystalline_shard | `CylinderGeometry` (~16 radial segs) | longitudinal | **stony S-type** or **ice-rock** (cylinder native) |
| 1 — cratered_potato | `Capsule` (custom merged-vertex) | cylindrical | **stony S-type** (its surface character = craters) |
| 2 — contact_binary | two overlapping `IcosahedronGeometry` lobes | spherical | **carbonaceous** or **nickel-iron** (avoid patterns that double-badly on twin lobes) |
| 3 — craggy_rock (default) | `IcosahedronGeometry` with craggy displacement | spherical | all variants work |

The shape↔variant assignment is **per-asteroid** (rng-driven), not
per-call. Generate each variant as a "neutral" texture that works
on the most common pairing (craggy_rock for variants 1, 2, 4;
cylindrical for 3 since basalt reads well on cylinder; carbonaceous
for 5 because metals-on-cylinder reads as "didgeridoo").

---

## v0.71.0 CONSIDERATIONS

### HUGE tier (radius 30, 5% spawn rate)
A HUGE asteroid is 10× the ship radius (which is 3 units). The same
texture (idx 1..5 by `(spec.seed >> 3) % 5 + 1`) is used — but on a
much larger surface, where pattern tiles become obvious. The
texture-pick should bias toward the more "iconic / broadly shaped"
variants. **Nickel-iron metallic on a HUGE tier reads especially
well** — the player can see the oxidation patches from far away.
Avoid heavy small-scale features in variant 4 (ice-rock) since the
~50-craters-per-tile density is unreadable at HUGE scale.

### v0.71.0 thermal-weathering CREVICE layer
The engine subtracts a narrow negative-displacement channel layer
on top of the base displacement, creating thin valleys / grooves.
The texture should be designed assuming some "weathering detail"
will overlay the visible silhouette. **Keep macro crater features
clean** (no random small dark cracks in the texture ITSELF —
let the displacement layer handle the conversation).

---

## COMMON REGENERATION TRAPS (re-listed in each sub-prompt)

- **Gemini gets normal-map orientations wrong.** OpenGL standard
  is G = up, B = towards viewer. If normal maps look "inside out"
  on the asteroids, the channels are flipped — fix by setting
  G = 1 - G in image processing.
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048) — anything
  else breaks the mipmap chain.
- **No transparent pixels.** Asteroids do not use alpha; any
  accidental transparency renders as z-fighting in the bubble.
- **No JPEG.** JPEG artifacts on normal maps look like a bumpy
  waxy surface, not clean rock.

---

## FILE OUTPUT SPEC — applies to every sub-prompt

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-two, required for WebGL mipmapping) |
| Format | PNG-8 with alpha. NEVER JPEG. |
| Color space (albedo, ship hull) | sRGB-tagged |
| Color space (normal/roughness) | Linear (NoColorSpace tag) |
| Transparency | None; alpha ignored |
| Mipmaps | None baked in (Three.js generates at runtime) |
| Tileability | seamless on power-of-two edges (mandatory) |

---

## VALIDATION CHECKLIST (run after dropping files in)

1. **Seamlessness:** cruise through the bubble (PageDown held).
   Every asteroid should have NO sharp albedo discontinuity across
   a geometry facet.
2. **Material interaction:** lit asteroids should be visibly darker
   than lit ship (the ship is metalness 0.85, asteroids 0). Lit
   side of the ship reflects more than the asteroids.
3. **Shadow realism:** the sun's DirectionalLight (PCFShadowMap)
   casts defined shadows ON the new textures. Press the thrust
   key and observe the wing shadow on the play plane.
4. **LOD smooth:** between LOD levels (0u, 30u, 100u) the detail
   drop is invisible thanks to v0.69.5's fuzziness=0.5 crossfade.
5. **HUGE tier visible:** rarest variant — confirm that the ~15
   huge asteroids per bubble all use the same idx and read as
   giant compared to ship.

---

## DROP-IN — engine wiring is automatic

The asteroid render path `createAsteroidFromSpec` → `buildAsteroidMesh`
→ `createAsteroidMaterial(idx)` already reads from these paths:

```
/textures/realistic-{1..5}-{albedo|normal|roughness}.png
```

via the `getRealisticAlbedo` / `getRealisticNormal` /
`getRealisticRoughness` cache. Just drop the files into
`public/textures/` and the next page-load picks them up.

For the ship hull texture, edit `src/entities/ship.js` to load
`/textures/ship-hull-albedo.png` as the body material's `.map`
(see `ship-hull.md` for the exact 4-line wiring snippet).

---

*Generated for the v0.71.0 asset push. The current assets work
but were the v0.69.5 first-cut. This prompt system covers the
field as the material wireframe + the displacement pipeline +
the chunk random distribution expect to receive.*
