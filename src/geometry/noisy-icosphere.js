import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic 3D value noise + fbm (fractal Brownian motion)
// ---------------------------------------------------------------------------
// Simple but effective GLSL-style hash. Deterministic for integer inputs
// (the floor() of a vertex's pre-noise position), produces [0, 1).
function hash3D(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

// Trilinear interpolation of hashed grid corners.
function noise3D(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;

  const ux = smoothstep(fx);
  const uy = smoothstep(fy);
  const uz = smoothstep(fz);

  const c000 = hash3D(ix, iy, iz);
  const c100 = hash3D(ix + 1, iy, iz);
  const c010 = hash3D(ix, iy + 1, iz);
  const c110 = hash3D(ix + 1, iy + 1, iz);
  const c001 = hash3D(ix, iy, iz + 1);
  const c101 = hash3D(ix + 1, iy, iz + 1);
  const c011 = hash3D(ix, iy + 1, iz + 1);
  const c111 = hash3D(ix + 1, iy + 1, iz + 1);

  const x00 = c000 + (c100 - c000) * ux;
  const x10 = c010 + (c110 - c010) * ux;
  const x01 = c001 + (c101 - c001) * ux;
  const x11 = c011 + (c111 - c011) * ux;

  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;

  return y0 + (y1 - y0) * uz;
}

// Sum of noise octaves with halving amplitude and doubling frequency.
// Normalized to [0, 1].
function fbm3D(x, y, z, octaves = 4) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxValue;
}

/**
 * An icosphere with noise-displaced vertices for an irregular,
 * asteroid-like surface.
 *
 * Built on top of `THREE.IcosahedronGeometry`, which is **non-indexed**:
 * each triangular face has its own 3 vertex copies (so for detail=0 the
 * 20 faces produce 60 position entries even though there are only 12
 * geometrically-unique vertices).
 *
 * The noise is computed from each vertex's ORIGINAL (pre-noise) position
 * using a deterministic hash-based 3D value noise + 4-octave fbm. Since
 * the 3 copies of a vertex share the same position, they get the SAME
 * noise value and the SAME displacement — the faces stay connected and
 * the surface cannot tear. (This avoids the `mergeVertices` workaround
 * that didn't work in some environments.)
 *
 * The `offsetX/Y/Z` parameters add a per-instance offset to the noise
 * input, so different asteroids get different shapes from the same
 * noise function. Pass per-asteroid random offsets to get visual
 * variety across the field.
 *
 * @param {number} [radius=1] vertex distance from origin
 * @param {number} [detail=1] IcosahedronGeometry detail (0–4 typical)
 * @param {number} [noiseAmount=0.3] max displacement along the radial
 * @param {number} [noiseScale=2.0] frequency of the noise
 * @param {number} [offsetX=0] per-instance X offset for the noise input
 * @param {number} [offsetY=0] per-instance Y offset for the noise input
 * @param {number} [offsetZ=0] per-instance Z offset for the noise input
 */
export class NoisyIcosphere extends THREE.BufferGeometry {
  constructor(
    radius = 1,
    detail = 1,
    noiseAmount = 0.3,
    noiseScale = 2.0,
    offsetX = 0,
    offsetY = 0,
    offsetZ = 0,
  ) {
    super();

    const baseGeom = new THREE.IcosahedronGeometry(radius, detail);
    const basePositions = baseGeom.attributes.position;
    const positions = new Float32Array(basePositions.array);

    for (let i = 0; i < basePositions.count; i++) {
      const x = basePositions.getX(i);
      const y = basePositions.getY(i);
      const z = basePositions.getZ(i);

      // fbm at the offset+position (same for all 3 copies of a vertex
      // since they share the same position).
      const n = fbm3D(
        (x + offsetX) * noiseScale,
        (y + offsetY) * noiseScale,
        (z + offsetZ) * noiseScale,
        4,
      );
      // Center the noise around 0: [-0.5, 0.5], scale by 2 × amount.
      const displacement = (n - 0.5) * 2 * noiseAmount;

      // Radial direction (the normal of a sphere is the radial direction).
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len > 0) {
        const nx = x / len;
        const ny = y / len;
        const nz = z / len;
        positions[i * 3 + 0] = x + nx * displacement;
        positions[i * 3 + 1] = y + ny * displacement;
        positions[i * 3 + 2] = z + nz * displacement;
      }
    }

    this.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.computeVertexNormals();

    baseGeom.dispose();
  }
}
