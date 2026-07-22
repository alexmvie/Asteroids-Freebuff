import * as THREE from 'three';
import {
  SUN_DIRECTION,
  SUN_DISTANCE,
  SUN_MESH_RADIUS,
  SUN_CORONA_RADIUS,
  DIRECTIONAL_INTENSITY,
  POINT_INTENSITY,
  HEMISPHERE_INTENSITY,
  AMBIENT_INTENSITY,
  SUN_COLOR,
  SUN_CORONA_COLOR,
  HEMISPHERE_SKY_COLOR,
  HEMISPHERE_GROUND_COLOR,
  AMBIENT_COLOR,
  SHADOW_MAP_SIZE,
  SHADOW_FRUSTUM_HALF_SIZE,
  SHADOW_NEAR,
  SHADOW_FAR,
} from '../scene/lighting-constants.js';

/**
 * Compute the unit vector from the ship to the sun's position. Since
 * SUN_DIRECTION is a constant Object.freeze, we normalize once and
 * cache the result on the Vector3 to avoid a per-frame sqrt.
 */
const _sunOffset = new THREE.Vector3(
  SUN_DIRECTION.x,
  SUN_DIRECTION.y,
  SUN_DIRECTION.z,
).normalize();

/**
 * Build the v0.68.0 sun + shadow system. Returns
 *
 *   { sunGroup, directionalLight, sunMesh, coronaMesh, pointLight,
 *     hemisphereLight, ambientLight, update(dt, shipPos), dispose() }
 *
 * The user requested four pieces:
 *   1. "eine Sonne wo in der Ferne" → sun mesh + corona halo
 *   2. "ein pointlight von dort"   → PointLight at the sun position
 *   3. "ein passendes environment light" → HemisphereLight + a tiny AmbientLight
 *   4. "plus shadows" → DirectionalLight with castShadow + a properly sized
 *                       shadow camera that moves with the ship
 *
 * Structure: the sun mesh + corona + point light + hemisphere + ambient
 * live inside a single `sunGroup` (THREE.Group). The DirectionalLight
 * lives OUTSIDE the group so its target can be independently pinned at
 * the ship's position (the target is what gives the light its "aim").
 * Both still update per-frame in lockstep.
 *
 * Shadow frustum sizing: the orthographic shadow camera is centred on
 * the light's position, so by moving the light + the ship together
 * the frustum always covers `+/- SHADOW_FRUSTUM_HALF_SIZE` (default
 * ±300u) around the ship. At 2048² map size the resulting shadow
 * resolution is ~3.4 px per world unit, so an 8u-radius asteroid
 * spans ~54px of shadow detail. Shadows further than ~300u fade into
 * shadowmap noise — but the streaming bubble's visible field is
 * inside that radius.
 *
 * @returns {{
 *   sunGroup: THREE.Group,
 *   directionalLight: THREE.DirectionalLight,
 *   sunMesh: THREE.Mesh,
 *   coronaMesh: THREE.Mesh,
 *   pointLight: THREE.PointLight,
 *   hemisphereLight: THREE.HemisphereLight,
 *   ambientLight: THREE.AmbientLight,
 *   update: (dt: number, shipPos: {x:number,y:number,z:number}) => void,
 *   dispose: () => void,
 * }}
 */
export function createSpaceLighting() {
  // ---- Sun mesh ----------------------------------------------------------
  // Bright warm-white sphere. MeshBasicMaterial so the sun is unlit
  // (it IS the light source). `toneMapped: false` keeps the sun at
  // its raw color value instead of being desaturated by the renderer's
  // tone-mapping pass (which kicks in for the asteroids).
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_MESH_RADIUS, 32, 24),
    new THREE.MeshBasicMaterial({
      color: SUN_COLOR,
      toneMapped: false,
      fog: false,
    }),
  );
  sunMesh.frustumCulled = false; // huge; never cull
  sunMesh.renderOrder = -2; // draw before the asteroid field

  // ---- Corona -----------------------------------------------------------
  // Bigger, half-transparent halo sphere drawn behind the sun. Same
  // unlit material but transparent + depth-write off so the sun mesh
  // punches through cleanly. Gives the sun a soft glow without true
  // bloom post-processing (we don't have it).
  const coronaMesh = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_CORONA_RADIUS, 24, 16),
    new THREE.MeshBasicMaterial({
      color: SUN_CORONA_COLOR,
      toneMapped: false,
      transparent: true,
      // v0.69.4: bumped opacity 0.32 -> 0.55 per user "make sun twice
      // bright". Makes the halo sphere visually punchier (more white
      // bleed-through against the deep-space background) without
      // increasing the sun's core mesh brightness (which is clamped
      // to 1.0 in 8-bit framebuffers).
      opacity: 0.55,
      depthWrite: false,
      fog: false,
    }),
  );
  coronaMesh.frustumCulled = false;
  coronaMesh.renderOrder = -3; // behind the sun mesh itself

  // ---- PointLight (the user-requested "from there") ---------------------
  // distance:0 + decay:0 means the light acts like a far-away uniform
  // fill (no distance falloff). Functionally equivalent to a
  // DirectionalLight for the visible field; technically a PointLight
  // so the user's literal request is satisfied. We do NOT enable
  // shadow casting here — the DirectionalLight below does the shadow
  // work with cheap parallel rays; PointLight shadows would cost 6×
  // the runtime (cube-map faces).
  const pointLight = new THREE.PointLight(SUN_COLOR, POINT_INTENSITY, 0, 0);

  // ---- HemisphereLight (environment fill) -------------------------------
  // Reads as a cool blue tint from the "sky" (top hemisphere) and a
  // warm brown tint from the "ground" (bottom hemisphere). Without
  // this, the unlit side of every asteroid would be uniformly dark.
  const hemisphereLight = new THREE.HemisphereLight(
    HEMISPHERE_SKY_COLOR,
    HEMISPHERE_GROUND_COLOR,
    HEMISPHERE_INTENSITY,
  );

  // ---- AmbientLight (tiny floor) ----------------------------------------
  // Belts-and-suspenders against pure-black pixels in deep crevices.
  // Kept small so it doesn't wash out the shadows.
  const ambientLight = new THREE.AmbientLight(AMBIENT_COLOR, AMBIENT_INTENSITY);

  // ---- Sun group --------------------------------------------------------
  // Wraps sun mesh + corona + the three non-shadow lights. Updates
  // its world position each frame so the sun follows the ship.
  const sunGroup = new THREE.Group();
  sunGroup.add(sunMesh);
  sunGroup.add(coronaMesh);
  sunGroup.add(pointLight);
  sunGroup.add(hemisphereLight);
  sunGroup.add(ambientLight);
  sunGroup.frustumCulled = false;

  // ---- DirectionalLight (shadow caster) ---------------------------------
  // Stays OUTSIDE the sunGroup so its target can be independently
  // pinned to the ship's position each frame. The position-vs-target
  // vector is what determines the light's direction; both move
  // together so the parallel-ray direction stays constant.
  const directionalLight = new THREE.DirectionalLight(SUN_COLOR, DIRECTIONAL_INTENSITY);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  directionalLight.shadow.camera.near = SHADOW_NEAR;
  directionalLight.shadow.camera.far = SHADOW_FAR;
  directionalLight.shadow.camera.left = -SHADOW_FRUSTUM_HALF_SIZE;
  directionalLight.shadow.camera.right = SHADOW_FRUSTUM_HALF_SIZE;
  directionalLight.shadow.camera.top = SHADOW_FRUSTUM_HALF_SIZE;
  directionalLight.shadow.camera.bottom = -SHADOW_FRUSTUM_HALF_SIZE;
  // v0.69.3 — radius=1 matches PCFShadowMap (was 4 for PCFSoftShadowMap).
  // radius=0 would technically be "no PCF" (≈ BasicShadowMap) which gives
  // pixel-perfect hard edges but can flicker on noisy surfaces. radius=1
  // is the minimum-anti-aliased option — edges are sharp but not aliased.
  // bias + normalBias unchanged from v0.68.0: tuned for self-shadow acne
  // on flat-on-light surfaces; works for both PCF and PCFSoft shadow maps.
  directionalLight.shadow.bias = -0.0005; // tiny depth bias to avoid acne on flat surfaces
  directionalLight.shadow.normalBias = 0.02;
  directionalLight.shadow.radius = 1; // hard edges (PCFShadowMap, v0.69.3)
  // The DirectionalLight needs a `target` Object3D in the scene for
  // its direction to be computed correctly. We create one and add it
  // to the sunGroup (it moves with the sun, but our `update()` pins it
  // to the ship anyway — see below).
  const directionalTarget = new THREE.Object3D();
  sunGroup.add(directionalTarget);

  // ---- Per-frame update -------------------------------------------------
  // Moves the sun group + the directional light + its target so the
  // sun is always `SUN_DISTANCE` units from the ship in `SUN_DIRECTION`,
  // and the shadow frustum always covers the ship + nearby asteroids.
  const _scratchSunPos = new THREE.Vector3();
  function update(dt, shipPos) {
    // Defensive: a null/missing/NaN shipPos would corrupt the entire
    // lighting state for the frame. Skip the move (sun stays at last
    // valid frame's position) rather than poison the math.
    if (
      !shipPos ||
      typeof shipPos.x !== 'number' ||
      typeof shipPos.y !== 'number' ||
      typeof shipPos.z !== 'number' ||
      !Number.isFinite(shipPos.x) ||
      !Number.isFinite(shipPos.y) ||
      !Number.isFinite(shipPos.z)
    ) {
      return;
    }
    _scratchSunPos
      .set(shipPos.x, shipPos.y, shipPos.z)
      .addScaledVector(_sunOffset, SUN_DISTANCE);
    sunGroup.position.copy(_scratchSunPos);
    // The DirectionalLight itself needs its world position + target set
    // explicitly (it's NOT in the sunGroup so it doesn't auto-follow).
    directionalLight.position.copy(_scratchSunPos);
    directionalTarget.position.set(shipPos.x, shipPos.y, shipPos.z);
    directionalLight.target = directionalTarget;
  }

  // ---- Dispose ----------------------------------------------------------
  // Release geometries + materials. Lights themselves are cheap (no
  // GPU resources beyond the shadow map, which GC handles).
  function dispose() {
    sunMesh.geometry.dispose();
    sunMesh.material.dispose();
    coronaMesh.geometry.dispose();
    coronaMesh.material.dispose();
  }

  return {
    sunGroup,
    directionalLight,
    sunMesh,
    coronaMesh,
    pointLight,
    hemisphereLight,
    ambientLight,
    update,
    dispose,
  };
}
