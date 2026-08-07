# Ship Hull — Brushed-Aluminum Albedo

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 1 PNG for `ship-hull-albedo.png`. Self-contained —
> style anchors are re-listed here so Antigravity gets full context
> without referring to the master prompt.

## Deliverable (1 file, 1024×1024)

1. `ship-hull-albedo.png` — sRGB

Drop into `public/textures/`. After dropping, also wire it into
`src/entities/ship.js` (snippet at the bottom of this file).

## Style anchors (binding)

1. **Genre:** generic Star Wars X-Wing/Y-Wing aesthetic WITHOUT
   being a recognizable Star Wars ship. Must not look like fan
   art.
2. **Material wire-in (already done in `src/entities/ship.js`):**
   - `color = 0x9aa5b8` (currently used; the texture MULTIPLIES
     this color, so the texture should be ~0.85+ neutral-gray to
     hold the brushed-metal character).
   - `metalness = 0.85`
   - `roughness = 0.45`
   - `flatShading = true` (the ship body is a 4-sided pyramid +
     two angled wing boxes; flat-shaded facets are part of the
     silhouette read).
3. **Lighting in scene:** single warm-yellow DirectionalLight at
   intensity 5.2 with hard shadows (PCFShadowMap).
4. **No atmospheric scatter** — matte + metal, no specular
   highlights in the texture itself.
5. **Tileability:** the body + 2 angled wing boxes share the same
   material. The texture needs to tile across non-square geometry
   without obvious repetition.

## Specs

### Albedo (`ship-hull-albedo.png`)
- **Base color:** slightly warmer-than-neutral gray, ~#7a8088
  (since it will MUL `color = 0x9aa5b8`, the final rendered color
  is ~0x6e7480, which reads as a proper brushed-metal gray).
- **Style:** brushed aluminum — directional grain texture, very
  subtle, not obvious.
- **Sub-detail:** subtle panel-line details, ~1px-thick dark seams
  arranged in a grid (not too dense — 4–6 lines per axis across
  the texture, not 40).
- **Access hatches:** a few small rectangular details, 4–6 spots,
  each ~50px wide, for visual interest.
- **Tile seamlessly** on power-of-two edges.

## File output specs

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-two, required for WebGL mipmapping) |
| Format | PNG-8. NEVER JPEG. |
| Color space | sRGB-tagged |
| Mipmaps | None baked in (Three.js generates at runtime) |
| Transparency | None; alpha ignored |

## Wire-in snippet (run after generation)

After dropping the file into `public/textures/`, edit
`src/entities/ship.js` to load it as the body material's `.map`:

```js
import { TextureLoader, SRGBColorSpace, RepeatWrapping } from 'three';

const hullTex = new TextureLoader().load('/textures/ship-hull-albedo.png');
hullTex.colorSpace = SRGBColorSpace;
hullTex.wrapS = RepeatWrapping;
hullTex.wrapT = RepeatWrapping;
bodyMat.map = hullTex;
// (Optional: same for wingMat — or leave wing as solid cyan for
// contrast with the body.)
```

WITHOUT overriding the body material's `color`, `metalness`,
`roughness`, or `flatShading` — the brushed-metal look lives in
those parameters, not in the albedo.

## Common regeneration traps

- **Too-busy panel-line grid** (40+ seams) makes the ship look
  like a blueprint, not a worn starfighter. Re-prompt with
  "minimal panel detail, 4-6 seams total".
- **Color drift toward blue:** the warm-gray target is strict;
  if it looks cool-blue re-prompt with "warm neutral gray, no
  cool tint".
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No JPEG** for this map.

## Saving

Save to `public/textures/v{n}/ship-hull-albedo.png` where `n` is
the iteration number. When you settle on the best iteration
(typically the 2nd–4th — panel detail usually needs fewer tries
than PBR variants), promote to
`public/textures/ship-hull-albedo.png`.

---

**That completes the 16-PNG generation.** Drop the 6 promoted files
into `public/textures/` (5 variant sets × 3 maps + 1 ship hull),
reload the browser, and verify against the validation checklist
in `README.md`.
