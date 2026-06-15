"""
Shared helpers for the GLB↔FBX round-trip scripts.

Three responsibilities:
  1. Extract embedded / external textures from a GLB to PNG/JPG
     files in a directory.
  2. Embed PNG/JPG files from a directory back into a GLB
     (replacing or adding textures).
  3. Thin wrappers around `trimesh.load` / `trimesh.Scene.export`
     that pick sensible defaults (force="scene", file_type="glb"
     or "fbx") and surface common errors clearly.

Used by `glb_to_fbx.py` (extract step) and `fbx_to_glb.py`
(embed step). The wrappers are intentionally small — anything
specific to a format belongs in the CLI script that uses it.

Why not just call trimesh directly? trimesh's GLB/FBX material
support is best-effort: the round-trip often loses texture
bindings. This module exposes two functions (`extract_textures`,
`embed_textures`) that work at the glTF JSON level via
`pygltflib`, so the user can edit the PNGs in Photoshop and
re-embed them with a guarantee that the binding survives.

Requirements:
    pip install trimesh pygltflib Pillow numpy
"""

from __future__ import annotations

import base64
import sys
from pathlib import Path
from typing import List

import numpy as np
import pygltflib
import trimesh
from PIL import Image


def extract_textures(glb_path: Path, textures_dir: Path) -> List[Path]:
    """Extract every texture referenced by the GLB into PNG/JPG files.

    Handles all three glTF image storage modes:
      - external file (URI not a data: URI) — copied as-is
      - data URI (base64-encoded in the JSON) — decoded + written
      - buffer view (textures stored in the GLB binary chunk) —
        the most common mode for single-file GLBs

    The output filenames are zero-padded (`texture_00.png`,
    `texture_01.png`, ...) so they sort deterministically when
    re-embedded.

    @param glb_path: the .glb file to read
    @param textures_dir: directory to write the textures to
        (created if it doesn't exist)
    @returns: list of paths in the order they appear in the
        GLB's `images` array
    """
    gltf = pygltflib.GLTF2().load(str(glb_path))
    textures_dir.mkdir(parents=True, exist_ok=True)
    out_paths: List[Path] = []

    for i, image in enumerate(gltf.images or []):
        # Case 1: external file referenced by relative URI.
        if image.uri and not image.uri.startswith("data:"):
            src = glb_path.parent / image.uri
            if not src.exists():
                print(
                    f"  warn: external texture not found: {src}",
                    file=sys.stderr,
                )
                continue
            ext = src.suffix or ".png"
            dst = textures_dir / f"texture_{i:02d}{ext}"
            dst.write_bytes(src.read_bytes())
            out_paths.append(dst)
            continue

        # Case 2: data URI (base64-encoded in the JSON).
        if image.uri and image.uri.startswith("data:"):
            header, b64 = image.uri.split(",", 1)
            mime = "image/png"
            if ":" in header:
                mime = header.split(":", 1)[1].split(";", 1)[0]
            ext = ".png" if "png" in mime else (".jpg" if "jpeg" in mime else ".bin")
            data = base64.b64decode(b64)
            dst = textures_dir / f"texture_{i:02d}{ext}"
            dst.write_bytes(data)
            out_paths.append(dst)
            continue

        # Case 3: buffer view (textures inside the GLB binary).
        # pygltflib exposes the GLB's binary chunk via `binary_blob()`
        # and external .bin files via `get_data_from_buffer_uri(uri)`.
        # We pick the right one based on whether the buffer has a URI.
        if image.bufferView is not None:
            bv = gltf.bufferViews[image.bufferView]
            try:
                buffer = gltf.buffers[bv.buffer] if gltf.buffers else None
                if buffer is None or buffer.uri is None:
                    # No URI → textures live in the GLB's binary chunk.
                    data = gltf.binary_blob()
                else:
                    # External .bin file referenced by URI.
                    data = gltf.get_data_from_buffer_uri(buffer.uri)
                offset = bv.byteOffset or 0
                blob = data[offset : offset + bv.byteLength]
            except Exception as e:
                print(
                    f"  warn: failed to read image {i} from buffer "
                    f"view: {e}",
                    file=sys.stderr,
                )
                continue
            ext = ".png"
            if image.mimeType == "image/jpeg":
                ext = ".jpg"
            dst = textures_dir / f"texture_{i:02d}{ext}"
            dst.write_bytes(blob)
            out_paths.append(dst)
            continue

        print(
            f"  warn: image {i} has neither uri nor bufferView, skipping",
            file=sys.stderr,
        )

    return out_paths


def load_scene(path: Path) -> trimesh.Scene:
    """Load any 3D file format trimesh supports, returning a Scene.

    Wraps trimesh.load with `force="scene"` and a clear error
    message if the file can't be read. Single-mesh FBX/OBJ files
    are wrapped in a one-geometry Scene so the downstream code
    has a uniform shape.

    @param path: file to load (.glb, .fbx, .obj, .stl, .ply, ...)
    @returns: trimesh.Scene with one or more geometries
    """
    try:
        loaded = trimesh.load(str(path), force="scene")
        if isinstance(loaded, trimesh.Scene):
            return loaded
        # Single-mesh result (rare for `force="scene"`, but be safe).
        scene = trimesh.Scene()
        scene.add_geometry(loaded)
        return scene
    except Exception as e:
        raise RuntimeError(
            f"glb_utils.load_scene: failed to load {path}: {e}"
        ) from e


def attach_textures_to_scene(
    scene: trimesh.Scene,
    textures_dir: Path,
) -> int:
    """Best-effort: attach PNG/JPG files in `textures_dir` to the
    geometries in `scene`, one texture per geometry (round-robin).

    trimesh's visual-material API is limited. We try the common
    hooks (`baseColorTexture`, `image`) and warn if none work.
    If the attachment fails, the exported GLB will be missing
    textures — the user will see the untextured model.

    @param scene: the trimesh.Scene to attach textures to
    @param textures_dir: directory with texture_*.png/jpg files
    @returns: number of textures successfully attached
    """
    if not textures_dir or not textures_dir.exists():
        return 0
    tex_files = sorted(
        list(textures_dir.glob("*.png"))
        + list(textures_dir.glob("*.jpg"))
        + list(textures_dir.glob("*.jpeg"))
    )
    if not tex_files:
        return 0

    attached = 0
    tex_iter = iter(tex_files)
    for geo_name, geo in scene.geometry.items():
        try:
            tex_path = next(tex_iter)
        except StopIteration:
            break
        try:
            img = Image.open(tex_path)
            if hasattr(geo.visual, "material") and geo.visual.material is not None:
                mat = geo.visual.material
                # trimesh's PBRMaterial exposes `baseColorTexture`
                # on some versions and `image` on others. Try both.
                if hasattr(mat, "baseColorTexture"):
                    mat.baseColorTexture = img
                    attached += 1
                elif hasattr(mat, "image"):
                    mat.image = img
                    attached += 1
                else:
                    print(
                        f"  warn: {geo_name}'s material has no "
                        f"baseColorTexture / image hook",
                        file=sys.stderr,
                    )
        except Exception as e:
            print(
                f"  warn: failed to attach {tex_path.name} to "
                f"{geo_name}: {e}",
                file=sys.stderr,
            )
    return attached
