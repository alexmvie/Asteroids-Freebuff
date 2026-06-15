import * as THREE from 'three';
import { mulberry32 } from '../world/rng.js';
import {
  STARFIELD_COUNT,
  STARFIELD_RADIUS,
  STARFIELD_SIZE,
  STARFIELD_SEED,
} from '../world/constants.js';

/**
 * Build a starfield as 3 layered THREE.Points objects:
 *   - 70% small/dim stars
 *   - 25% medium stars
 *   - 5%  big/bright stars
 * Each star has a random brightness (in its layer's range) and
 * a slight cool-blue → warm-white color tint. Distribution is
 * deterministic via STARFIELD_SEED.
 *
 * Returns a THREE.Group containing the 3 layers. Add it to
 * the scene with `scene.add(starfield)`.
 */
export function createStarfield({
  count = STARFIELD_COUNT,
  radius = STARFIELD_RADIUS,
  size = STARFIELD_SIZE,
  seed = STARFIELD_SEED,
} = {}) {
  const rng = seed === null ? Math.random : mulberry32(seed >>> 0);
  const group = new THREE.Group();
  group.name = 'starfield';

  const layers = [
    { weight: 0.70, sizeMul: 0.7, bMin: 0.3, bMax: 0.7 },
    { weight: 0.25, sizeMul: 1.5, bMin: 0.5, bMax: 0.9 },
    { weight: 0.05, sizeMul: 3.0, bMin: 0.8, bMax: 1.0 },
  ];

  for (const layer of layers) {
    const layerCount = Math.round(count * layer.weight);
    const positions = new Float32Array(layerCount * 3);
    const colors = new Float32Array(layerCount * 3);

    for (let i = 0; i < layerCount; i++) {
      // Uniform sphere distribution (Marsaglia).
      const u = rng() * 2 - 1;
      const t = rng() * Math.PI * 2;
      const r = radius * (0.85 + rng() * 0.3);
      const s = Math.sqrt(1 - u * u);
      positions[i * 3 + 0] = r * s * Math.cos(t);
      positions[i * 3 + 1] = r * s * Math.sin(t);
      positions[i * 3 + 2] = r * u;

      // Random brightness in this layer's range + slight color tint.
      const b = layer.bMin + rng() * (layer.bMax - layer.bMin);
      const warmth = rng();
      colors[i * 3 + 0] = b * (0.95 + warmth * 0.05);
      colors[i * 3 + 1] = b;
      colors[i * 3 + 2] = b * (0.9 + (1 - warmth) * 0.1);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.PointsMaterial({
      size: size * layer.sizeMul,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      // Stars are decorative backdrop, not part of the play-area fog
      // (FogExp2(0.0018) at 2500 units would fade them to invisible).
      fog: false,
    });

    group.add(new THREE.Points(geom, mat));
  }

  return group;
}
