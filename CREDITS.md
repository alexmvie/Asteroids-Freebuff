# Credits

Third-party assets used in this project, with their required attribution.

## Background nebula — `public/bgnebula/bgnebula-2.png` (and `bgnebula-2k.png`)

**Subject:** user-generated equirectangular skydome / background nebula for the 3D Asteroids game.

**Source:** created with **Nano Banana** (Google's Gemini image model). The user provided the prompt and Gemini rendered the image at 2912×1440 px as an equirectangular projection.

**Files:**

- `public/bgnebula/bgnebula-2.png` — 2912×1440, PNG (lossless), 4.7 MB. Used as the default 2K variant.
- `public/bgnebula/bgnebula-2k.png` — 1024×506, PNG (lossless), ~400 KB. Used by `pickNebulaUrl()` for `navigator.connection.saveData` / `prefers-reduced-data` clients.

**Aspect-ratio note:** the source is **2.02:1 (2912×1440)**, essentially the standard equirectangular 2:1 (the 1% deviation is invisible at game scale). Three.js's `EquirectangularReflectionMapping` uses the texture as-is.

**Provenance / iteration history:**

1. **v0** — Wikipedia Horsehead Nebula image (dropped: returned 404).
2. **v0'** — ESA/Hubble Horsehead `heic1307a.jpg` (dropped: still 404; would have needed offline aspect-ratio crop).
3. **v0''** — ESA/Hubble Carina `heic0707a.jpg` (CC-BY-4.0, processed to 4096×2048 JPEG). Removed in favor of user-generated content.
4. **v1** — Nano Banana skydome `skydome-1.png` (2816×1536, 1.83:1 aspect ratio, caused a small non-uniform longitude scale on the sphere).
5. **v2 (current)** — Nano Banana `bgnebula-2.png` (2912×1440, 2.02:1 — essentially 2:1). See `AGENTS.md` → Nebula background for the full data-flow / streaming context.

**License / attribution:** user-generated for this project. No third-party license required; credit to "Nano Banana (Google Gemini)" is appreciated in any downstream distribution.

## Asteroid PBR texture set — `public/textures/asteroid-{albedo,normal,roughness,bump}.png`

**Subject:** rocky asteroid PBR texture set used by the `MeshStandardMaterial` on every asteroid body (noisy icosphere + capsule). The user provided a single 2048×2048 atlas which is split into 4 separate textures at build time.

**Source atlas:** created with **Nano Banana** (Google's Gemini image model). The user provided the prompt and Gemini rendered the image at 2048×2048 px as a **2×2 texture collection** (left-to-right, top-to-bottom reading order: albedo, normal, roughness, bump) with a ~10 px black outline separating the quadrants.

**Atlas layout (2048×2048):**

```
+---------------+---------------+
|   albedo      |   normal      |   1018x1019
|   (sRGB)      |   (linear)    |
+---------------+---------------+
|   roughness   |   bump        |   ~1018x1018
|   (linear)    |   (linear)    |
+---------------+---------------+
```

**Files (cropped + resized to 1024×1024 each, power-of-two):**

- `public/textures/asteroid-albedo.png` — 1024×1024, ~1.8 MB. sRGB color.
- `public/textures/asteroid-normal.png` — 1024×1024, ~2.0 MB. Linear data (`NoColorSpace`).
- `public/textures/asteroid-roughness.png` — 1024×1024, ~2.0 MB. Linear data (`NoColorSpace`).
- `public/textures/asteroid-bump.png` — 1024×1024, ~1.4 MB. Linear data (`NoColorSpace`).

**Crop + resize commands** (one-liners, run from project root):

```sh
# Each crop uses a 1px margin from the separator so the black
# outline never enters the final material. The `!` forces exact
# 1024×1024 (without it ImageMagick preserves aspect ratio and
# can land at 1023×1024, which loses mipmap support).
magick public/textures/asteroid-1.png -crop 1018x1019+0    +0    +repage -resize 1024x1024! public/textures/asteroid-albedo.png
magick public/textures/asteroid-1.png -crop 1019x1019+1029 +0    +repage -resize 1024x1024! public/textures/asteroid-normal.png
magick public/textures/asteroid-1.png -crop 1018x1018+0    +1030 +repage -resize 1024x1024! public/textures/asteroid-roughness.png
magick public/textures/asteroid-1.png -crop 1019x1018+1029 +1030 +repage -resize 1024x1024! public/textures/asteroid-bump.png
```

The `public/textures/asteroid-1.png` master atlas can be kept as-is or deleted once the 4 crops are committed; the runtime never references it.

**Color-space discipline.** Three.js applies the sRGB gamma curve to color textures and the *inverse* to data textures. Mixing these up silently ruins the look: an albedo loaded as linear washes out, a normal loaded as sRGB double-decodes. The lazy loaders in `src/entities/asteroid.js` set `colorSpace` per texture:

- `getAsteroidAlbedo()` — `SRGBColorSpace`
- `getAsteroidNormal()` — `NoColorSpace`
- `getAsteroidRoughness()` — `NoColorSpace`
- `getAsteroidBump()` — `NoColorSpace`

**Material setup** (`src/entities/asteroid.js`):

```js
new THREE.MeshStandardMaterial({
  map: getAsteroidAlbedo(),
  normalMap: getAsteroidNormal(),
  roughnessMap: getAsteroidRoughness(),
  bumpMap: getAsteroidBump(),
  metalness: 0.1,
  roughness: 0.9,  // icosphere; 0.85 for capsule — becomes a multiplier
                    // when roughnessMap is set
  bumpScale: 0.05, // subtle relief; tunable per-material
  flatShading: true,
})
```

**UV mapping:**

- The **noisy icosphere** body inherits its UV attribute from the underlying `IcosahedronGeometry` (built-in spherical projection — no extra work).
- The **capsule** body uses a custom cylindrical unwrap: `U = atan2(z, x) / (2π) + 0.5` (longitude, [0, 1)), `V = (y - yMin) / (yMax - yMin)` (latitude, [0, 1]). See `Capsule.computeUVs()` in `src/geometry/capsule.js`. Called AFTER `geom.jitter(...)` so the UVs align with the displaced surface.

**Regression tests** in `tests/asteroid-textures.test.js`:

- All 4 files exist, are non-trivial (>100 KB), and have a valid PNG signature.
- All 4 are exactly 1024×1024 (power-of-two, full mipmap support).
- The black separator outline is not in any crop (no pure-black corner pixels in any of the 4 maps).

**License / attribution:** user-generated for this project. No third-party license required; credit to "Nano Banana (Google Gemini)" is appreciated in any downstream distribution.
