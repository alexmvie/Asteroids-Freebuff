#!/usr/bin/env python
"""
v0.73.1 -- Blender headless asteroid generation (POC).

Proves the full Blender pipeline end-to-end:
  model (icosphere + deterministic hash-noise displacement + craters +
  boulders) -> smart UV -> Cycles bake (albedo/normal/roughness/AO) ->
  GLB export with embedded PNG maps.

The displacement math mirrors src/entities/asteroid.js (position-based
hash noise, deterministic per seed) so baked assets stay reproducible
and visually consistent with the game's procedural field.

Run (from repo root, Blender on PATH via brew):
  blender --background --python scripts/blender/generate_asteroid.py -- \
    --seed 42 --radius 8 --detail 4 --out artifacts/blender

Output:
  artifacts/blender/asteroid-<seed>.glb
  artifacts/blender/asteroid-<seed>-{albedo,normal,roughness,ao}.png
"""

import argparse
import os
import random
import sys

import bpy

# ---------------------------------------------------------------------------
# Deterministic value-noise displacement (same family as the game)
# ---------------------------------------------------------------------------

def hash3(x, y, z):
    s = (x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
    return s - int(s)

def smoothstep(t):
    return t * t * (3.0 - 2.0 * t)

def noise3(x, y, z):
    ix, iy, iz = int(x), int(y), int(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    ux, uy, uz = smoothstep(fx), smoothstep(fy), smoothstep(fz)
    c000 = hash3(ix, iy, iz);     c100 = hash3(ix + 1, iy, iz)
    c010 = hash3(ix, iy + 1, iz); c110 = hash3(ix + 1, iy + 1, iz)
    c001 = hash3(ix, iy, iz + 1); c101 = hash3(ix + 1, iy, iz + 1)
    c011 = hash3(ix, iy + 1, iz + 1); c111 = hash3(ix + 1, iy + 1, iz + 1)
    x00 = c000 + (c100 - c000) * ux
    x10 = c010 + (c110 - c010) * ux
    x01 = c001 + (c101 - c001) * ux
    x11 = c011 + (c111 - c011) * ux
    y0 = x00 + (x10 - x00) * uy
    y1 = x01 + (x11 - x01) * uy
    return y0 + (y1 - y0) * uz

def fbm3(x, y, z, octaves=4):
    value, amp, freq, maxv = 0.0, 1.0, 1.0, 0.0
    for _ in range(octaves):
        value += amp * noise3(x * freq, y * freq, z * freq)
        maxv += amp
        amp *= 0.5
        freq *= 2.0
    return value / maxv

# ---------------------------------------------------------------------------
# Mesh construction
# ---------------------------------------------------------------------------

def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def add_icosphere(radius, detail):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=detail, radius=radius)
    obj = bpy.context.object
    obj.name = "Asteroid"
    return obj

def displace_radially(obj, radius, seed):
    """Displace every vertex along its radial direction by fbm noise +
    deterministic craters (bowl+rim) + boulders (positive mounds)."""
    import bmesh
    rng = random.Random(seed)

    # Crater field: deterministic unit-vector centers (Bennu-style bowls)
    craters = []
    for _ in range(4):
        z = 1 - 2 * rng.random()
        phi = rng.random() * 6.2831853
        r = (1 - z * z) ** 0.5
        craters.append({
            "x": r * __import__("math").cos(phi), "y": r * __import__("math").sin(phi), "z": z,
            "ar": 0.15 + rng.random() * 0.35, "depth": 0.7 + rng.random() * 0.9,
        })

    boulders = []
    for _ in range(6):
        z = 1 - 2 * rng.random()
        phi = rng.random() * 6.2831853
        r = (1 - z * z) ** 0.5
        boulders.append({
            "x": r * __import__("math").cos(phi), "y": r * __import__("math").sin(phi), "z": z,
            "ar": 0.08 + rng.random() * 0.2, "h": 0.6 + rng.random() * 1.0,
        })

    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    layer = bm.verts.layers.deform  # unused; keeps import honest
    del layer

    cr_scale, bd_scale = 0.36, 0.22
    for v in bm.verts:
        x, y, z = v.co.x, v.co.y, v.co.z
        vl = (x * x + y * y + z * z) ** 0.5 or 1e-6
        rx, ry, rz = x / vl, y / vl, z / vl

        n = fbm3(x * 2.0 / radius, y * 2.0 / radius, z * 2.0 / radius, 4)
        disp = (n - 0.5) * 2.0 * radius * 0.30  # base silhouette

        # craters
        for c in craters:
            ca = max(-1.0, min(1.0, rx * c["x"] + ry * c["y"] + rz * c["z"]))
            t = __import__("math").acos(ca) / c["ar"]
            if t < 1.6:
                bowl = -c["depth"] * (1 - t) ** 2 if t < 1 else 0.0
                rim = c["depth"] * 0.5 * __import__("math").exp(-(((t - 1) / 0.25) ** 2)) if t >= 1 else 0.0
                disp += (bowl + rim) * cr_scale * vl

        # boulders
        for b in boulders:
            ca = max(-1.0, min(1.0, rx * b["x"] + ry * b["y"] + rz * b["z"]))
            t = __import__("math").acos(ca) / b["ar"]
            if t < 1.0:
                disp += b["h"] * (1 - t * t) ** 2.0 * bd_scale * vl

        v.co.x = x + rx * disp
        v.co.y = y + ry * disp
        v.co.z = z + rz * disp

    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.update()

def smart_unwrap(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")

# ---------------------------------------------------------------------------
# Materials + baking
# ---------------------------------------------------------------------------

def make_material(obj, seed):
    mat = bpy.data.materials.new("AsteroidMat")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    noise = nt.nodes.new("ShaderNodeTexNoise")

    def set_inp(node, names, value):
        for inp in node.inputs:
            if inp.name in names:
                inp.default_value = value
                return True
        return False

    set_inp(noise, ("Scale",), 8.0)
    set_inp(noise, ("Detail",), 6.0)
    set_inp(noise, ("Roughness",), 0.7)
    # per-seed offset so different seeds give different noise fields
    set_inp(noise, ("W", "Seed"), float(seed))
    # dark warm regolith base, modulated by noise
    bsdf.inputs["Base Color"].default_value = (0.45, 0.40, 0.36, 1.0)
    nt.links.new(noise.outputs["Fac"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    nt.links.new(out.inputs["Surface"], bsdf.outputs["BSDF"])
    obj.data.materials.append(mat)
    return mat

def bake_maps(obj, mat, out_dir, stem, size=1024, samples=24):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    # bake margin location changed across Blender versions
    try:
        scene.cycles.bake_margin = 4
    except AttributeError:
        scene.render.bake.margin = 4
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    specs = [
        ("albedo", "DIFFUSE", "sRGB"),
        ("normal", "NORMAL", "Non-Color"),
        ("roughness", "ROUGHNESS", "Non-Color"),
        ("ao", "AO", "Non-Color"),
    ]
    for name, bake_type, colorspace in specs:
        img = bpy.data.images.new(f"bake_{name}", size, size)
        img.colorspace_settings.name = colorspace
        tex = nt_node_for(mat, img)
        nt_set_active(mat, tex)
        # Blender 5.x: the bake type is an OPERATOR argument only (the
        # old `render.bake_type` property was removed). The operator call
        # below is authoritative across versions.
        if bake_type == "DIFFUSE":
            bake = scene.render.bake
            for prop, val in (("use_pass_direct", False), ("use_pass_indirect", False), ("use_pass_color", True)):
                if hasattr(bake, prop):
                    setattr(bake, prop, val)
        bpy.ops.object.bake(type=bake_type)
        path = os.path.join(out_dir, f"{stem}-{name}.png")
        img.save_render(filepath=path)
        img.filepath_raw = path  # glTF exporter embeds via filepath
        print(f"  baked {name} -> {path}")

def nt_node_for(mat, img):
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    return tex

def nt_set_active(mat, tex):
    mat.node_tree.nodes.active = tex
    tex.select = True

def export_glb(obj, out_dir, stem):
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(out_dir, f"{stem}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",  # PNG is no longer an enum value in 5.x
    )
    print(f"  exported {path}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def script_args():
    """Return the args intended for THIS script.

    Blender normally strips its own flags from sys.argv before running
    `--python script.py`, but some launchers (e.g. the Homebrew command
    wrapper) pass the full command line through, so sys.argv can contain
    `--background --python scripts/...` ahead of our real args. Find the
    script path and take everything after it; fall back to argv[1:].
    """
    argv = sys.argv
    needle = os.path.basename(__file__)
    # match the argv element by basename (Blender may pass the full path)
    for i, a in enumerate(argv):
        if a.endswith(needle):
            return argv[i + 1:]
    return argv[1:]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--radius", type=float, default=8.0)
    ap.add_argument("--detail", type=int, default=4)
    ap.add_argument("--out", default="artifacts/blender")
    args = ap.parse_args(script_args())

    os.makedirs(args.out, exist_ok=True)
    stem = f"asteroid-{args.seed}"

    clean_scene()
    obj = add_icosphere(args.radius, args.detail)
    displace_radially(obj, args.radius, args.seed)
    smart_unwrap(obj)
    mat = make_material(obj, args.seed)
    bake_maps(obj, mat, args.out, stem)
    export_glb(obj, args.out, stem)

    print(f"POC OK: {stem}.glb + 4 maps in {os.path.abspath(args.out)}")

if __name__ == "__main__":
    main()
