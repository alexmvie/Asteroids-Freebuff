# Asteroid + Ship Asset Regeneration Prompt

> **Purpose:** Give the user a single, copy-pasteable prompt that they
> can feed to Nano Banana (Google Gemini image model) or Antigravity
> to regenerate the realistic asteroid + ship textures that ship with
> the game. The current textures were a first cut; v0.69.5's matte
> material + bigger craggy displacement + brushed-metal ship make the
> textures the next-bottleneck for visual realism.

---

## Style anchors

- **Genre:** Star Wars asteroid belt realism (Empire Strikes Back /
  Return of the Jedi's Hoth asteroid sequence, but smaller / closer).
- **Lighting baked into albedo:** single warm-yellow sun light
  direction (~10° above horizon plane, hard shadows in the texture).
- **No atmospheric scatter** → matte surfaces, NO specular highlights
  in the albedo.
- **Color palette:** neutral gray-brown. NO blues (the vacuum
  removes atmospheric Rayleigh scatter). NO obvious metallics on
  the asteroids themselves (real asteroids are regolith, not metal).
- **All tiles must tile** seamlessly. Texture seam artifacts were
  the cause of "black lines" in the v0.69.4 build —
  preventing-this-at-generation-time is much easier than UV-unwrapping
  work post-generation.

---

## Five realistic asteroid surface textures

For each variant, generate 1024×1024 PNG outputs with **these maps**:

1. **albedo** (base color, sRGB color space)
2. **normal** (tangent-space normal map, R=X, G=Y, B=Z; encoded with
   the standard `(0.5, 0.5, 0.5)` neutral middle for OpenGL).
3. **roughness** (grayscale; 0.0=smooth, 1.0=rough).
4. **bump** (grayscale height map; optional — v0.69.5 wireframe
   pipeline doesn't USE this map but having it available lets a
   future iteration swap back to bumpMap without re-prompting).

### Five variant concepts

#### 1. Carbonaceous chondrite

- Most common real asteroid type.
- **Color:** very dark gray (~#2a2520), almost black.
- **Surface character:** powdery, mostly homogeneous dust with
  occasional embedded chondrules (round pebble inclusions).
- **Normal map detail:** low-frequency, very subtle dust ripples.
- **Roughness map:** ~0.95 average (very matte).

#### 2. Stony S-type

- Medium gray, slight reddish tint (~#807060).
- **Surface character:** mid-frequency craters + occasional cracks.
- **Normal map detail:** medium-frequency crater rims, medium cast
  shadow depth.
- **Roughness map:** ~0.85 average (slightly less matte than #1).

#### 3. Volcanic basalt

- Very dark, sharp-edged fracture lines (~#3a3530).
- **Surface character:** angular, crystalline, sharp-edged impact
  fractures; minimal large-scale crater features.
- **Normal map detail:** high-frequency sharp ridges; high contrast.
- **Roughness map:** ~0.80 average (subtle specular reflections off
  fresh-fracture surfaces).

#### 4. Cratered ice-rock

- Pale gray, slight blue-gray tint (~#9aa0a8).
- **Surface character:** many small impact craters (saturation
  bombardment look), some larger overlapping craters.
- **Normal map detail:** medium-frequency crater rims.
- **Roughness map:** ~0.85 average, with bright spots at crater
  peaks where the ice has smoother reflectance.

#### 5. Nickel-iron metallic (the only metallic variant)

- Silver-gray (~#6a6a70) with darker oxidation streaks.
- **Surface character:** mostly smooth metal surfaces with embedded
  metal flakes/crystals + a few oxidation patches (dark blue-gray).
- **Normal map detail:** subtle metal-crystal facets (sharp angles,
  small scale).
- **Roughness map:** HIGH VARIATION — metal peaks ~0.4 (lets some
  specular through), oxidation patches ~0.9 (matte).

---

## One ship hull texture (replaces the procedural cone body)

- **Style:** brushed aluminum — slightly warmer-than-neutral gray
  (~#7a8088).
- **Sub-detail:** subtle panel-line details, ~1px-thick dark seams
  arranged in a grid; a few small rectangular "access hatch"
  details (4-6 spots, each ~50px wide).
- **Suggest an X-Wing / Y-Wing aesthetic** WITHOUT being a
  recognizable Star Wars ship — keep it generic enough that the
  ship doesn't look like fan art.
- **Tileable:** a 4-sided pyramid body + 2 angled wing boxes share the
  same material; the texture needs to tile across non-square
  geometry without obvious repetition.

---

## File output specs

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-2 — required for WebGL mipmapping) |
| Format | PNG (NEVER JPEG — normal maps hit JPEG artifact hell) |
| Color space (albedo) | sRGB |
| Color space (normal/bump/roughness) | Linear |

---

## Drop-in file locations

After generation, copy the files into place:

```
public/textures/
├── realistic-1-albedo.png
├── realistic-1-normal.png
├── realistic-1-roughness.png
├── realistic-1-bump.png
├── ...same for idx 2, 3, 4, 5...
└── ship-hull-albedo.png   ← NEW (for ship replacement)
```

If you skip the bump map (Gemini doesn't always do grayscale well),
that's fine — the v0.69.5 wireframe explicitly doesn't use it.

---

## Wiring the ship-hull-albedo.png texture (for after generation)

After the ship hull texture is dropped into `public/textures/`, edit
`src/entities/ship.js` to load it as the body + wings' `.map`:

```js
// At top of createShip body section:
import { TextureLoader, SRGBColorSpace, RepeatWrapping } from 'three';
// (TextureLoader already available via scene.js's THREE import)

// After metalness/roughness params in bodyMat:
const hullTex = new TextureLoader().load('/textures/ship-hull-albedo.png');
hullTex.colorSpace = SRGBColorSpace;
hullTex.wrapS = RepeatWrapping;
hullTex.wrapT = RepeatWrapping;
bodyMat.map = hullTex;
// Same for wingMat
```

Repeat for the wing material with a separate cyan-tinted procedural
texture (or apply a `.color` blend via a duplicated texture).

---

## Expected iteration

First-time asset generation typically needs 4-6 prompt regenerations
before the textures match the style anchors. Save the prompts that
worked under `public/textures/prompts/v1.md` so iteration history
survives future commits.

---

## Validation checklist after applying

1. Tile seamlessness: hold PageDown to fly through the bubble; visually
   inspect that no asteroid has a sharp albedo discontinuity across a
   geometry facet.
2. Material interaction: confirm the matte asteroid material + the
   brushed-metal ship material read correctly together. Lit side of
   the ship should reflect MORE than the asteroids (high metalness).
3. Shadow realism: confirm the sun's DirectionalLight (5.2 intensity,
   PCFShadowMap) casts defined shadows on the new textures.
4. LOD smooth: confirm the v0.69.5 fuzziness=0.5 LOD transitions
   don't snap visible at any camera distance.

---

*Generated for the v0.69.5 visual-polish wave. The asteroids are
visible-now matte + craggy, the ship is brushed-metal, the sun is
halo-less. The textures are the next-bottleneck.*
