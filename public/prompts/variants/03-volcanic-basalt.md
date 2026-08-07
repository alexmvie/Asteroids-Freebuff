# Asteroid Variant 3 — Volcanic Basalt

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 3 PNGs for `realistic-3-{albedo,normal,roughness}.png`.
> Self-contained — style anchors are re-listed here so Antigravity gets
> full context without referring to the master prompt.

## Deliverables (3 files, 1024×1024 each)

1. `realistic-3-albedo.png`     — sRGB
2. `realistic-3-normal.png`     — Linear (NoColorSpace)
3. `realistic-3-roughness.png`  — Linear (NoColorSpace)

Drop into `public/textures/` after generation. The engine picks this
variant by `(spec.seed >> 3) % 5 + 1 == 3` (~10% of asteroid field
spawns — distinctive, not common).

## Style anchors (binding)

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes Back
   + Return of the Jedi's Hoth sequence). Vacuum-exposed rock, not
   earth-environment stone.
2. **Lighting baked into albedo:** single warm-yellow sun light ~10°
   above horizon plane, hard baked shadows inside the texture.
3. **Vacuum has no specular:** matte surfaces only. NO specular
   highlights in the albedo for the bulk of the texture.
4. **Color palette:** very dark, sharp-edged. NO blues.
5. **Seamless tiling mandatory** — albedo + roughness must tile
   cleanly on power-of-two edges.
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).
7. **Target shape:** craggy_rock (default, the dominant shape).
   The flat-shading + sharp normal map creates the most
   faceted-as-knife-edge look on this shape.

## Variant 3 specs

### Albedo (`realistic-3-albedo.png`)
- **Base color:** very dark, sharp-edged, ~#3a3530.
- **Surface character:** angular, crystalline, sharp-edged impact
  fractures; minimal large-scale craters. The texture reads as
  "blade-broken rock", not "smooth impact-melted".
- **Fracture network:** ~20–40 sharp dark lines crisscrossing
  the tile, like a shattered windshield viewed from above.
- **Lit faces read dark warm-gray** (~#4a4540).
- **Shadow faces read near-black** (~#1a1815). High contrast —
  this is the dramatic variant.
- **Avoid blur / smoothing intent.** Edges should be crisp not
  painterly. Real basalt fractures under vacuum have very sharp
  edges.

### Normal map (`realistic-3-normal.png`)
- **High-frequency SHARP ridges; HIGH contrast.**
- Edges should be crisp / not blurred. This is the variant where
  flat-shading + sharp normal map creates the most faceted look
  in the field.
- Fracture ridges in the normal map are at near-90° angles between
  fracture walls (high contrast in R/G channels).
- This is the variant that benefits MOST from a sharp normal map —
  do NOT anti-alias or soften.

### Roughness map (`realistic-3-roughness.png`)
- **Grayscale; ~0.80 average.**
- Slight variation across surfaces — fresh-fracture surfaces
  slightly LESS rough (~0.65, they catch a tiny bit of sun spec).
- Older weathered zones slightly more rough (~0.85, dust fall).
- 0.80 reads as ~#cccccc in 8-bit.

## File output specs

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-two, required for WebGL mipmapping) |
| Format | PNG-8. NEVER JPEG. |
| Mipmaps | None baked in (Three.js generates at runtime) |
| Transparency | None; alpha ignored |

## Common regeneration traps

- **Gemini gets normal-map orientations wrong.** OpenGL standard
  is G = up, B = towards viewer. If normal maps look "inside out",
  flip G (G = 1 - G).
- **Anti-aliased fracture edges** ruin this variant. Push for
  SHARP / CRISP / BLADE-LIKE in the prompt. Re-roll if Gemini
  smooths edges.
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No transparent pixels.** Asteroids do not use alpha.
- **No JPEG** for any of these maps.

## Saving

Save to `public/textures/v{n}/realistic-3-{albedo,normal,roughness}.png`
where `n` is the iteration number (start at 1). When you settle on
the best iteration (typically the 3rd–6th), promote to
`public/textures/realistic-3-{albedo,normal,roughness}.png`.
Then move to `variants/04-cratered-icerock.md`.
