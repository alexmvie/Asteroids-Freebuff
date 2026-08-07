# Asteroid Variant 5 — Nickel-Iron Metallic

> **Use:** Paste this prompt into Antigravity as a single chat message.
> Generates exactly 3 PNGs for `realistic-5-{albedo,normal,roughness}.png`.
> Self-contained — style anchors are re-listed here so Antigravity gets
> full context without referring to the master prompt.

## Deliverables (3 files, 1024×1024 each)

1. `realistic-5-albedo.png`     — sRGB
2. `realistic-5-normal.png`     — Linear (NoColorSpace)
3. `realistic-5-roughness.png`  — Linear (NoColorSpace)

Drop into `public/textures/` after generation. The engine picks this
variant by `(spec.seed >> 3) % 5 + 1 == 5` (~5% of asteroid field
spawns — rare; the metallic-with-history character is one of the
field's signature variants).

> **Caveat (engine constraint):** The wireframe sets `metalness: 0`
> globally, so the metal side does NOT contribute specular in render.
> The variant still reads as visually different because the
> **roughness map has high variation** between smooth metal peaks
> and matte oxidation patches, plus the **subtle metal-flake
> facets** in the normal map. So even with metalness=0, the player
> sees a "polished-then-weathered" character that the other
> 4 variants don't have.

## Style anchors (binding)

1. **Genre:** Star Wars asteroid belt realism (Empire Strikes Back
   + Return of the Jedi's Hoth sequence). Vacuum-exposed metallic
   asteroid, not earth-environment stone or metal.
2. **Lighting baked into albedo:** single warm-yellow sun light ~10°
   above horizon plane, hard baked shadows inside the texture. The
   metallic-flake character benefits from hard sun-on-metal contrast.
3. **Vacuum has no specular — engine sets metalness=0 globally.**
   The variant's character comes from the texture + roughness
   variation, NOT from in-engine metalness.
4. **Color palette:** silver-gray with darker oxidation streaks.
   Allowed: slight cool-gray-blue tint in oxidation patches
   (the only variant with significant blue presence).
5. **Seamless tiling mandatory** — albedo + roughness must tile
   cleanly on power-of-two edges.
6. **Normal map encoding:** OpenGL tangent-space normals
   (R = X, G = Y, B = Z, neutral at (0.5, 0.5, 0.5)).
7. **Target shape:** contact_binary (the dual-lobe peanut) is the
   natural fit — nickel-iron asteroids in real catalogs often have
   contact-binary shapes. Also reads on craggy_rock.

## Variant 5 specs

### Albedo (`realistic-5-albedo.png`)
- **Base color:** silver-gray, ~#6a6a70.
- **Oxidation streaks:** darker patches, dark blue-gray
  (~#3a4048), irregular shapes ~20–60 per tile (atmospheric
  oxidation despite being in vacuum — weathering from impact
  shocks / solar-wind ionised-oxygen deposition over billions
  of years).
- **Metal flakes / crystals:** lighter highlights, ~#9a9aa0,
  scattered ~30–80 per tile, small sharp-edged shapes.
- **Lit faces read mid silver-gray** (~#8a8a90).
- **Shadow faces read blue-gray** (~#3a4048). The shadow side
  holds the oxidation character; the lit side reads as
  polished metal.

### Normal map (`realistic-5-normal.png`)
- **Subtle metal-crystal facets** — sharp angles, small scale.
- Less high-frequency than volcanic basalt — more like brushed
  metal with little crystalline inclusions.
- Metal-flake facets at ~30–80 spots per tile, each ~5–20px
  diameter convex bumps in the normal map.
- Oxidation patches as shallow concavities (negative displacement
  in normal).

### Roughness map (`realistic-5-roughness.png`)
- **HIGH variation** — the variant that benefits MOST from a
  varying roughness map.
- **Metal peaks:** ~0.40 (lets some specular through, reads as
  smooth polished metal).
- **Oxidation patches:** ~0.90 (matte rust).
- **Average across the tile is ~0.65-0.70** but the local variation
  is significant.
- This contrast is the **visual signature** of variant 5 — without
  it the texture reads as a duller S-type.

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
- **Too-monochrome:** if the variant-5 tile reads as a single
  solid silver-gray, the contrast that defines the variant is
  missing. Re-prompt with "polished metal peaks AND matte rust
  patches, high contrast between them".
- **Power-of-two is mandatory.** 1024×1024 (or 2048×2048).
- **No transparent pixels.** Asteroids do not use alpha.
- **No JPEG** for any of these maps.

## Saving

Save to `public/textures/v{n}/realistic-5-{albedo,normal,roughness}.png`
where `n` is the iteration number (start at 1). When you settle on
the best iteration (typically the 3rd–6th), promote to
`public/textures/realistic-5-{albedo,normal,roughness}.png`.
Then move to `ship-hull.md`.
