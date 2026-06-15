/**
 * Create the compute-layout tool.
 *
 * Owns the `computeLayout(entity)` function that builds the
 * UV layout from the selected asteroid's geometry:
 *   - `faces` — array of `{ a, b, c, uvA, uvB, uvC }` per
 *     triangle (handles both indexed and non-indexed
 *     geometries)
 *   - `seamEdges` — array of edges where adjacent faces
 *     disagree about UVs (the auto-detected seam set;
 *     encoded as both `vertKey` for 3D overlay matching and
 *     `uvA`/`uvB` for 2D rendering)
 *   - `faceAdjacency` — array of Sets; `faceAdjacency[i]`
 *     contains the indices of faces that share a NON-seam
 *     edge with face `i`. Used by Grow/Shrink selection
 *     (BFS in insertion order, so deterministic).
 *   - `islands` — array of `{ faces, centroidUv, color }`
 *     discovered by BFS over `faceAdjacency`. Each island's
 *     centroid is the average of its faces' UV centroids;
 *     its color is assigned by `colorForIsland` (HSV spread
 *     so adjacent islands have visually distinct hues).
 *   - `uvs` — flat `[[u, v], …]` array of every vertex's
 *     UV coordinate (for the 2D panel's free-point
 *     rendering and the seam-toggle hit-test).
 *   - `vertexCount`, `faceCount` — convenience counts for
 *     the stats line.
 *
 * The factory is **stateless** — every call to
 * `computeLayout` returns a fresh object built from the
 * current geometry. The result is stored on the
 * orchestrator's `layout` `let` variable and read by the
 * drawing/selection/picking tools via the
 * `getLayout: () => layout` dep.
 *
 * @param {object} _state - editor state (unused; accepted
 *   for consistency with the other tool factories)
 * @param {object} deps
 * @param {(va: number, vb: number) => number} deps.buildEdgeKey
 *   — vertex-pair → key encoder (from `uv-unwrapping.js`)
 * @param {() => (centroidUv: [number, number], index: number) => [number, number, number]}
 *   deps.getColorForIsland — getter for the deterministic
 *   HSV-spread island color function (from the draw tool)
 * @returns {{
 *   computeLayout: (entity: { mesh: THREE.Group } | null) => object | null,
 * }}
 */
export function createComputeLayoutTool(_state, deps) {
  const { buildEdgeKey, getColorForIsland } = deps;

  if (typeof buildEdgeKey !== 'function') {
    throw new Error('createComputeLayoutTool: `buildEdgeKey` must be a function');
  }
  if (typeof getColorForIsland !== 'function') {
    throw new Error('createComputeLayoutTool: `getColorForIsland` must be a function');
  }

  /**
   * Build the UV layout for the given entity's mesh body.
   * Returns `null` if the entity has no body, no geometry,
   * or no `uv` attribute. Otherwise returns an object with
   * `faces`, `islands`, `seamEdges`, `vertexCount`,
   * `faceCount`, `faceAdjacency`, and `uvs` (see factory
   * JSDoc above).
   *
   * @param {{ mesh: THREE.Group } | null} entity
   * @returns {object | null}
   */
  function computeLayout(entity) {
    // Hoist the color helper to a local const so the per-island
    // BFS loop below calls the function directly instead of
    // re-invoking the getter on every island. The getter is
    // cheap but called O(islandCount) times, and this makes
    // the call site read cleaner.
    const colorForIsland = getColorForIsland();
    const body = entity && entity.mesh && entity.mesh.children && entity.mesh.children[0];
    if (!body) return null;
    let geometry;
    if (body.isLOD) {
      geometry = body.levels[0] && body.levels[0].object && body.levels[0].object.geometry;
    } else {
      geometry = body.geometry;
    }
    if (!geometry) return null;
    const uvAttr = geometry.attributes.uv;
    if (!uvAttr) return null;
    const indexArr = geometry.index ? geometry.index.array : null;
    const uvArr = uvAttr.array;
    const faces = [];
    const faceCount = indexArr ? Math.floor(indexArr.length / 3) : Math.floor(uvArr.length / 2 / 3);
    for (let f = 0; f < faceCount; f++) {
      let a, b, c;
      if (indexArr) {
        a = indexArr[f * 3 + 0]; b = indexArr[f * 3 + 1]; c = indexArr[f * 3 + 2];
      } else {
        a = f * 3 + 0; b = f * 3 + 1; c = f * 3 + 2;
      }
      faces.push({
        a, b, c,
        uvA: [uvArr[a * 2], uvArr[a * 2 + 1]],
        uvB: [uvArr[b * 2], uvArr[b * 2 + 1]],
        uvC: [uvArr[c * 2], uvArr[c * 2 + 1]],
      });
    }
    const edgeToFaces = new Map();
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      const edges = [
        [face.a, face.b, face.uvA, face.uvB],
        [face.b, face.c, face.uvB, face.uvC],
        [face.c, face.a, face.uvC, face.uvA],
      ];
      for (const [va, vb, uva, uvb] of edges) {
        const lo = Math.min(va, vb), hi = Math.max(va, vb);
        const key = lo * 1000000 + hi;
        let entry = edgeToFaces.get(key);
        if (!entry) { entry = { faces: [] }; edgeToFaces.set(key, entry); }
        entry.faces.push({ f, va, vb, uva, uvb });
      }
    }
    const seamEdges = [];
    for (const entry of edgeToFaces.values()) {
      if (entry.faces.length < 2) continue;
      const seen = new Map();
      for (const ef of entry.faces) {
        const isFlipped = ef.va > ef.vb;
        const u0 = isFlipped ? ef.uvb[0] : ef.uva[0];
        const v0 = isFlipped ? ef.uvb[1] : ef.uva[1];
        const u1 = isFlipped ? ef.uva[0] : ef.uvb[0];
        const v1 = isFlipped ? ef.uva[1] : ef.uvb[1];
        const sig = `${u0.toFixed(6)},${v0.toFixed(6)}|${u1.toFixed(6)},${v1.toFixed(6)}`;
        seen.set(sig, ef);
      }
      if (seen.size > 1) {
        const any = entry.faces[0];
        const isFlipped = any.va > any.vb;
        // Vertex-edge key (buildEdgeKey encoding) so the 3D
        // overlay can match auto-detected seams to geometry
        // without a UV lookup. Storing it here also means
        // getSeamState() doesn't need to convert UV→vertex
        // on every call.
        seamEdges.push({
          vertKey: buildEdgeKey(any.va, any.vb),
          va: Math.min(any.va, any.vb),
          vb: Math.max(any.va, any.vb),
          uvA: [isFlipped ? any.uvb[0] : any.uva[0], isFlipped ? any.uvb[1] : any.uva[1]],
          uvB: [isFlipped ? any.uva[0] : any.uvb[0], isFlipped ? any.uva[1] : any.uvb[1]],
        });
      }
    }
    const faceAdj = Array.from({ length: faces.length }, () => new Set());
    for (const entry of edgeToFaces.values()) {
      if (entry.faces.length < 2) continue;
      const seen = new Set();
      for (const ef of entry.faces) {
        const isFlipped = ef.va > ef.vb;
        const u0 = isFlipped ? ef.uvb[0] : ef.uva[0];
        const v0 = isFlipped ? ef.uvb[1] : ef.uva[1];
        const u1 = isFlipped ? ef.uva[0] : ef.uvb[0];
        const v1 = isFlipped ? ef.uva[1] : ef.uvb[1];
        seen.add(`${u0.toFixed(6)},${v0.toFixed(6)}|${u1.toFixed(6)},${v1.toFixed(6)}`);
      }
      if (seen.size > 1) continue;
      for (let i = 0; i < entry.faces.length; i++) {
        for (let j = i + 1; j < entry.faces.length; j++) {
          faceAdj[entry.faces[i].f].add(entry.faces[j].f);
          faceAdj[entry.faces[j].f].add(entry.faces[i].f);
        }
      }
    }
    const islandOf = new Array(faces.length).fill(-1);
    const islands = [];
    for (let f = 0; f < faces.length; f++) {
      if (islandOf[f] !== -1) continue;
      const island = { faces: [], centroidUv: [0, 0] };
      const queue = [f];
      islandOf[f] = islands.length;
      while (queue.length) {
        const cur = queue.shift();
        island.faces.push(cur);
        island.centroidUv[0] += (faces[cur].uvA[0] + faces[cur].uvB[0] + faces[cur].uvC[0]) / 3;
        island.centroidUv[1] += (faces[cur].uvA[1] + faces[cur].uvB[1] + faces[cur].uvC[1]) / 3;
        for (const nb of faceAdj[cur]) {
          if (islandOf[nb] === -1) {
            islandOf[nb] = islands.length;
            queue.push(nb);
          }
        }
      }
      island.centroidUv[0] /= island.faces.length;
      island.centroidUv[1] /= island.faces.length;
      island.color = colorForIsland(island.centroidUv, islands.length);
      islands.push(island);
    }
    const vertexCount = indexArr ? indexArr.length : 0;
    return {
      faces,
      islands,
      seamEdges,
      vertexCount,
      faceCount: faces.length,
      // Face-adjacency cache (faces that share a non-seam edge).
      // Used by Grow/Shrink selection. The BFS visits neighbors
      // in insertion order (Set), so the order is deterministic.
      faceAdjacency: faceAdj,
      uvs: (() => {
        const out = [];
        for (let i = 0; i < uvArr.length / 2; i++) out.push([uvArr[i * 2], uvArr[i * 2 + 1]]);
        return out;
      })(),
    };
  }

  return {
    computeLayout,
  };
}
