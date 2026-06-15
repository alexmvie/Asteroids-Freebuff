# GLB ↔ FBX round-trip

Two CLI scripts for converting 3D models between the GLB (glTF 2.0 binary) and FBX formats, with the embedded texture bitmaps extracted as separate files. Use this when you need to edit a GLB in an FBX-native editor (Blender, Maya, 3ds Max) or just want to swap a texture for a re-skinned one.

## Install

```bash
cd scripts/glb_convert
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Tested with Python 3.11 + trimesh 4.x + pygltflib 1.16.

## Usage

### GLB → FBX (+ extract textures)

```bash
python glb_to_fbx.py public/models/skyfighter.glb /tmp/round_trip/
```

Output:
```
/tmp/round_trip/
├── skyfighter.fbx
└── textures/
    ├── texture_00.png     ← baseColor (red paint + black glass in this case)
    └── texture_01.png     ← metallic/roughness map (if present)
```

### FBX → GLB (+ re-embed textures)

```bash
python fbx_to_glb.py /tmp/round_trip/skyfighter.fbx /tmp/round_trip/textures/ /tmp/round_trip/skyfighter_final.glb
```

The first PNG in `textures/` is attached to the first mesh in the scene, the second to the second mesh, etc. If your FBX has more meshes than textures, the extras get the default material. If your textures dir is empty, the GLB is exported with mesh geometry only.

## Typical workflow (the "split by material" use case)

This is the workflow for getting red-paint-matte + black-glass-glossy out of a single-material GLB:

1. **Extract:** `python glb_to_fbx.py skyfighter.glb round_trip/`
2. **Edit the texture in Photoshop** (or your image editor):
   - Open `round_trip/textures/texture_01.png` (the metallic-roughness map)
   - Paint the red-paint regions **white** (matte, high roughness ~0.9)
   - Paint the black-glass regions **black** (glossy, low roughness ~0.1, with some metallic)
   - Save the PNG (preserve the filename)
3. **Re-embed:** `python fbx_to_glb.py round_trip/skyfighter.fbx round_trip/textures/ skyfighter_v2.glb`
4. **Drop the result into the game:**
   - `cp skyfighter_v2.glb public/models/`
   - Reload the dev server (the model is loaded once at boot via `loadShipModel`)

If you need to actually split the mesh (so the body and the canopy are separate meshes with separate materials), use Blender between step 1 and step 3:

1. **Extract:** `python glb_to_fbx.py skyfighter.glb round_trip/`
2. **Open `round_trip/skyfighter.fbx` in Blender.**
3. **Split by color region:** in Edit Mode, select faces whose vertex color is "black", `P` (Separate) → By Material or By Loose Parts. Rename the new meshes (e.g. `body` and `canopy`).
4. **Assign materials:** create a "Paint" material (high roughness, low metalness, red) and a "Glass" material (low roughness, some metalness, black). Assign one to each mesh.
5. **Export:** `File → Export → glTF 2.0` (binary `.glb`). Save to `round_trip/skyfighter_v2.glb`.
6. **The reverse script is optional** — if you exported from Blender directly, just drop the result into `public/models/`.

## Why these scripts exist

- The game loads ship models via `loadShipModel(ship, url)` in `src/entities/ship.js`, which expects `.glb`.
- Some 3D editors are FBX-only or work better with FBX (Blender, Maya, 3ds Max all support FBX; some of them silently degrade on glTF imports).
- trimesh's built-in FBX support loses material/texture bindings on round-trip. These scripts use `pygltflib` (which parses the glTF JSON directly) to preserve the texture bitmaps across the conversion, so you can edit them in Photoshop and re-embed.

## Limitations

- **Materials may not survive the round-trip.** trimesh's GLB/FBX material support is best-effort. If you need a perfect material round-trip, use Blender as the intermediate editor (it's the only tool that handles every PBR property consistently).
- **The texture attachment in `fbx_to_glb.py` is "first texture → first mesh, second texture → second mesh, etc."** This is the simplest heuristic. If your FBX has meshes that need specific textures, do the re-attachment in Blender and export directly to GLB from there.
- **Animations, skins, morph targets, and Draco-compressed meshes are not supported.** trimesh and pygltflib both ignore them. If you need them, use Blender as the intermediate editor.
- **The `texture_NN.png` filenames must be preserved** between extraction and re-embedding. If you rename or add files, the round-trip might not pick them up correctly.

## API

If you want to use these scripts as a library:

```python
import sys
sys.path.insert(0, "scripts/glb_convert")
from glb_utils import extract_textures, load_scene, attach_textures_to_scene

# Extract
paths = extract_textures(Path("skyfighter.glb"), Path("/tmp/textures/"))

# Load
scene = load_scene(Path("skyfighter.fbx"))

# Attach + export
attach_textures_to_scene(scene, Path("/tmp/textures/"))
scene.export("skyfighter_v2.glb", file_type="glb")
```

See `glb_utils.py` for the full signatures.
