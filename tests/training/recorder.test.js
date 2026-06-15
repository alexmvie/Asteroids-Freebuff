/**
 * Tests for the episode recorder module.
 *
 * Pure-module tests — no Three.js, no environment coupling.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEpisodeRecorder,
  makeFrame,
  MODE_NAMES,
} from '../../src/training/recorder.js';

test('createEpisodeRecorder starts empty', () => {
  const rec = createEpisodeRecorder();
  assert.equal(rec.frameCount(), 0);
  assert.equal(rec.frames.length, 0);
});

test('record() pushes a frame', () => {
  const rec = createEpisodeRecorder();
  rec.record({
    t: 0.0,
    s: { x: 0, z: 0, vx: 0, vz: 0, yaw: 0, roll: 0 },
    a: new Float32Array(0),
    b: new Float32Array(0),
    p: null,
    L: 0,
    F: 0,
    y: 0,
    T: 0,
    f: 0,
    m: 0,
    S: 0,
  });
  assert.equal(rec.frameCount(), 1);
});

test('clear() resets the recorder', () => {
  const rec = createEpisodeRecorder();
  rec.record({ t: 0, s: {}, a: new Float32Array(0), b: new Float32Array(0), p: null, L: 0, F: 0, y: 0, T: 0, f: 0, m: 0, S: 0 });
  rec.clear();
  assert.equal(rec.frameCount(), 0);
});

test('toJSON() converts Float32Arrays to plain arrays', () => {
  const rec = createEpisodeRecorder();
  rec.record({
    t: 0.5,
    s: { x: 1, z: 2, vx: 3, vz: 4, yaw: 0.1, roll: 0.2 },
    a: new Float32Array([10, 20, 5, 0, 30, 40, 3, 1]),
    b: new Float32Array([50, 60]),
    p: { x: 70, z: 80 },
    L: 1,
    F: 0,
    y: -1,
    T: 1,
    f: 0,
    m: 1,
    S: 250,
  });
  const json = rec.toJSON();
  assert.equal(json.version, 1);
  assert.equal(json.frameCount, 1);
  assert.equal(json.durationS, 0.5);
  assert.ok(Array.isArray(json.frames));
  assert.ok(Array.isArray(json.frames[0].a));
  assert.ok(Array.isArray(json.frames[0].b));
  assert.equal(json.frames[0].a.length, 8);
  assert.equal(json.frames[0].b.length, 2);
  // Verify values
  assert.deepEqual(json.frames[0].a, [10, 20, 5, 0, 30, 40, 3, 1]);
  assert.deepEqual(json.frames[0].b, [50, 60]);
  assert.equal(json.frames[0].m, 1);
  assert.equal(json.frames[0].y, -1);
});

test('toJSON() durationS is the last frame time', () => {
  const rec = createEpisodeRecorder();
  for (const t of [0, 0.5, 1.0, 1.5]) {
    rec.record({
      t, s: {}, a: new Float32Array(0), b: new Float32Array(0),
      p: null, L: 0, F: 0, y: 0, T: 0, f: 0, m: 0, S: 0,
    });
  }
  assert.equal(rec.toJSON().durationS, 1.5);
});

test('toJSON() with zero frames has durationS 0', () => {
  const rec = createEpisodeRecorder();
  assert.equal(rec.toJSON().durationS, 0);
});

test('makeFrame packs asteroids as [x,z,r,size]×N', () => {
  const frame = makeFrame({
    time: 1.0,
    shipPos: { x: 0, y: 0, z: 0 },
    shipVel: { x: 0, y: 0, z: 0 },
    shipRot: { yaw: 0, pitch: 0, roll: 0 },
    asteroids: [
      { position: { x: 10, y: 0, z: 20 }, radius: 5, size: 0 },
      { position: { x: -3, y: 0, z: 7 }, radius: 2, size: 2 },
    ],
    bullets: [],
    powerup: null,
    laserActive: false,
    laserFiring: false,
    brainOut: { yaw: 0, thrust: false, fire: false, mode: 'wander' },
    score: 0,
  });
  assert.equal(frame.a.length, 8);
  assert.equal(frame.a[0], 10);
  assert.equal(frame.a[1], 20);
  assert.equal(frame.a[2], 5);
  assert.equal(frame.a[3], 0);
  assert.equal(frame.a[4], -3);
  assert.equal(frame.a[5], 7);
  assert.equal(frame.a[6], 2);
  assert.equal(frame.a[7], 2);
});

test('makeFrame packs bullets as [x,z]×N', () => {
  const frame = makeFrame({
    time: 0,
    shipPos: { x: 0, y: 0, z: 0 },
    shipVel: { x: 0, y: 0, z: 0 },
    shipRot: { yaw: 0, pitch: 0, roll: 0 },
    asteroids: [],
    bullets: [
      { position: { x: 1, y: 0, z: 2 } },
      { position: { x: 3, y: 0, z: 4 } },
    ],
    powerup: null,
    laserActive: false,
    laserFiring: false,
    brainOut: { yaw: 0, thrust: false, fire: false, mode: 'wander' },
    score: 0,
  });
  assert.equal(frame.b.length, 4);
  assert.equal(frame.b[0], 1);
  assert.equal(frame.b[1], 2);
  assert.equal(frame.b[2], 3);
  assert.equal(frame.b[3], 4);
});

test('makeFrame encodes the power-up when present', () => {
  const frame = makeFrame({
    time: 0, shipPos: { x: 0, y: 0, z: 0 }, shipVel: { x: 0, y: 0, z: 0 },
    shipRot: { yaw: 0, pitch: 0, roll: 0 },
    asteroids: [], bullets: [],
    powerup: { position: { x: 50, y: 0, z: 60 } },
    laserActive: false, laserFiring: false,
    brainOut: { yaw: 0, thrust: false, fire: false, mode: 'hunt' },
    score: 0,
  });
  assert.deepEqual(frame.p, { x: 50, z: 60 });
  assert.equal(frame.m, 3); // HUNT
});

test('makeFrame maps mode names to ints', () => {
  const mkFrame = (mode) => makeFrame({
    time: 0, shipPos: { x: 0, y: 0, z: 0 }, shipVel: { x: 0, y: 0, z: 0 },
    shipRot: { yaw: 0, pitch: 0, roll: 0 },
    asteroids: [], bullets: [], powerup: null,
    laserActive: false, laserFiring: false,
    brainOut: { yaw: 0, thrust: false, fire: false, mode },
    score: 0,
  });
  assert.equal(mkFrame('wander').m, 0);
  assert.equal(mkFrame('dodge').m, 1);
  assert.equal(mkFrame('target').m, 2);
  assert.equal(mkFrame('hunt').m, 3);
  assert.equal(mkFrame('unknown').m, 0); // falls back to WANDER
});

test('makeFrame encodes brain outputs and laser flags as 0/1', () => {
  const frame = makeFrame({
    time: 0, shipPos: { x: 0, y: 0, z: 0 }, shipVel: { x: 0, y: 0, z: 0 },
    shipRot: { yaw: 0, pitch: 0, roll: 0 },
    asteroids: [], bullets: [], powerup: null,
    laserActive: true, laserFiring: true,
    brainOut: { yaw: -1, thrust: true, fire: true, mode: 'dodge' },
    score: 100,
  });
  assert.equal(frame.L, 1);
  assert.equal(frame.F, 1);
  assert.equal(frame.y, -1);
  assert.equal(frame.T, 1);
  assert.equal(frame.f, 1);
  assert.equal(frame.S, 100);
});

test('MODE_NAMES is a 4-element array of mode strings', () => {
  assert.equal(MODE_NAMES.length, 4);
  assert.deepEqual(MODE_NAMES, ['wander', 'dodge', 'target', 'hunt']);
});
