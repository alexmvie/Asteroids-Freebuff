#!/usr/bin/env python3
"""
Convert an FBX file (+ optional texture bitmaps) back to GLB.

Usage:
    python fbx_to_glb.py input.fbx textures_dir/ output.glb

Input:
    input.fbx         the FBX file (from glb_to_fbx.py or your
                      editor of choice: Blender, Maya, 3ds Max, ...)
    textures_dir/     directory with texture files (PNG/JPG) to
                      embed. The first texture in the directory
                      is attached to the first mesh in the scene,
                      second to the second mesh, etc.
                      Pass an empty string ("") to skip textures.
    output.glb        path for the output GLB

This is the reverse of `glb_to_fbx.py`. The typical workflow is:

    1. glb_to_fbx.py  original.glb  round_trip/
    2. Open round_trip/original.fbx in Blender
    3. Edit the mesh / materials / split meshes by color region
    4. (Optional) Edit round_trip/textures/*.png in Photoshop
    5. fbx_to_glb.py  round_trip/original.fbx  round_trip/textures/  final.glb
    6. Drop final.glb into public/models/ — the game loads it on boot

If `textures_dir` is empty, the GLB is exported with mesh geometry
only (no textures). The result is still valid — your editor can
add materials back later.

Requirements:
    pip install trimesh pygltflib Pillow numpy
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from glb_utils import attach_textures_to_scene, load_scene  # noqa: E402


def fbx_to_glb(fbx_path: str, textures_dir: str, out_glb: str) -> dict:
    """Convert an FBX (+ textures) back to GLB.

    @param fbx_path: path to the input .fbx file
    @param textures_dir: directory with texture files to embed,
        or "" / a non-existent path to skip textures
    @param out_glb: path for the output .glb file
    @returns: dict with the GLB path and embedded texture count
    """
    fbx_path = Path(fbx_path)
    out_glb = Path(out_glb)
    textures_path = Path(textures_dir) if textures_dir else None

    # 1. Load FBX.
    print(f"[fbx_to_glb] Loading {fbx_path.name}...")
    scene = load_scene(fbx_path)
    print(f"  -> {len(scene.geometry)} mesh(es) in scene")
    for name in scene.geometry:
        print(f"     - {name}")

    # 2. Attach textures (best effort).
    if textures_path and textures_path.exists():
        attached = attach_textures_to_scene(scene, textures_path)
        print(f"  -> attached {attached} texture(s)")
    else:
        print("  -> no textures dir, exporting mesh only")

    # 3. Export to GLB.
    print(f"[fbx_to_glb] Writing GLB to {out_glb}...")
    out_glb.parent.mkdir(parents=True, exist_ok=True)
    scene.export(str(out_glb), file_type="glb")

    return {
        "glb": str(out_glb),
        "size_bytes": out_glb.stat().st_size,
        "mesh_count": len(scene.geometry),
    }


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(
            f"Usage: {argv[0]} input.fbx textures_dir/ output.glb",
            file=sys.stderr,
        )
        print(f"  input.fbx     the .fbx file to convert", file=sys.stderr)
        print(f"  textures_dir/ dir with PNG/JPG files to embed", file=sys.stderr)
        print(f"                 (pass empty string '' to skip)", file=sys.stderr)
        print(f"  output.glb    path for the output GLB", file=sys.stderr)
        return 1

    result = fbx_to_glb(argv[1], argv[2], argv[3])
    print(json.dumps(result, indent=2))
    print(f"[done] Wrote {result['glb']} ({result['mesh_count']} meshes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
