# Asteroid Variant 2 — Stony S-Type

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 3 PNGs for `realistic-2-{albedo,normal,roughness}.png`.
> Self-contained — style anchors are re-listed here so Antigravity gets
> full context without referring to the master prompt.

## Deliverables (3 files, 1024×1024 each)

1. `realistic-2-albedo.png`     — sRGB
2. `realistic-2-normal.png`     — Linear (NoColorSpace)
3. `realistic-2-roughness.png`  — Linear (NoColorSpace)

Drop into `public/textures/` after generation. The engine picks this
variant by `(spec.seed >> 3) % 5 + 1 == 2` (~30% of asteroid field
spawns).

## Style anchors (binding)

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes Back
   + Return of the Jedi's Hoth sequence). Vacuum-exposed rock, not
   earth-environment stone.
2. **Lighting baked into albedo:** single warm-yellow sun light ~10°
   above horizon plane, hard baked shadows inside the texture.
3. **Vacuum has no specular:** matte surfaces only. NO specular
   highlights in the albedo.
4. **Color palette:** medium warm-gray-brown with slight reddish
   tint. NO blues.
5. **Seamless tiling mandatory** — albedo + roughness must tile
   cleanly on power-of-two edges.
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).
7. **Target shape:** craggy_rock (spherical UV) AND cylindrical
   shapes (crystalline_shard AND cratered_potato) — this variant
   SHOULD have isotropic crater distribution that works on both.

## Variant 2 specs

### Albedo (`realistic-2-albedo.png`)
- **Base color:** ~#807060 (slight reddish tint in the warm-gray).
- **Surface character:** mid-frequency craters + occasional cracks.
- **Crater population:** ~8–15 distinguishable craters per tile at
  varying scales (some ~50px wide, some ~250px). Crater rims
  lighter than floors (~+0.05 LDR), shadow-cast inside rims
  (~-0.10 LDR).
- **Cracks:** thin dark lines, lighter shadow at the rim, lighter
  bump at the floor. 4–8 cracks per tile.
- **Lit faces read warm-tan-gray** (~#8a7a6a).
- **Shadow faces read deep brown-gray** (~#4a3a30).

### Normal map (`realistic-2-normal.png`)
- **Medium-frequency crater rims, medium cast-shadow depth.**
- Aim for the ~8–15 craters as visually 3D features, not flat
  circles.
- Cracks as raised ridges in the normal map (R = ridge direction,
  G = away from sun).
- **CRITICAL:** Avoid patterns that mirror a single large crater
  across the edges (would double on cylindrical UV unwrap).
  Distribute craters stochastically; if a large crater is near
  an edge, replicate it on the opposite edge.

### Roughness map (`realistic-2-roughness.png`)
- **Grayscale; ~0.85 average.**
- Slight variation across surfaces — crater floors slightly less
  rough (~0.80, the powder fill is fine-grain).
- Crater rims slightly more rough (~0.90, exposed bedrock).
- 0.85 reads as ~#d8d8d8 in 8-bit.

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
- **Edge-mirroring artifacts:** the cylindrical UV unwrap of
  crystalline_shard + cratered_potato means any large crater
  near a tile edge will get mirrored. Either keep all major
  craters central, or pair-mirror them across opposite edges.
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No transparent pixels.** Asteroids do not use alpha.
- **No JPEG** for any of these maps.

## Saving

Save to `public/textures/v{n}/realistic-2-{albedo,normal,roughness}.png`
where `n` is the iteration number (start at 1). When you settle on
the best iteration (typically the 3rd–6th), promote to
`public/textures/realistic-2-{albedo,normal,roughness}.png`.
Then move to `variants/03-volcanic-basalt.md`.
