#!/usr/bin/env python3
"""
Convert a GLB file to FBX + separate texture bitmaps.

Usage:
    python glb_to_fbx.py input.glb output_dir/

Output:
    output_dir/<input-stem>.fbx       the mesh as FBX
    output_dir/textures/texture_NN.*  extracted texture files (PNG/JPG)

Why?
    Some 3D editors (Blender, Maya, 3ds Max) work better with FBX
    than with the glTF family. The round-trip also lets you edit
    the texture bitmaps in Photoshop and re-embed them (see
    `fbx_to_glb.py`).

The mesh geometry is exported as-is. Materials and textures are
preserved best-effort: the FBX may or may not contain the texture
bindings, depending on what your FBX importer supports. The
extracted PNG files in `output_dir/textures/` are the source of
truth for the textures — re-embed them via `fbx_to_glb.py`.

Requirements:
    pip install trimesh pygltflib Pillow numpy
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow running as `python scripts/glb_convert/glb_to_fbx.py ...`
# from the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from glb_utils import extract_textures, load_scene  # noqa: E402


def glb_to_fbx(glb_path: str, out_dir: str) -> dict:
    """Convert a GLB to FBX + extracted textures.

    @param glb_path: path to the input .glb file
    @param out_dir: directory to write the FBX + textures/
    @returns: dict with paths to the FBX and texture files
    """
    glb_path = Path(glb_path)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    textures_dir = out_dir / "textures"
    textures_dir.mkdir(exist_ok=True)

    # 1. Extract textures (the part that needs glTF-level parsing).
    print(f"[glb_to_fbx] Extracting textures from {glb_path.name}...")
    texture_paths = extract_textures(glb_path, textures_dir)
    for p in texture_paths:
        print(f"  -> {p.name} ({p.stat().st_size} bytes)")

    # 2. Load mesh and export. trimesh's FBX support is limited
    # (it raises `unsupported export format: fbx` on many
    # versions), so we try FBX first and fall back to OBJ+MTL if
    # unavailable. OBJ+MTL is a fine intermediate format — every
    # FBX-capable editor (Blender, Maya, 3ds Max) opens it, and
    # the .mtl file references the extracted texture PNGs.
    print(f"[glb_to_fbx] Loading mesh from {glb_path.name}...")
    scene = load_scene(glb_path)
    print(f"  -> {len(scene.geometry)} mesh(es) in scene")

    fbx_path = out_dir / f"{glb_path.stem}.fbx"
    obj_path = out_dir / f"{glb_path.stem}.obj"
    final_path = None
    final_format = None
    try:
        print(f"[glb_to_fbx] Writing FBX to {fbx_path}...")
        scene.export(str(fbx_path), file_type="fbx")
        final_path = fbx_path
        final_format = "fbx"
    except (ValueError, NotImplementedError) as e:
        print(
            f"  warn: FBX export unavailable ({e}); falling back to OBJ+MTL",
            file=sys.stderr,
        )
        print(f"[glb_to_fbx] Writing OBJ to {obj_path} (+ MTL)...")
        scene.export(str(obj_path), file_type="obj")
        final_path = obj_path
        final_format = "obj+mtl"

    return {
        "output": str(final_path),
        "format": final_format,
        "textures": [str(p) for p in texture_paths],
        "size_bytes": final_path.stat().st_size,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(
            f"Usage: {argv[0]} input.glb output_dir/",
            file=sys.stderr,
        )
        print(f"  input.glb    the .glb file to convert", file=sys.stderr)
        print(f"  output_dir/  directory for the FBX + textures/", file=sys.stderr)
        return 1

    result = glb_to_fbx(argv[1], argv[2])
    print(json.dumps(result, indent=2))
    fmt = result.get("format", "fbx")
    print(
        f"[done] Wrote {result['output']} ({fmt}) + "
        f"{len(result['textures'])} texture(s)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
