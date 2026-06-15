import * as THREE from 'three';

/**
 * Capsule — a closed, indexed (merged-vertex) capsule mesh.
 *
 * Why "merged" matters:
 *   Every vertex in the position attribute is unique and is referenced
 *   by the index buffer. Moving one vertex moves every triangle that
 *   shares it, so the surface stays connected — jitter can never
 *   create gaps or holes in the surface. Non-indexed geometries
 *   (like `THREE.CapsuleGeometry`) duplicate vertices per face, so
 *   per-vertex jitter can tear the surface.
 *
 * Frame:
 *   The capsule's long axis is +Y. The body's equator is at y = 0; the
 *   body extends from y = -length/2 to y = +length/2; the hemispherical
 *   caps extend from y = -length/2 (bottom cap's equator) down to
 *   y = -length/2 - radius (bottom pole), and from y = +length/2 (top
 *   cap's equator) up to y = +length/2 + radius (top pole). Total
 *   height: `length + 2 × radius`.
 *
 * The "local z axis" at a vertex:
 *   At every vertex on the surface, the local z axis is the outward
 *   surface normal — the unit vector pointing away from the surface.
 *     - Body vertices: normal is purely radial (no Y component).
 *     - Cap-ring vertices: normal has a radial component and a Y
 *       component (positive at the top cap, negative at the bottom
 *       cap, growing as you approach the pole).
 *     - Poles: normal points straight up (top pole) or down (bottom
 *       pole).
 *   These normals are computed by `computeVertexNormals()` in the
 *   constructor. `jitter()` uses them as the "local z axis" to
 *   displace each vertex.
 *
 * jitter(amount, rng):
 *   Moves each vertex by (rng() * 2 - 1) * amount along its local z
 *   axis (the vertex normal). The index buffer is unchanged, so the
 *   surface stays connected — no holes, no gaps. The result is a
 *   bumpy "potato" shape. The new vertex normals are recomputed
 *   afterwards so lighting reflects the displaced surface.
 *
 * heightSegments:
 *   The body's "pipe" (the cylindrical middle section between the
 *   two hemispherical caps) is subdivided along its length. The
 *   body's bottom ring is at y = -length/2 and the top ring is at
 *   y = +length/2; `heightSegments` is the number of QUADS
 *   between them (so `heightSegments = 1` means the original
 *   2-ring body, and `heightSegments = 6` means 7 rings along
 *   the body for a much denser, more "asteroid-potato" surface
 *   after jitter). The cap segments are independent (they live
 *   above/below the body, not on the same rings). For rocky
 *   asteroids, the production value is 6 (see
 *   `src/entities/asteroid.js` `CAPSULE_HEIGHT_SEGMENTS`).
 *
 * @param {number} [radius=1]
 * @param {number} [length=1]
 * @param {number} [capSegments=4]      latitude subdivisions per cap
 * @param {number} [radialSegments=8]   longitude subdivisions
 * @param {number} [heightSegments=1]   body "pipe" segments along length
 */
export class Capsule extends THREE.BufferGeometry {
  constructor(radius = 1, length = 1, capSegments = 4, radialSegments = 8, heightSegments = 1) {
    super();
    this.parameters = { radius, length, capSegments, radialSegments, heightSegments };
    this._build(radius, length, capSegments, radialSegments, heightSegments);
  }

  _build(radius, length, capSegments, radialSegments, heightSegments) {
    const ringSize = radialSegments + 1; // +1 for the wrap vertex (clean UV seam)
    const bodyRings = heightSegments + 1; // body has (segments + 1) rings (top + bottom + intermediates)

    // ---- 1. Vertex positions ------------------------------------------
    // Layout, in order:
    //   [body rings | top cap rings | top pole | bottom cap rings | bottom pole]
    //
    // The body's top ring and the top cap's first intermediate ring
    // are at the SAME y and radial position by construction (the cap
    // is a hemisphere sitting on top of the cylinder), but they are
    // stored as separate vertices in the position buffer so the
    // per-vertex normals can differ. The body's normal is purely
    // radial; the cap's normal has a Y component.
    //
    // Similarly the body's bottom ring and the bottom cap's first
    // intermediate ring are at the same y and radial position.
    const capRings = capSegments - 1; // intermediate cap rings (the body's top/bottom ring is the first cap ring)
    const totalVerts =
      bodyRings * ringSize +      // body: (heightSegments + 1) rings
      capRings * ringSize +       // top cap intermediate rings
      1 +                         // top pole
      capRings * ringSize +       // bottom cap intermediate rings
      1;                          // bottom pole
    const positions = new Float32Array(totalVerts * 3);

    // Index of the top pole in the position buffer.
    const topPoleIdx = bodyRings * ringSize + capRings * ringSize;
    // Index of the bottom pole.
    const bottomPoleIdx = topPoleIdx + 1 + capRings * ringSize;

    let v = 0;
    const pushVertex = (x, y, z) => {
      positions[v++] = x;
      positions[v++] = y;
      positions[v++] = z;
    };

    // 1a. Body — bodyRings rings from y = -length/2 to y = +length/2,
    //     purely radial. heightSegments=1 → 2 rings (top + bottom).
    //     heightSegments=6 → 7 rings (top + bottom + 5 intermediates).
    for (let iy = 0; iy < bodyRings; iy++) {
      const t = bodyRings === 1 ? iy : iy / heightSegments;
      const y = -length / 2 + t * length;
      for (let ix = 0; ix <= radialSegments; ix++) {
        const theta = (ix / radialSegments) * Math.PI * 2;
        pushVertex(radius * Math.cos(theta), y, radius * Math.sin(theta));
      }
    }

    // 1b. Top cap — capRings intermediate rings
    //     Ring iy (for iy in 1..capSegments-1) is at latitude angle
    //     phi = iy * (π/2) / capSegments. The ring is a circle of
    //     radius r = R*cos(phi) at height y = length/2 + R*sin(phi).
    for (let iy = 1; iy < capSegments; iy++) {
      const phi = (iy / capSegments) * (Math.PI / 2);
      const r = radius * Math.cos(phi);
      const y = length / 2 + radius * Math.sin(phi);
      for (let ix = 0; ix <= radialSegments; ix++) {
        const theta = (ix / radialSegments) * Math.PI * 2;
        pushVertex(r * Math.cos(theta), y, r * Math.sin(theta));
      }
    }
    // Top pole — straight up at the cap tip.
    pushVertex(0, length / 2 + radius, 0);

    // 1c. Bottom cap — capRings intermediate rings
    for (let iy = 1; iy < capSegments; iy++) {
      const phi = (iy / capSegments) * (Math.PI / 2);
      const r = radius * Math.cos(phi);
      const y = -length / 2 - radius * Math.sin(phi);
      for (let ix = 0; ix <= radialSegments; ix++) {
        const theta = (ix / radialSegments) * Math.PI * 2;
        pushVertex(r * Math.cos(theta), y, r * Math.sin(theta));
      }
    }
    // Bottom pole — straight down at the cap tip.
    pushVertex(0, -length / 2 - radius, 0);

    this.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // ---- 2. Index buffer ----------------------------------------------
    // For each pair of adjacent rings, we make `radialSegments` quads.
    // Each quad is 2 triangles. The wrap vertex (ix == radialSegments)
    // is a single shared vertex in the position buffer, so the wrap
    // edge is a normal quad — no seam.
    //
    // Winding:
    //   - Top cap (and body): CCW from outside. Outward is +Y at the
    //     pole, radial in the body, and radial+Y in the top cap rings.
    //   - Bottom cap: reversed (CCW from outside means CCW from
    //     below, so the outward -Y face has a reversed winding when
    //     viewed from above).
    const indices = [];

    const pushRingQuads = (ringLoStart, ringHiStart, flipWinding) => {
      for (let ix = 0; ix < radialSegments; ix++) {
        const a = ringLoStart + ix;
        const b = ringLoStart + ix + 1;
        const c = ringHiStart + ix;
        const d = ringHiStart + ix + 1;
        if (flipWinding) {
          indices.push(a, b, c, b, d, c);
        } else {
          indices.push(a, c, b, b, c, d);
        }
      }
    };

    // 2a. Body — chain of `heightSegments` ring connections, from the
    //     bottom ring (start=0) to the top ring
    //     (start=heightSegments*ringSize). With heightSegments=1 this
    //     is a single span (the original 2-ring body); with
    //     heightSegments=6 it's 6 spans connecting 7 body rings.
    for (let seg = 0; seg < heightSegments; seg++) {
      const ringLoStart = seg * ringSize;
      const ringHiStart = (seg + 1) * ringSize;
      pushRingQuads(ringLoStart, ringHiStart, false);
    }

    // 2b. Top cap — chain of capRings ring connections, ending at the
    //     last intermediate ring (just below the pole). The first
    //     span connects the body's TOP ring to the first
    //     intermediate cap ring; subsequent spans go from one cap
    //     intermediate to the next.
    for (let iy = 0; iy < capSegments - 1; iy++) {
      const ringLoStart = iy === 0
        ? heightSegments * ringSize
        : bodyRings * ringSize + (iy - 1) * ringSize;
      const ringHiStart = bodyRings * ringSize + iy * ringSize;
      pushRingQuads(ringLoStart, ringHiStart, false);
    }
    // Last intermediate ring to top pole — radialSegments triangles
    // fanning from the ring to the pole.
    const lastTopRingStart = bodyRings * ringSize + (capSegments - 2) * ringSize;
    for (let ix = 0; ix < radialSegments; ix++) {
      indices.push(lastTopRingStart + ix, topPoleIdx, lastTopRingStart + ix + 1);
    }

    // 2c. Bottom cap — chain of capRings ring connections, ending at
    //     the last intermediate ring (just above the bottom pole).
    const bottomCapStart = topPoleIdx + 1;
    for (let iy = 0; iy < capSegments - 1; iy++) {
      const ringLoStart = iy === 0
        ? 0
        : bottomCapStart + (iy - 1) * ringSize;
      const ringHiStart = bottomCapStart + iy * ringSize;
      pushRingQuads(ringLoStart, ringHiStart, true);
    }
    // Last intermediate ring to bottom pole — reversed winding.
    const lastBottomRingStart = bottomCapStart + (capSegments - 2) * ringSize;
    for (let ix = 0; ix < radialSegments; ix++) {
      indices.push(lastBottomRingStart + ix, lastBottomRingStart + ix + 1, bottomPoleIdx);
    }

    this.setIndex(indices);

    // ---- 3. Vertex normals (the per-vertex local "z axis") ------------
    this.computeVertexNormals();
  }

  /**
   * Jitter (move) each vertex along its local z axis (the vertex
   * normal) by a random amount in [-amount, +amount]. The index
   * buffer is unchanged, so the surface stays connected — no holes,
   * no gaps. The new vertex normals are recomputed afterwards so
   * lighting reflects the displaced surface.
   *
   * **UV-seam wrap sync.** Each ring has a wrap vertex at
   * `ix === radialSegments` that duplicates `ix === 0` in the
   * original geometry (it's there for clean UV continuity across
   * the seam). The wrap and `ix === 0` start at the same world
   * position; if they got independent jitter offsets they would
   * diverge and visibly tear the seam. We pre-compute the offsets
   * and force the wrap to share `ix === 0`'s offset, so they stay
   * at the same position throughout.
   *
   * Working directly on the underlying typed arrays (rather than
   * `getX`/`setXYZ`) keeps the per-frame work tight if `jitter` is
   * ever called on hot geometry.
   *
   * @param {number} amount max offset magnitude (world units)
   * @param {() => number} rng returns [0, 1)
   */
  jitter(amount, rng) {
    const positions = this.attributes.position.array;
    const normals = this.attributes.normal.array;
    const { radialSegments, capSegments, heightSegments } = this.parameters;
    const ringSize = radialSegments + 1;
    const numCapRings = capSegments - 1;
    const bodyRings = heightSegments + 1;
    const totalRings = bodyRings + 2 * numCapRings;
    const totalVerts = positions.length / 3;

    // Pre-compute jitter offsets. The wrap vertex (ix === radialSegments)
    // of each ring shares its offset with the ring's ix === 0 vertex
    // (no new rng() call for the wrap), so the wrap and ix === 0 stay
    // at the same world position throughout.
    //
    // The iteration order matches the build layout exactly: body
    // rings (bodyRings) → top cap intermediate rings (capSegments-1)
    // → top pole (1) → bottom cap intermediate rings (capSegments-1)
    // → bottom pole (1). This matters because the top pole is a single
    // vertex at index bodyRings*ringSize + (capSegments-1)*ringSize, so
    // the first bottom cap ring starts at topPoleIdx + 1 (not at
    // (bodyRings+capSegments)*ringSize).
    const offsets = new Float32Array(totalVerts);
    const topPoleIdx = bodyRings * ringSize + numCapRings * ringSize;

    // Body rings (heightSegments + 1 rings: top + bottom + intermediates)
    for (let r = 0; r < bodyRings; r++) {
      const ringStart = r * ringSize;
      for (let ix = 0; ix < radialSegments; ix++) {
        offsets[ringStart + ix] = (rng() * 2 - 1) * amount;
      }
      offsets[ringStart + radialSegments] = offsets[ringStart];
    }
    // Top cap intermediate rings (iy = 1 .. capSegments-1)
    for (let iy = 1; iy < capSegments; iy++) {
      const ringStart = bodyRings * ringSize + (iy - 1) * ringSize;
      for (let ix = 0; ix < radialSegments; ix++) {
        offsets[ringStart + ix] = (rng() * 2 - 1) * amount;
      }
      offsets[ringStart + radialSegments] = offsets[ringStart];
    }
    // Top pole (single vertex)
    offsets[topPoleIdx] = (rng() * 2 - 1) * amount;
    // Bottom cap intermediate rings (iy = 1 .. capSegments-1)
    for (let iy = 1; iy < capSegments; iy++) {
      const ringStart = topPoleIdx + 1 + (iy - 1) * ringSize;
      for (let ix = 0; ix < radialSegments; ix++) {
        offsets[ringStart + ix] = (rng() * 2 - 1) * amount;
      }
      offsets[ringStart + radialSegments] = offsets[ringStart];
    }
    // Bottom pole (single vertex)
    const bottomPoleIdx = topPoleIdx + 1 + numCapRings * ringSize;
    offsets[bottomPoleIdx] = (rng() * 2 - 1) * amount;

    // Apply the offsets in a single pass.
    for (let i = 0; i < totalVerts; i++) {
      const offset = offsets[i];
      const k = i * 3;
      positions[k]     += normals[k]     * offset;
      positions[k + 1] += normals[k + 1] * offset;
      positions[k + 2] += normals[k + 2] * offset;
    }

    // Force each wrap vertex (ix === radialSegments) to share the
    // base vertex's (ix === 0) displaced position. Without this, the
    // wrap and base have different normals (averaged from different
    // surrounding triangles — the wrap is in the last quad of the
    // ring, the base is in the first quad), so the shared scalar
    // offset would displace them in *different directions* and the
    // UV seam would visibly tear. Copying the base's post-displacement
    // position to the wrap forces them to occupy the same world
    // point, which is what the "wrap vertex exists for clean UV
    // continuity" design intent actually requires.
    //
    // The wrap is still a separate vertex in the index buffer (so the
    // last quad closes the ring), it just shares the base's position
    // instead of having its own offset-displaced position.
    //
    // The iteration covers ALL rings in the capsule (body + top cap
    // intermediates + bottom cap intermediates). The +1 offset for
    // `r >= bodyRings + numCapRings` accounts for the top pole vertex
    // sitting at index bodyRings*ringSize + numCapRings*ringSize —
    // for ring indices past that pole, every subsequent vertex index
    // is shifted by +1. (Note: `>=`, not `>` — the bottom cap's
    // first ring is at `r === bodyRings + numCapRings` and DOES need
    // the +1 shift.)
    for (let r = 0; r < totalRings; r++) {
      const ringStart = r * ringSize + (r >= bodyRings + numCapRings ? 1 : 0);
      const baseIdx = ringStart;
      const wrapIdx = ringStart + radialSegments;
      positions[wrapIdx * 3]     = positions[baseIdx * 3];
      positions[wrapIdx * 3 + 1] = positions[baseIdx * 3 + 1];
      positions[wrapIdx * 3 + 2] = positions[baseIdx * 3 + 2];
    }

    this.attributes.position.needsUpdate = true;
    this.computeVertexNormals();
  }

  /**
   * Compute cylindrical UV coordinates for the capsule. One-shot
   * post-process — call this after `_build()` (and optionally after
   * `jitter()`) to make the surface texture-able.
   *
   * Mapping (cylindrical unwrap):
   *   - U = atan2(z, x) / (2π) + 0.5   →  [0, 1) longitude around the capsule
   *   - V = (y - yMin) / (yMax - yMin) →  [0, 1] from the bottom pole to the top pole
   *
   * The body ring and the cap rings share the same U seam (ix === 0
   * / ix === radialSegments), so the texture wraps cleanly around
   * the capsule. V is monotonic in y, so the texture runs from the
   * bottom pole up through the body and into the top pole.
   *
   * This is a simple, world-space-agnostic projection — it works
   * for any capsule size/orientation without needing to know the
   * vertex layout. The slight redundancy at the poles (where V
   * collapses to a single y) is acceptable for a rocky-albedo
   * texture: the visual complexity hides the pinching.
   *
   * Idempotent: safe to call multiple times.
   */
  computeUVs() {
    const positions = this.attributes.position.array;
    const vertCount = positions.length / 3;
    const uvs = new Float32Array(vertCount * 2);

    // Find yMin / yMax from the (possibly jittered) positions.
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i < vertCount; i++) {
      const y = positions[i * 3 + 1];
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    const yRange = yMax - yMin || 1;

    const invTwoPi = 1 / (Math.PI * 2);
    for (let i = 0; i < vertCount; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      const z = positions[i * 3 + 2];
      const u = Math.atan2(z, x) * invTwoPi + 0.5;
      const v = (y - yMin) / yRange;
      uvs[i * 2]     = u;
      uvs[i * 2 + 1] = v;
    }

    this.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return this;
  }

  /**
   * Compute a **planar UV unwrap** in the mesh's LOCAL frame. One-shot
   * post-process — call this after `_build()` (and optionally after
   * `jitter()`) to make the surface texture-able without using
   * world-space tricks (triplanar, etc.).
   *
   * Mapping (planar projection onto one of the 3 axis-aligned planes):
   *   - `'xy'`: U = x, V = y   →  side view (best for a vertical capsule)
   *   - `'xz'`: U = x, V = z   →  top-down view
   *   - `'yz'`: U = y, V = z   →  side view (rotated 90°)
   *
   * The raw (u, v) are normalized to [0, 1] by subtracting the
   * bounding box's min and dividing by its range. This means each
   * capsule ends up with a UV space tightly fit to its own
   * dimensions — the texture is "stuck to" the mesh, not to the
   * world.
   *
   * **Trade-off.** A single-plane projection stretches on the
   * "back" of the mesh (the half facing away from the projection
   * direction). For an elongated capsule, `'xy'` or `'yz'` gives
   * the most useful unwrap (the long axis is one of the texture
   * coordinates); the "back" is the dome of one of the caps, which
   * is visually small. For a more even distribution, a smart /
   * per-axis projection (e.g. triplanar in local space) would be
   * better, but the user explicitly wanted a plain planar map.
   *
   * Idempotent: safe to call multiple times. Calling after
   * `jitter()` aligns the UVs with the displaced surface.
   *
   * @param {'xy'|'xz'|'yz'} [plane='xy'] which axis-aligned plane to project onto
   * @returns {this}
   */
  computePlanarUVs(plane = 'xy') {
    const positions = this.attributes.position.array;
    const vertCount = positions.length / 3;
    const uvs = new Float32Array(vertCount * 2);

    // Pick the 2 axes to project onto based on the plane.
    // Indices are into the position array (x=0, y=1, z=2).
    const planeAxes = {
      xy: [0, 1], // U = x, V = y
      xz: [0, 2], // U = x, V = z
      yz: [1, 2], // U = y, V = z
    };
    const axes = planeAxes[plane] || planeAxes.xy;
    const aU = axes[0];
    const aV = axes[1];

    // Find uMin, uMax, vMin, vMax from the (possibly jittered) positions.
    let uMin = Infinity, uMax = -Infinity;
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < vertCount; i++) {
      const u = positions[i * 3 + aU];
      const v = positions[i * 3 + aV];
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const uRange = uMax - uMin || 1;
    const vRange = vMax - vMin || 1;

    for (let i = 0; i < vertCount; i++) {
      const u = positions[i * 3 + aU];
      const v = positions[i * 3 + aV];
      uvs[i * 2]     = (u - uMin) / uRange;
      uvs[i * 2 + 1] = (v - vMin) / vRange;
    }

    this.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    return this;
  }
}
