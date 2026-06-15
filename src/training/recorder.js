/**
 * Episode recorder — captures per-frame state during a training episode
 * for later playback in the champion viewer.
 *
 * The recorder collects lightweight frame data (ship pose, asteroid positions,
 * bullets, power-up, brain actions) into a compact array. A 60s episode at
 * 60fps is ~3600 frames × ~200 bytes ≈ ~700KB serialized — small enough to
 * serve over HTTP and decode in the browser.
 *
 * Public API:
 *   - `createEpisodeRecorder()` → recorder
 *   - `recorder.record(state)` — push one frame
 *   - `recorder.frames` → read-only array of recorded frames
 *   - `recorder.toJSON()` → compact JSON-ready structure
 *   - `recorder.clear()` → reset
 *   - `makeFrame(args)` → build one frame from positional data
 *
 * Frame schema (also exported as FRAME_FIELDS for the browser decoder):
 *   {
 *     t: number,           // seconds since reset
 *     s: { x, z, vx, vz, yaw, roll },  // ship
 *     a: Float32Array,     // asteroid positions+sizes (packed: [x,z,r,size, x,z,r,size, ...])
 *     b: Float32Array,     // bullet positions (packed: [x,z, x,z, ...])
 *     p: { x, z } | null,  // powerup position
 *     L: 0 | 1,            // laser active
 *     F: 0 | 1,            // laser firing this frame
 *     y: -1 | 0 | 1,       // brain yaw output
 *     T: 0 | 1,            // brain thrust output
 *     f: 0 | 1,            // brain fire output
 *     m: 0..3,             // brain mode (see MODE_NAMES)
 *     S: number,           // score at this frame
 *   }
 */

const MODE_WANDER = 0;
const MODE_DODGE = 1;
const MODE_TARGET = 2;
const MODE_HUNT = 3;

/** Reverse map for the browser viewer: mode int → string. */
export const MODE_NAMES = Object.freeze(['wander', 'dodge', 'target', 'hunt']);

/**
 * @typedef {Object} RecordedFrame
 * @property {number} t — seconds since reset
 * @property {{x:number,z:number,vx:number,vz:number,yaw:number,roll:number}} s — ship
 * @property {Float32Array} a — asteroid positions+sizes (packed [x,z,r,size]×N)
 * @property {Float32Array} b — bullet positions (packed [x,z]×N)
 * @property {{x:number,z:number}|null} p — powerup position
 * @property {0|1} L — laser active
 * @property {0|1} F — laser firing
 * @property {-1|0|1} y — brain yaw
 * @property {0|1} T — brain thrust
 * @property {0|1} f — brain fire
 * @property {number} m — brain mode
 * @property {number} S — score
 */

/**
 * @returns {{
 *   record: (frame: Omit<RecordedFrame, never>) => void,
 *   frames: RecordedFrame[],
 *   toJSON: () => object,
 *   clear: () => void,
 *   frameCount: () => number,
 * }}
 */
export function createEpisodeRecorder() {
  /** @type {RecordedFrame[]} */
  const frames = [];

  function record(frame) {
    frames.push(frame);
  }

  function clear() {
    frames.length = 0;
  }

  function frameCount() {
    return frames.length;
  }

  /**
   * Serialize to a JSON-friendly structure. Float32Arrays are converted to
   * plain number arrays (JSON.stringify doesn't support typed arrays).
   * @returns {{
   *   version: 1,
   *   frameCount: number,
   *   durationS: number,
   *   frames: Array<{
   *     t: number, s: object,
   *     a: number[], b: number[],
   *     p: object|null, L: number, F: number,
   *     y: number, T: number, f: number, m: number, S: number,
   *   }>
   * }}
   */
  function toJSON() {
    const serialized = frames.map((f) => ({
      t: f.t,
      s: f.s,
      a: Array.from(f.a),
      b: Array.from(f.b),
      p: f.p,
      L: f.L,
      F: f.F,
      y: f.y,
      T: f.T,
      f: f.f,
      m: f.m,
      S: f.S,
    }));
    return {
      version: 1,
      frameCount: frames.length,
      durationS: frames.length > 0 ? frames[frames.length - 1].t : 0,
      frames: serialized,
    };
  }

  return {
    record,
    frames,
    toJSON,
    clear,
    frameCount,
  };
}

/**
 * Reconstruct a recorder-friendly frame from environment + brain outputs.
 * Pure helper — easy to test in isolation.
 *
 * @param {object} args
 * @param {number} args.time — current episode time (seconds)
 * @param {{x:number,y:number,z:number}} args.shipPos
 * @param {{x:number,y:number,z:number}} args.shipVel
 * @param {{yaw:number,pitch:number,roll:number}} args.shipRot
 * @param {Array<{position:{x:number,y:number,z:number}, radius:number, size:number}>} args.asteroids
 * @param {Array<{position:{x:number,y:number,z:number}}>} args.bullets
 * @param {{position:{x:number,y:number,z:number}}|null} args.powerup
 * @param {boolean} args.laserActive
 * @param {boolean} args.laserFiring
 * @param {{yaw:-1|0|1, thrust:boolean, fire:boolean, mode:string}} args.brainOut
 * @param {number} args.score
 * @returns {RecordedFrame}
 */
export function makeFrame(args) {
  // Pack asteroids: [x, z, radius, size] per asteroid
  const a = new Float32Array(args.asteroids.length * 4);
  for (let i = 0; i < args.asteroids.length; i++) {
    const ast = args.asteroids[i];
    a[i * 4 + 0] = ast.position.x;
    a[i * 4 + 1] = ast.position.z;
    a[i * 4 + 2] = ast.radius;
    a[i * 4 + 3] = ast.size;
  }

  // Pack bullets: [x, z] per bullet
  const b = new Float32Array(args.bullets.length * 2);
  for (let i = 0; i < args.bullets.length; i++) {
    b[i * 2 + 0] = args.bullets[i].position.x;
    b[i * 2 + 1] = args.bullets[i].position.z;
  }

  // Powerup
  const p = args.powerup
    ? { x: args.powerup.position.x, z: args.powerup.position.z }
    : null;

  // Mode → int
  let m = MODE_WANDER;
  if (args.brainOut.mode === 'dodge') m = MODE_DODGE;
  else if (args.brainOut.mode === 'target') m = MODE_TARGET;
  else if (args.brainOut.mode === 'hunt') m = MODE_HUNT;

  return {
    t: args.time,
    s: {
      x: args.shipPos.x,
      z: args.shipPos.z,
      vx: args.shipVel.x,
      vz: args.shipVel.z,
      yaw: args.shipRot.yaw,
      roll: args.shipRot.roll,
    },
    a,
    b,
    p,
    L: args.laserActive ? 1 : 0,
    F: args.laserFiring ? 1 : 0,
    y: args.brainOut.yaw,
    T: args.brainOut.thrust ? 1 : 0,
    f: args.brainOut.fire ? 1 : 0,
    m,
    S: args.score,
  };
}
