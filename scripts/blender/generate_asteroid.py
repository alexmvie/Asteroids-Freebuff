#!/usr/bin/env python
"""
v0.73.3 -- Blender headless asteroid generation.

Proves the full Blender pipeline end-to-end:
  model (icosphere + deterministic hash-noise displacement + craters +
  boulders) -> smart UV -> Cycles bake (albedo/normal/roughness/AO) ->
  GLB export with EMBEDDED PNG maps.

The displacement math mirrors src/entities/asteroid.js (position-based
hash noise, deterministic per seed) so baked assets stay reproducible
and visually consistent with the game's procedural field.

v0.73.3 fixes (user: "der blender baked asteroid sieht kaputt aus,
geometrie ist falsch und texturen fehlen total"):
  - BUG: the baked maps were saved to disk but NEVER wired into the
    material's node tree, so the glTF exporter (which cannot export the
    procedural Noise node) emitted a textureless material. The 4 baked
    images are now wired into Base Color / Roughness / Normal (via a
    Normal Map node) / Occlusion, and the procedural nodes are removed
    before export, so the GLB embeds all 4 maps.
  - Brighter albedo: the old material fed `noise.Fac` (0..1, avg ~0.5)
    straight into Base Color on a dark 0.45 base -> baked albedo read
    near-black. Now a Mix node blends a light tan base with a dark
    brown patch (range [0.38..0.62]) so the baked surface stays
    readable under the game's sun.
  - Richer surface: 6 craters + 8 boulders (was 4 + 6), matching the
    game's craggy shape.
  - Icosphere subdivisions raised to 6 (20480 faces / ~10K verts, the
    three.js IcosahedronGeometry-detail-5 equivalent: Blender counts
    20*4^(n-1) faces for subdivisions=n, three.js counts 20*4^d).

Run (from repo root, Blender on PATH via brew):
  blender --background --python scripts/blender/generate_asteroid.py \
    --seed 42 --radius 8 --detail 6 --out artifacts/blender

Output:
  artifacts/blender/asteroid-<seed>.glb
  artifacts/blender/asteroid-<seed>-{albedo,normal,roughness,ao}.png
"""

import argparse
import math
import os
import random
import sys

import bpy

# ---------------------------------------------------------------------------
# Deterministic value-noise displacement (same family as the game)
# ---------------------------------------------------------------------------

def hash3(x, y, z):
    # MUST mirror src/geometry/noisy-icosphere.js: Math.sin(...) * 43758.5453
    # then `- Math.floor(...)`. The old `s - int(s)` truncated toward zero,
    # so negative lattice coords produced NEGATIVE hash values, fbm escaped
    # [0, 1] (measured n=-16.97), and the unclamped base term exploded the
    # mesh to maxR=72.56 (user: "geometrie ist falsch").
    s = math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
    return s - math.floor(s)

def smoothstep(t):
    return t * t * (3.0 - 2.0 * t)

def noise3(x, y, z):
    # int() truncates toward zero, so negative coords gave NEGATIVE
    # fractional parts (fx < 0) and smoothstep() > 1 -> interpolated
    # noise escaped [0, 1] (same root cause as hash3). Mirror the
    # game's Math.floor semantics exactly.
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
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

    # Crater field (Bennu-style bowls): 6 deterministic placements.
    craters = []
    for _ in range(6):
        z = 1 - 2 * rng.random()
        phi = rng.random() * 6.2831853
        r = (1 - z * z) ** 0.5
        craters.append({
            "x": r * math.cos(phi), "y": r * math.sin(phi), "z": z,
            "ar": 0.15 + rng.random() * 0.35, "depth": 0.7 + rng.random() * 0.9,
        })

    # Boulder field: 8 positive mounds.
    boulders = []
    for _ in range(8):
        z = 1 - 2 * rng.random()
        phi = rng.random() * 6.2831853
        r = (1 - z * z) ** 0.5
        boulders.append({
            "x": r * math.cos(phi), "y": r * math.sin(phi), "z": z,
            "ar": 0.08 + rng.random() * 0.2, "h": 0.6 + rng.random() * 1.0,
        })

    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)

    cr_scale, bd_scale = 0.36, 0.22
    for v in bm.verts:
        x, y, z = v.co.x, v.co.y, v.co.z
        vl = (x * x + y * y + z * z) ** 0.5 or 1e-6
        rx, ry, rz = x / vl, y / vl, z / vl

        n = fbm3(x * 2.0 / radius, y * 2.0 / radius, z * 2.0 / radius, 4)
        disp = (n - 0.5) * 2.0 * radius * 0.30  # base silhouette

        # crater + boulder contributions accumulate per vertex; mirror
        # the GAME's clamps (asteroid.js) so overlapping features cannot
        # stack into absurd spikes (measured +53u from an unclamped 6+8
        # feature field on a radius-8 body).
        crater_sum = 0.0
        for c in craters:
            ca = max(-1.0, min(1.0, rx * c["x"] + ry * c["y"] + rz * c["z"]))
            t = math.acos(ca) / c["ar"]
            if t < 1.6:
                bowl = -c["depth"] * (1 - t) ** 2 if t < 1 else 0.0
                rim = c["depth"] * 0.5 * math.exp(-(((t - 1) / 0.25) ** 2)) if t >= 1 else 0.0
                crater_sum += bowl + rim
        disp += max(-vl * 0.5, min(vl * 0.4, crater_sum * cr_scale * vl))

        boulder_sum = 0.0
        for b in boulders:
            ca = max(-1.0, min(1.0, rx * b["x"] + ry * b["y"] + rz * b["z"]))
            t = math.acos(ca) / b["ar"]
            if t < 1.0:
                boulder_sum += b["h"] * (1 - t * t) ** 2.0
        disp += min(boulder_sum * bd_scale * vl, vl * 0.45)

        v.co.x = x + rx * disp
        v.co.y = y + ry * disp
        v.co.z = z + rz * disp

    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.update()

def assign_sphere_uvs(obj, radius):
    """v0.73.3 — deterministic spherical UV projection (same convention
    as the game's icosphere: U = atan2(z, x)/2pi + 0.5, V from the
    vertical axis). Replaces the previous smart-project unwrap, which
    packed the displaced sphere's many islands into only ~17% of the
    texture — the other 83% baked as pure black, so the GLB read as a
    dark faceted blob with "missing" textures (baked albedo/roughness
    means of 0.10 / 0.15 instead of ~0.5 / ~0.95).

    Spherical projection gives near-full coverage with a single U seam
    (covered by the bake margin), matching how the game's own icosphere
    UVs work."""
    import bmesh
    me = obj.data
    # v0.73.3 — the icosphere operator ships a default UVMap. Baking +
    # glTF export then used THAT layer (TEXCOORD_0, a half-empty
    # projection) instead of ours, leaving ~70% of the texture black.
    # Remove every existing layer first so ours is the ONLY one.
    for layer in list(me.uv_layers):
        me.uv_layers.remove(layer)
    bm = bmesh.new()
    bm.from_mesh(me)
    # Normalize V over the ACTUAL displaced vertex y-bounds.
    ys = [v.co.y for v in bm.verts]
    ymin, ymax = min(ys), max(ys)
    vspan = (ymax - ymin) or 1e-6
    uv = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for loop in f.loops:
            v = loop.vert.co
            u = math.atan2(v.z, v.x) / (2 * math.pi) + 0.5
            vv = (v.y - ymin) / vspan  # real bounds -> 0..1
            loop[uv].uv = (u, vv)
    bm.to_mesh(me)
    bm.free()
    me.update()
    if me.uv_layers:
        me.uv_layers.active = me.uv_layers[0]

# ---------------------------------------------------------------------------
# Materials + baking
# ---------------------------------------------------------------------------

def make_material(obj, seed):
    """Brighter regolith: a Mix node blends a light tan base with a dark
    brown patch, driven by a Noise texture — baked albedo lands in
    [0.38..0.62] instead of the old near-black `noise.Fac` output."""
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

    set_inp(noise, ("Scale",), 6.0)
    set_inp(noise, ("Detail",), 8.0)
    set_inp(noise, ("Roughness",), 0.65)
    set_inp(noise, ("W", "Seed"), float(seed))

    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["Factor"].default_value = 0.55
    mix.inputs["A"].default_value = (0.62, 0.58, 0.50, 1.0)  # light tan
    mix.inputs["B"].default_value = (0.38, 0.34, 0.30, 1.0)  # dark brown
    nt.links.new(noise.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    nt.links.new(out.inputs["Surface"], bsdf.outputs["BSDF"])
    obj.data.materials.append(mat)
    return mat, bsdf

def bake_maps(obj, mat, out_dir, stem, size=1024, samples=24):
    """Bake albedo/normal/roughness/AO into images, save them to disk,
    and return a {name: image} map. The images are NOT yet wired into
    the material (see wire_material) — this keeps the bake source
    (procedural nodes) separate from the baked result."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
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
    imgs = {}
    for name, bake_type, colorspace in specs:
        img = bpy.data.images.new(f"bake_{name}", size, size)
        img.colorspace_settings.name = colorspace
        tex = nt_node_for(mat, img)
        nt_set_active(mat, tex)
        if bake_type == "DIFFUSE":
            # v0.73.3 (review, 2nd fix): pass the pass-mask as the
            # `pass_filter` enum-set OPERATOR kwarg. The first fix tried
            # `use_pass_direct/indirect/color` kwargs — those exist only as
            # `scene.render.bake` props on old Blender and are neither
            # operator kwargs nor scene props on Blender 5.x, so the bake
            # raised `TypeError: keyword "use_pass_direct" unrecognized`
            # (verified on Blender 5.2.0). `pass_filter={'COLOR'}` bakes the
            # surface color with NO direct/indirect lighting — the correct
            # unlit albedo for the game's dynamic sun — and is the standard
            # operator kwarg on 3.x/4.x/5.x alike (verified via
            # `bpy.ops.object.bake.get_rna_type().properties`).
            bake_kwargs = dict(pass_filter={"COLOR"})
        else:
            bake_kwargs = {}
        bpy.ops.object.bake(type=bake_type, **bake_kwargs)
        path = os.path.join(out_dir, f"{stem}-{name}.png")
        img.save_render(filepath=path)
        img.filepath_raw = path  # glTF exporter embeds via filepath
        print(f"  baked {name} -> {path}")
        imgs[name] = img
    return imgs

def nt_node_for(mat, img):
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    return tex

def nt_set_active(mat, tex):
    mat.node_tree.nodes.active = tex
    tex.select = True

def wire_material(mat, bsdf, imgs):
    """v0.73.3 — the CRITICAL step: wire the baked images into the
    material's inputs so the glTF exporter embeds them. The previous
    version saved the maps to disk but left the procedural Noise/Mix
    nodes on the material — the exporter dropped those (procedural
    shaders are not exportable) and the GLB shipped textureless."""
    nt = mat.node_tree

    def tex_node(img):
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = img
        return t

    # Base Color <- albedo (sRGB)
    alb = tex_node(imgs["albedo"])
    nt.links.new(alb.outputs["Color"], bsdf.inputs["Base Color"])
    # Roughness <- roughness (Non-Color)
    rou = tex_node(imgs["roughness"])
    nt.links.new(rou.outputs["Color"], bsdf.inputs["Roughness"])
    # Normal <- normal (Non-Color) through a Normal Map node
    nm = tex_node(imgs["normal"])
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    # Occlusion <- AO (Non-Color) — Principled BSDF has an Occlusion
    # input in Blender 4.1+; skip gracefully if absent.
    if "Occlusion" in bsdf.inputs:
        ao = tex_node(imgs["ao"])
        nt.links.new(ao.outputs["Color"], bsdf.inputs["Occlusion"])
    # Remove the procedural nodes (they are not exportable and would
    # only confuse the exporter).
    for n in list(nt.nodes):
        if n.type in ("TEX_NOISE", "MIX"):
            nt.nodes.remove(n)

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
    for i, a in enumerate(argv):
        if a.endswith(needle):
            return argv[i + 1:]
    return argv[1:]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--radius", type=float, default=8.0)
    ap.add_argument("--detail", type=int, default=6)
    ap.add_argument("--out", default="artifacts/blender")
    args = ap.parse_args(script_args())

    os.makedirs(args.out, exist_ok=True)
    stem = f"asteroid-{args.seed}"

    clean_scene()
    obj = add_icosphere(args.radius, args.detail)
    print(f"  icosphere: {len(obj.data.vertices)} verts, {len(obj.data.polygons)} faces")
    displace_radially(obj, args.radius, args.seed)
    # v0.73.3 geometry self-check: with the game-mirroring hash + clamps the
    # displaced radius MUST stay inside the clamp envelope: base +-0.3r,
    # crater -0.5r/+0.4r, boulder +0.45r -> theoretical minR = r - 0.8r =
    # 0.2r, maxR = r + 1.15r = 2.15r. The check bounds [0.1r, 2.5r] are
    # deliberately LOOSER than the theoretical envelope (a vertex at a
    # crater center with base noise n~0 legitimately reaches ~0.2r) but
    # still catch the regression this guards (measured maxR=72.56 when the
    # hash used int() truncation) — fail the bake loudly instead of
    # shipping a broken GLB.
    rs = [v.co.length for v in obj.data.vertices]
    mr, mn = max(rs), min(rs)
    lo, hi = args.radius * 0.1, args.radius * 2.5
    if not (lo <= mn <= mr <= hi):
        raise SystemExit(
            f"GEOMETRY CHECK FAILED: radius={args.radius} minR={mn:.2f} maxR={mr:.2f} "
            f"(expected [{lo:.1f}, {hi:.1f}])"
        )
    print(f"  geometry check: minR={mn:.2f} maxR={mr:.2f} OK")
    assign_sphere_uvs(obj, args.radius)
    mat, bsdf = make_material(obj, args.seed)
    imgs = bake_maps(obj, mat, args.out, stem)
    wire_material(mat, bsdf, imgs)
    export_glb(obj, args.out, stem)

    print(f"POC OK: {stem}.glb + 4 maps in {os.path.abspath(args.out)}")

if __name__ == "__main__":
    main()
