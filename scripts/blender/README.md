# Blender Asteroid Pipeline (`scripts/blender/`)

Branch: `blender-asteroid-pipeline`. Goal: model asteroids in Blender, bake
real PBR maps (albedo / normal / roughness / AO) with Cycles, export GLB, and
use the results in the game — replacing or augmenting the current fully
procedural `src/entities/asteroid.js` path.

## Status

| Step | State |
|---|---|
| Blender 5.2.0 LTS install (Homebrew cask) | ✅ `brew install --cask blender` (headless verified: `blender --background --python-expr "import bpy"`) |
| POC: model → displace → UV → bake → GLB | ✅ `generate_asteroid.py` (run it, see below) |
| Game wiring (GLB as showcase entry / field variant) | ✅ v0.73.2: `public/models/asteroid-42.glb` committed; showcase entry index 5 ("Asteroid · Blender Baked (Cycles)"), lazy GLTFLoader + shadow tags + turntable. Browser-verified. |
| Quality loop (render → compare vs NASA/AAA → refine) | ⏳ next (reuse `scripts/showcase-capture.mjs` + the A/B measurement pattern from SSAO) |

## Blender-MCP — honest feasibility assessment (2026-08-08)

**Can I drive Blender via `blender-mcp` (ahujasid/blender-mcp)?**

- blender-mcp needs **three pieces**: (1) Blender running **with GUI** + the
  addon's socket server (port 9876) started via the "Connect to Claude" button,
  (2) the `uvx blender-mcp` server process, (3) an **MCP client** that registers
  the server (Claude Desktop / Cursor / VS Code / OpenCode).
- This environment has **no MCP client tool** — I cannot register a server, so
  the "LLM interactively clicks in Blender through MCP" flow is not available
  from here.
- **What IS available and strictly better for assets:** Blender headless
  (`blender --background --python script.py`). Deterministic, CI-style,
  reproducible, testable — the standard production path for procedural asset
  generation + Cycles baking. The modeling/baking result is identical to what
  MCP would produce, minus the GUI.
- **Hybrid option:** if you run Blender + the MCP addon on your machine with
  Claude Desktop (or another MCP client), you can drive it interactively
  yourself. The scripts in this folder are the artifact-oriented path; they
  don't depend on any MCP setup.
- **`bpy` via pip is NOT an option on macOS** (official wheels are Windows/Linux
  only). Install = Homebrew cask (done) or official dmg.

## Pipeline (what `generate_asteroid.py` proves)

1. **Model** — icosphere at the game's radius; radial displacement by a
   deterministic hash-noise (same math family as `src/entities/asteroid.js`,
   so per-`seed` asteroids stay reproducible). `--detail 6` = 20480 faces
   (~10K verts) = the three.js `IcosahedronGeometry` detail-5 equivalent
   (Blender counts `20·4^(n-1)` faces for `subdivisions=n`; three.js counts
   `20·4^d`).
2. **Features** — deterministic crater bowls (negative carve + rim) + boulder
   mounds (positive), placed from the seed — the Bennu/Ryugu surface
   hierarchy the game already uses. Both are CLAMPED to the game's limits
   (±0.5r crater / +0.45r boulder) so stacked features can't explode the
   silhouette.
3. **UV** — deterministic SPHERICAL projection (game's icosphere convention
   `U = atan2(z,x)/2π + 0.5`, V normalized over the ACTUAL displaced vertex
   y-bounds). Replaces smart-project (packed islands into ~17% of the
   texture → baked maps read near-black). The icosphere operator's default
   UVMap is removed first so ours is the ONLY layer (else bake+export use
   the operator's half-empty TEXCOORD_0).
4. **Bake** (Cycles, CPU, low samples for iteration speed) —
   `DIFFUSE` (albedo), `NORMAL` (tangent), `ROUGHNESS`, `AO` at 1024².
5. **Export** — GLB via `bpy.ops.export_scene.gltf` with embedded PNG maps.
   The game's `GLTFLoader` (already used by `ship.js` / `powerup.js`) can load it.

## v0.73.3 — correctness fixes (user: "geometrie ist falsch und texturen fehlen total")

- **Geometry explosion** (maxR=72.56 on a radius-8 body): `hash3` used
  `s - int(s)` (truncation toward zero) instead of the game's
  `Math.sin(...) * 43758.5453` + `s - Math.floor(s)`; at negative lattice
  coords `int()` truncates toward 0 → negative hashes → fbm escapes [0,1]
  (measured n=-16.97) → the unclamped base silhouette exploded. `noise3`'s
  lattice had the same `int()`-vs-`floor` bug. Both now mirror
  `src/geometry/noisy-icosphere.js` exactly (sin + floor): maxR 12.63,
  minR 4.87.
- **Geometry self-check** (fail-fast): after displacement, min/max vertex
  radius must be in `[0.1·radius, 2.5·radius]`; otherwise the bake aborts
  with a clear message instead of shipping a broken GLB. Bounds are looser
  than the theoretical clamp envelope (0.2r–2.15r) so valid crater-floor
  vertices don't false-fail, but far tighter than the ±53u regression.
- **Unlit albedo bake** (code-review fix, verified on Blender 5.2.0): a bare
  `bpy.ops.object.bake(type='DIFFUSE')` bakes direct+indirect diffuse (sun +
  shadow baked INTO the albedo — wrong under the game's dynamic sun). The
  script passes `pass_filter={'COLOR'}` — the standard operator enum-set
  kwarg on 3.x/4.x/5.x. (`use_pass_*` props are neither operator kwargs nor
  `scene.render.bake` props on 5.x — introspected via
  `bpy.ops.object.bake.get_rna_type().properties`; they raise `TypeError`.)
- **Textures missing**: the baked maps were saved to disk but the procedural
  Noise/Mix nodes are not glTF-exportable → the GLB shipped `hasTextures:
  false`. The 4 baked images are now wired into Base Color / Roughness /
  Normal (via a Normal Map node) / Occlusion, and the procedural nodes are
  removed before export. **The glTF exporter drops the Occlusion link, so the
  GLB embeds 3 maps (albedo/normal/roughness); the AO stays disk-only** —
  fine for the game (SSAO pass + `aoMap` would need a separate `uv2`
  anyway), the PNG remains for future texture work.
- **Brighter albedo**: the old material fed `noise.Fac` (avg ~0.5) into Base
  Color on a dark 0.45 base → baked albedo near-black (0.10). A Mix node now
  blends light tan with dark brown (target range [0.38..0.62]);  measured baked albedo mean 162 (unlit), roughness 232 (~0.91), AO 215,
  normal exact canon (R=G=128, B=255).

## Run

```bash
# from repo root (Blender is on PATH via brew)
blender --background --python scripts/blender/generate_asteroid.py -- \
  --seed 42 --radius 8 --detail 6 --out artifacts/blender

ls artifacts/blender
# -> asteroid-42.glb, asteroid-42-albedo.png, asteroid-42-normal.png,
#    asteroid-42-roughness.png, asteroid-42-ao.png
```

## Next steps

1. **Done (v0.73.2)** — `asteroid-42.glb` is wired into the showcase (lazy
   GLTFLoader in `src/systems/showcase.js`, shadow-tagged, turntable, index 5).
   To swap in a re-bake: overwrite `public/models/asteroid-42.glb` (keep the
   name — the regression test checks the magic bytes) and reload.
2. **Quality loop** — bake a batch (all 5 shape archetypes × several seeds),
   capture via `showcase-capture.mjs`, compare against NASA imagery + the
   current procedural field (use `measure-ssao-ab.py` style pixel metrics),
   iterate on displacement, crater scale, and bake samples/margin.
3. **Y-flip check** — Blender bakes tangent normals in its own convention; the
   glTF exporter usually flips on export, but verify against the current
   `normalScale` handling in `createAsteroidMaterial` when wired in. v0.73.3
   measured the embedded normal map at the exact tangent-space canon
   (R=G=128, B=255) and flipping `normalScale.y` changed nothing visually in
   the browser — no flip needed so far.
4. **Batch bake** — the next quality-loop step: bake all 5 archetypes ×
   several seeds with this (now correct) pipeline, then run the NASA/AAA
   comparison.
