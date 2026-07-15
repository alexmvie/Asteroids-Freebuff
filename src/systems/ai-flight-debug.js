import {
  BufferGeometry,
  BufferAttribute,
  LineBasicMaterial,
  Line,
  Group,
  MeshBasicMaterial,
  Mesh,
  RingGeometry,
  Vector3,
  DoubleSide,
} from 'three';

/**
 * AI Flight Debug — 3D overlay that visualises what the AI is trying to
 * do, so bad maneuvers are obvious at a glance.
 *
 * Draws:
 *   - Green line: ship velocity vector (scaled)
 *   - Cyan line: desired heading / forward vector
 *   - Yellow cross: current chase target
 *   - Red ring: emergency evade radius
 *   - Magenta line: predicted intercept point for lead fire
 *
 * The overlay follows the AI ship and updates every frame. Call
 * `setEnabled(false)` to hide it without disposing geometry.
 *
 * @param {{ scene: import('three').Scene }} opts
 * @returns {{ mesh: import('three').Group, update: Function, setEnabled: Function, dispose: Function }}
 */
export function createAiFlightDebug({ scene }) {
  if (!scene) throw new Error('createAiFlightDebug: scene is required');

  const group = new Group();
  scene.add(group);

  // Velocity vector (green)
  const velGeom = new BufferGeometry();
  velGeom.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
  const velLine = new Line(velGeom, new LineBasicMaterial({ color: 0x00ff00, linewidth: 2 }));
  group.add(velLine);

  // Heading vector (cyan)
  const headGeom = new BufferGeometry();
  headGeom.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
  const headLine = new Line(headGeom, new LineBasicMaterial({ color: 0x48dbfb, linewidth: 2 }));
  group.add(headLine);

  // Target marker (yellow cross)
  const targetMarker = new Group();
  const targetMat = new LineBasicMaterial({ color: 0xffcc00 });
  const targetGeomX = new BufferGeometry().setFromPoints([
    new Vector3(-2, 0, 0), new Vector3(2, 0, 0),
  ]);
  const targetGeomZ = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, -2), new Vector3(0, 0, 2),
  ]);
  targetMarker.add(new Line(targetGeomX, targetMat));
  targetMarker.add(new Line(targetGeomZ, targetMat));
  group.add(targetMarker);

  // Predicted intercept marker (magenta cross)
  const predictMarker = new Group();
  const predictMat = new LineBasicMaterial({ color: 0xff00ff });
  const predictGeomX = new BufferGeometry().setFromPoints([
    new Vector3(-1.5, 0, 0), new Vector3(1.5, 0, 0),
  ]);
  const predictGeomZ = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, -1.5), new Vector3(0, 0, 1.5),
  ]);
  predictMarker.add(new Line(predictGeomX, predictMat));
  predictMarker.add(new Line(predictGeomZ, predictMat));
  group.add(predictMarker);

  // Evade radius ring (red, horizontal circle)
  const evadeRingGeom = new RingGeometry(0.95, 1.05, 64);
  evadeRingGeom.rotateX(-Math.PI / 2);
  const evadeRing = new Mesh(
    evadeRingGeom,
    new MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.3, side: DoubleSide }),
  );
  group.add(evadeRing);

  let enabled = true;

  function isEnabled() {
    return enabled;
  }

  function setEnabled(v) {
    enabled = !!v;
    group.visible = enabled;
  }

  /**
   * Update the debug visualization.
   * @param {Object} deps
   * @param {{x:number,y:number,z:number}} deps.shipPos
   * @param {{x:number,z:number}} deps.shipVel
   * @param {number} deps.shipYaw
   * @param {{x:number,z:number}|null} deps.targetPos
   * @param {{x:number,z:number}|null} deps.predictedPos
   * @param {number} deps.evadeDist
   */
  function update({
    shipPos,
    shipVel,
    shipYaw,
    targetPos,
    predictedPos,
    evadeDist,
  }) {
    if (!enabled) return;

    group.position.set(shipPos.x, shipPos.y, shipPos.z);

    // Velocity vector (green)
    const velScale = 0.5;
    const v0 = velLine.geometry.attributes.position.array;
    v0[0] = 0; v0[1] = 0; v0[2] = 0;
    v0[3] = shipVel.x * velScale;
    v0[4] = 0;
    v0[5] = shipVel.z * velScale;
    velLine.geometry.attributes.position.needsUpdate = true;

    // Heading vector (cyan)
    const headLen = 10;
    const h0 = headLine.geometry.attributes.position.array;
    h0[0] = 0; h0[1] = 0; h0[2] = 0;
    h0[3] = -Math.sin(shipYaw) * headLen;
    h0[4] = 0;
    h0[5] = -Math.cos(shipYaw) * headLen;
    headLine.geometry.attributes.position.needsUpdate = true;

    // Target marker
    if (targetPos && typeof targetPos.x === 'number') {
      targetMarker.visible = true;
      targetMarker.position.set(targetPos.x - shipPos.x, 0, targetPos.z - shipPos.z);
    } else {
      targetMarker.visible = false;
    }

    // Predicted intercept marker
    if (predictedPos && typeof predictedPos.x === 'number') {
      predictMarker.visible = true;
      predictMarker.position.set(predictedPos.x - shipPos.x, 0, predictedPos.z - shipPos.z);
    } else {
      predictMarker.visible = false;
    }

    // Evade ring
    evadeRing.scale.setScalar(evadeDist);
  }

  function dispose() {
    scene.remove(group);
    velGeom.dispose();
    headGeom.dispose();
    targetGeomX.dispose();
    targetGeomZ.dispose();
    predictGeomX.dispose();
    predictGeomZ.dispose();
    evadeRingGeom.dispose();
    velLine.material.dispose();
    headLine.material.dispose();
    targetMat.dispose();
    predictMat.dispose();
    evadeRing.material.dispose();
  }

  return { mesh: group, update, setEnabled, isEnabled, dispose };
}
