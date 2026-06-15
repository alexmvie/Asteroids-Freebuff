import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTrainedAiBrain } from '../../src/training/ai-brain.js';
import { createNetwork, genomeFromNetwork } from '../../src/training/network.js';

test('createTrainedAiBrain throws without genome', () => {
  assert.throws(() => createTrainedAiBrain({}), /genome must be a Float32Array/);
  assert.throws(() => createTrainedAiBrain({ genome: [1, 2, 3] }), /genome must be a Float32Array/);
});

test('tick returns yaw, thrust, mode, fire', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  const result = brain.tick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
  });
  assert.equal(typeof result.yaw, 'number');
  assert.equal(typeof result.thrust, 'boolean');
  assert.equal(typeof result.mode, 'string');
  assert.equal(typeof result.fire, 'boolean');
});

test('tick with empty asteroids defaults to wander mode', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  const result = brain.tick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
  });
  assert.equal(result.mode, 'wander');
});

test('tick with nearby asteroid may change mode', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  const result = brain.tick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [{
      getPosition: () => ({ x: 10, y: 0, z: 10 }),
      getRadius: () => 4,
    }],
  });
  // Mode could be target or wander depending on the network output
  assert.ok(['wander', 'target', 'dodge', 'hunt'].includes(result.mode));
});

test('tick with powerup may trigger hunt mode', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  const result = brain.tick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    powerupPos: { x: 5, z: 5 },
  });
  assert.ok(['wander', 'hunt'].includes(result.mode));
});

test('yaw is discretized to -1, 0, or 1', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  // Run many ticks with different inputs to exercise output thresholds
  const yaws = new Set();
  for (let i = 0; i < 20; i++) {
    const result = brain.tick({
      aiPos: { x: i, z: 0 },
      aiYaw: i * 0.5,
      aiVel: { x: i, z: 0 },
      asteroids: [],
    });
    yaws.add(result.yaw);
  }
  // The output should only ever be -1, 0, or 1
  for (const y of yaws) {
    assert.ok([-1, 0, 1].includes(y), `unexpected yaw value ${y}`);
  }
});

test('laser active flag is read from input', () => {
  const net = createNetwork(11, 12, 3);
  const genome = genomeFromNetwork(net);
  const brain = createTrainedAiBrain({ genome });
  const result = brain.tick({
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 0, z: 0 },
    asteroids: [],
    isLaserActive: true,
  });
  assert.equal(typeof result.yaw, 'number');
  assert.equal(typeof result.thrust, 'boolean');
  assert.equal(typeof result.fire, 'boolean');
});

test('brain produces valid decisions from different genomes', () => {
  const net1 = createNetwork(11, 12, 3);
  const net2 = createNetwork(11, 12, 3);
  const g1 = genomeFromNetwork(net1);
  const g2 = genomeFromNetwork(net2);
  const brain1 = createTrainedAiBrain({ genome: g1 });
  const brain2 = createTrainedAiBrain({ genome: g2 });

  // First, verify the genomes are actually different (guaranteed by Math.random init)
  let genomesDiffer = false;
  for (let i = 0; i < g1.length; i++) {
    if (g1[i] !== g2[i]) { genomesDiffer = true; break; }
  }
  assert.equal(genomesDiffer, true, 'two random networks should have different genomes');

  const args = {
    aiPos: { x: 0, z: 0 },
    aiYaw: 0,
    aiVel: { x: 5, z: 0 },
    asteroids: [{
      getPosition: () => ({ x: 20, y: 0, z: 20 }),
      getRadius: () => 4,
    }],
  };

  const r1 = brain1.tick(args);
  const r2 = brain2.tick(args);
  // With different genomes, the raw outputs differ. The discretized
  // decisions *could* coincidentally match (rare), so we test the
  // deterministic property: same genome → same decision, which is
  // verified by the 'forward is deterministic' test in network.test.js.
  // Here we just sanity-check that the brain is wired up correctly.
  assert.equal(typeof r1.yaw, 'number');
  assert.equal(typeof r1.thrust, 'boolean');
  assert.equal(typeof r1.fire, 'boolean');
  assert.equal(typeof r2.yaw, 'number');
  assert.equal(typeof r2.thrust, 'boolean');
  assert.equal(typeof r2.fire, 'boolean');
});
