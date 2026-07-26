# Asteroid Variant 1 — Carbonaceous Chondrite

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 3 PNGs for `realistic-1-{albedo,normal,roughness}.png`.
> Self-contained — style anchors are re-listed here so Antigravity gets
> full context without referring to the master prompt.

## Deliverables (3 files, 1024×1024 each)

1. `realistic-1-albedo.png`     — sRGB
2. `realistic-1-normal.png`     — Linear (NoColorSpace)
3. `realistic-1-roughness.png`  — Linear (NoColorSpace)

Drop into `public/textures/` after generation. The engine picks this
variant by `(spec.seed >> 3) % 5 + 1 == 1` (~40% of asteroid field
spawns since this is the most common real type).

## Style anchors (binding)

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes Back
   + Return of the Jedi's Hoth sequence). Vacuum-exposed rock, not
   earth-environment stone.
2. **Lighting baked into albedo:** single warm-yellow sun light ~10°
   above horizon plane, hard baked shadows inside the texture.
3. **Vacuum has no specular:** matte surfaces only. NO specular
   highlights in the albedo.
4. **Color palette:** neutral warm-gray-brown. NO blues (no
   Rayleigh scatter in vacuum).
5. **Seamless tiling mandatory** — albedo + roughness must tile
   cleanly on power-of-two edges.
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).
7. **Target shape:** craggy_rock (default spherical UV, variant 3
   in the engine). Reads cleanly on contact_binary too.

## Variant 1 specs

### Albedo (`realistic-1-albedo.png`)
- **Base color:** very dark gray, ~#2a2520, almost matte black.
- **Surface character:** powdery, mostly homogeneous dust with
  occasional embedded chondrules (round pebble inclusions,
  10–30 per tile).
- **Lit faces read warm-gray** (~#3a3530).
- **Shadow faces read near-black** (~#1a1612).
- **Chondrule highlights:** small warm-toned flecks, slight rim
  light, no specular.
- **Tile seamlessly on all edges.**

### Normal map (`realistic-1-normal.png`)
- **Low-frequency, very subtle dust ripples.**
- Gentle, not pronounced — reads as soft dust under hard sun light.
- Lit-on-shadow transition encoded as a gentle G-channel shift.
- Avoid high-frequency surface texture (that's reserved for the
  crevice / displacement layer that overlays the albedo).

### Roughness map (`realistic-1-roughness.png`)
- **Grayscale; ~0.95 average (very matte).**
- Tight band, low variation across tiles.
- 0.95 reads as ~#f2f2f2 in 8-bit; aim for tight clustering near
  that value with tiny variations matching albedo chondrule
  highlights.
- No hugely different roughness regions — uniform matte dust.

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
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No transparent pixels.** Asteroids do not use alpha.
- **No JPEG** for any of these maps.

## Saving

Save to `public/textures/v{n}/realistic-1-{albedo,normal,roughness}.png`
where `n` is the iteration number (start at 1). When you settle on
the best iteration (typically the 3rd–6th), promote:

```
public/textures/v{n}/realistic-1-albedo.png    →  public/textures/realistic-1-albedo.png
public/textures/v{n}/realistic-1-normal.png    →  public/textures/realistic-1-normal.png
public/textures/v{n}/realistic-1-roughness.png →  public/textures/realistic-1-roughness.png
```

Then move to `variants/02-stony-stype.md`.
