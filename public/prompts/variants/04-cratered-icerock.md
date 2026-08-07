# Asteroid Variant 4 — Cratered Ice-Rock

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 3 PNGs for `realistic-4-{albedo,normal,roughness}.png`.
> Self-contained — style anchors are re-listed here so Antigravity gets
> full context without referring to the master prompt.

## Deliverables (3 files, 1024×1024 each)

1. `realistic-4-albedo.png`     — sRGB
2. `realistic-4-normal.png`     — Linear (NoColorSpace)
3. `realistic-4-roughness.png`  — Linear (NoColorSpace)

Drop into `public/textures/` after generation. The engine picks this
variant by `(spec.seed >> 3) % 5 + 1 == 4` (~15% of asteroid field
spawns).

> **Special scaling caveat (v0.71.0):** This variant has ~30–50 small
> craters per tile. On a standard-sized asteroid (r=4..8), that's a
> nice busy read. On a HUGE tier (r=30, 10× ship) the pattern tiles
> become unreadable and the surface looks like noise. If you want the
> variant 4 to read well on HUGE too, consider keeping the crater
> density in the ~5–15 range, with a few larger overlapping craters
> (~200px) as anchors.

## Style anchors (binding)

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes Back
   + Return of the Jedi's Hoth sequence). Vacuum-exposed frozen
   regolith, not earth-environment stone.
2. **Lighting baked into albedo:** single warm-yellow sun light ~10°
   above horizon plane, hard baked shadows inside the texture.
3. **Vacuum has no specular:** the bulk of the surface is matte
   powdered ice with thin specular at peaks.
4. **Color palette:** pale gray, slight blue-gray tint (the only
   variant with any hint of blue — it's the "ice" character, not
   atmospheric scatter).
5. **Seamless tiling mandatory** — albedo + roughness must tile
   cleanly on power-of-two edges.
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).
7. **Target shape:** cratered_potato (cylindrical UV) is the
   natural fit — the capsule's been cratered by impacts. Also
   reads on craggy_rock.

## Variant 4 specs

### Albedo (`realistic-4-albedo.png`)
- **Base color:** pale gray, slight blue-gray tint, ~#9aa0a8.
- **Surface character:** many small impact craters (saturation
  bombardment look), some larger overlapping craters. Should look
  HEAVILY cratered — busy, not minimalist.
- **Crater population:** ~30–50 distinguishable craters per tile,
  ranging from tiny pock-marks (~10px) to a few ~200px-wide ones.
- **Crater floors:** slightly darker than surface (~-0.05 LDR),
  bluish-gray.
- **Crater rims:** slightly lighter than surface (~+0.05 LDR),
  with the rim peak catching sun light.
- **Lit faces read pale blue-gray** (~#aab0b8).
- **Shadow faces read deep navy-gray** (~#4a5058). The slight blue
  tint holds in shadow, unlike the warm-gray variants.

### Normal map (`realistic-4-normal.png`)
- **Medium-frequency crater rims.** Aim for the ~30–50 craters
  as visually 3D features with clear circular rim shadows.
- Crater interiors should have soft mid-frequency ridges inside
  (a frozen surface has ice that has flowed a bit then re-frozen
  inside the crater bowl).
- **Avoid tile-mirror:** since this texture reads on the
  cylindrical UV of cratered_potato, asymmetric crater placement
  prevents the cylinder's U-wrap from creating visibly doubled
  patterns.

### Roughness map (`realistic-4-roughness.png`)
- **Grayscale; ~0.85 average.**
- **Varying across surfaces:** crater peaks ~0.60 (smoother ice
  reflectance), crater floors ~0.90, surrounding flats ~0.85.
- The contrast between bright-smooth ice peaks and dark-rough
  crater floors is what makes this variant read as "icy".
- 0.85 reads as ~#d8d8d8 in 8-bit; crater peaks read ~#999999
  (0.60), crater floors read ~#e6e6e6 (0.90).

## File output specs

| Property | Value |
|---|---|
| Resolution | 1024×1024 (power-of-two, required for WebGL mipmapping) |
| Format | PNG-8. NEVER JPEG. |
| Mipmaps | None baked in (Three.js generates at runtime) |
| Transparency | None; alpha ignored |

## Common regeneration trapped traps

- **Gemini gets normal-map orientations wrong.** OpenGL standard
  is G = up, B = towards viewer. If normal maps look "inside out",
  flip G (G = 1 - G).
- **Too-cool palette drift:** if the variant-4 albedo looks
  BLUE, not blue-gray, re-prompt with "warm tint, not saturated
  blue" + "this is dust-frozen, not ocean-water". Real asteroid
  ice-rock is gray, not blue.
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No transparent pixels.** Asteroids do not use alpha.
- **No JPEG** for any of these maps.

## Saving

Save to `public/textures/v{n}/realistic-4-{albedo,normal,roughness}.png`
where `n` is the iteration number (start at 1). When you settle on
the best iteration (typically the 3rd–6th), promote to
`public/textures/realistic-4-{albedo,normal,roughness}.png`.
Then move to `variants/05-nickel-iron.md`.
