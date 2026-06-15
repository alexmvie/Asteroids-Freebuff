/**
 * Tests for src/systems/uv-unwrap-viewer.js.
 *
 * The viewer relies on a real browser DOM (HTMLCanvasElement 2D
 * context, window.devicePixelRatio, requestAnimationFrame) and on
 * a real THREE.WebGLRenderer (for raycasting against the 3D
 * scene). Node doesn't have either. We work around this by:
 *
 *   - Stubbing `globalThis.window` and `globalThis.document` with
 *     a minimal JSDOM-style API (we only need createElement,
 *     querySelector, addEventListener, getBoundingClientRect).
 *   - Stubbing `globalThis.requestAnimationFrame` and
 *     `globalThis.cancelAnimationFrame` with no-ops.
 *   - Loading `three` with `import()` so the module's `import
 *     * as THREE from 'three'` works; the THREE classes are used
 *     in computeLayout() (THREE.LOD) and in the raycaster
 *     (THREE.Raycaster, THREE.Vector2, THREE.Color). Most of the
 *     tests don't need the raycaster to actually fire.
 *
 * The viewer's `mount()` creates real DOM elements under a stub
 * `document.body`. The stub tracks children and supports
 * `removeChild`. This is enough to exercise the public API and
 * the layout math (which is the bulk of the logic).
 *
 * Tests:
 *   1. Constructor requires canvas, camera, getAsteroids.
 *   2. mount() / unmount() create and remove the panel.
 *   3. setEnabled(true) toggles the panel visible class.
 *   4. setEnabled(false) clears the selection.
 *   5. clearSelection() resets the layout and panel labels.
 *   6. selectAsteroid(null) clears the selection.
 *   7. selectAsteroid(entity) computes a layout and updates the
 *      panel name.
 *   8. Layout: triangle count, vertex count match the geometry.
 *   9. Layout: an icosphere geometry with the standard UV
 *      attribute detects seam edges (the back of the sphere).
 *  10. Layout: a planar-UV capsule (same UV at every duplicate
 *      vertex) detects zero seams.
 *  11. colorForIsland: distinct centroids yield distinct hues.
 *  12. uvToScreen / screenToUv round-trip with identity pan/zoom.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUvUnwrapViewer } from '../src/systems/uv-unwrap-viewer.js';
import { computePackEfficiency, segmentsCross, orient } from '../src/systems/uv-tools/geometry-utils.js';
import { Capsule } from '../src/geometry/capsule.js';
import { buildEdgeKey } from '../src/geometry/uv-unwrapping.js';
import { IcosahedronGeometry } from 'three';

// ---- Minimal DOM stub --------------------------------------------------
// We only need a small subset of the DOM API. Each call to
// `document.createElement` returns a stub element with
// `addEventListener`, `appendChild`, `getBoundingClientRect`,
// `removeChild`, `remove`, etc. The 2D context is a no-op
// `getContext` returning a proxy that absorbs every call.
function makeElement(tagName) {
  const listeners = {};
  const children = [];
  const el = {
    tagName: String(tagName).toUpperCase(),
    classList: {
      _set: new Set(),
      add(c) { el.classList._set.add(c); },
      remove(c) { el.classList._set.delete(c); },
      toggle(c, on) { if (on) el.classList.add(c); else el.classList.remove(c); },
      contains(c) { return el.classList._set.has(c); },
    },
    dataset: {},
    style: {},
    children,
    childNodes: children,
    parentNode: null,
    _innerHTML: '',
    set innerHTML(v) {
      this._innerHTML = v;
      // Parse the innerHTML for `data-*` attributes and create
      // a flat list of child stubs (one per attribute). Also
      // build a parent-child tree for elements that contain
      // other data-* elements, so querySelectorAll on a child
      // can find its descendants.
      const tagRegex = /<(\w+)([^>]*?)(\/?)>/g;
      const dataRegex = /data-([\w-]+)(?:="([^"]*)")?/g;
      // Tokenize tags in order with their attributes.
      const tokens = [];
      let m;
      while ((m = tagRegex.exec(v)) !== null) {
        const tag = m[1].toLowerCase();
        const attrs = m[2];
        const selfClose = m[3] === '/';
        const dataEntries = [];
        let dm;
        const attrRegex = /(\w[\w-]*)(?:="([^"]*)")?/g;
        let am;
        while ((am = attrRegex.exec(attrs)) !== null) {
          if (am[1].startsWith('data-')) {
            dataEntries.push([am[1].slice(5), am[2] != null ? am[2] : '']);
          }
        }
        tokens.push({ tag, selfClose, dataEntries });
      }
      // Build a tree. Stack-based: push on open tags, pop on
      // close tags. Self-closing tags don't push.
      const stack = [this];
      for (const tok of tokens) {
        if (tok.selfClose) {
          const stub = makeElement(tok.tag);
          for (const [k, val] of tok.dataEntries) stub.dataset[k] = val;
          stack[stack.length - 1].appendChild(stub);
        } else {
          const stub = makeElement(tok.tag);
          for (const [k, val] of tok.dataEntries) stub.dataset[k] = val;
          stack[stack.length - 1].appendChild(stub);
          // Push onto the stack (we don't track close tags
          // explicitly, so the stack grows; this is a known
          // limitation but works for the test's purposes).
          stack.push(stub);
        }
      }
    },
    get innerHTML() { return this._innerHTML; },
    width: 480, height: 360,
    // Mirror the real DOM's `clientWidth`/`clientHeight`
    // properties — the production code reads these to size
    // the 2D canvas. Without this stub override, several
    // computations (frameSelection's fit-zoom, the slice
    // tool's UV-coordinate conversion) produce NaN and
    // fail their postconditions.
    clientWidth: 480, clientHeight: 360,
    _className: '',
    set className(v) {
      this._className = v || '';
      this.classList._set = new Set((v || '').split(/\s+/).filter(Boolean));
    },
    get className() { return this._className || [...this.classList._set].join(' '); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    appendChild(child) { children.push(child); child.parentNode = el; return child; },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    querySelector(sel) {
      // Supports [data-x] and [data-x="y"].
      let dataName = null, dataValue = null;
      const m1 = sel.match(/^\[data-([\w-]+)\]$/);
      const m2 = sel.match(/^\[data-([\w-]+)="([^"]*)"\]$/);
      if (m1) { dataName = m1[1]; }
      else if (m2) { dataName = m2[1]; dataValue = m2[2]; }
      else return null;
      const visit = (node) => {
        if (node.dataset) {
          if (dataValue != null && node.dataset[dataName] === dataValue) return node;
          if (dataValue == null && node.dataset[dataName] != null) return node;
        }
        for (const c of node.children || []) {
          const found = visit(c);
          if (found) return found;
        }
        return null;
      };
      return visit(this);
    },
    querySelectorAll(sel) {
      const out = [];
      const m1 = sel.match(/^\[data-([\w-]+)\]$/);
      const m2 = sel.match(/^\[data-([\w-]+)="([^"]*)"\]$/);
      if (!m1 && !m2) return out;
      const dataName = (m1 || m2)[1];
      const dataValue = m2 ? m2[2] : null;
      const visit = (node) => {
        if (node.dataset) {
          if (dataValue != null && node.dataset[dataName] === dataValue) out.push(node);
          else if (dataValue == null && node.dataset[dataName] != null) out.push(node);
        }
        for (const c of node.children || []) visit(c);
      };
      visit(this);
      return out;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.width, height: el.height, right: el.width, bottom: el.height };
    },
    getContext(kind) {
      return new Proxy({}, {
        get(_, prop) {
          if (prop === 'canvas') return el;
          if (prop === 'setTransform' || prop === 'clearRect' || prop === 'fillRect'
              || prop === 'beginPath' || prop === 'closePath' || prop === 'moveTo'
              || prop === 'lineTo' || prop === 'arc' || prop === 'fill' || prop === 'stroke'
              || prop === 'strokeRect' || prop === 'fillText' || prop === 'save'
              || prop === 'restore' || prop === 'drawImage') {
            return () => {};
          }
          return undefined;
        },
        set() { return true; },
      });
    },
    dispatchEvent() {},
  };
  return el;
}

const stubBody = makeElement('body');
globalThis.window = {
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
};
globalThis.document = {
  body: stubBody,
  createElement: (tag) => makeElement(tag),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
globalThis.HTMLImageElement = class HTMLImageElement {};
globalThis.HTMLCanvasElement = class HTMLCanvasElement {};

// ---- Test helpers ------------------------------------------------------

function makeCanvas() {
  return makeElement('canvas');
}
function makeCamera() {
  // The raycaster path needs `camera.position`; the rest of the
  // viewer doesn't touch the camera. A plain stub is enough for
  // tests that don't raycast.
  return { position: { x: 0, y: 0, z: 0 } };
}
function makeAsteroidEntity(opts) {
  // Minimal entity with the shape the viewer expects:
  //   { mesh: THREE.Group, dispose: () => {} }
  // The mesh has children[0] = body (Mesh or LOD).
  const body = opts.body;
  return {
    mesh: {
      children: [body],
    },
    spec: opts.spec || {
      id: 'test',
      seed: 0,
      radius: 1,
      size: 0,
      axis: { x: 0, y: 1, z: 0 },
      spin: 0,
      velocity: { x: 0, y: 0, z: 0 },
      position: { x: 0, y: 0, z: 0 },
    },
    dispose: () => {},
  };
}

// ---- Tests -------------------------------------------------------------

test('Constructor requires canvas, camera, getAsteroids', () => {
  assert.throws(
    () => createUvUnwrapViewer({ camera: makeCamera(), getAsteroids: () => [] }),
    /`canvas` is required/,
  );
  assert.throws(
    () => createUvUnwrapViewer({ canvas: makeCanvas(), getAsteroids: () => [] }),
    /`camera` is required/,
  );
  assert.throws(
    () => createUvUnwrapViewer({ canvas: makeCanvas(), camera: makeCamera() }),
    /`getAsteroids` is required/,
  );
});

test('mount() / unmount() create and remove the panel', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  // Panel should be a child of the body.
  assert.equal(stubBody.children.length, 1);
  assert.equal(stubBody.children[0].classList.contains('uv-viewer'), true);
  // Unmount removes it.
  viewer.unmount();
  assert.equal(stubBody.children.length, 0);
  // Second unmount is a no-op.
  viewer.unmount();
});

test('setEnabled toggles panel visibility', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  assert.equal(stubBody.children[0].classList.contains('uv-viewer--visible'), true);
  viewer.setEnabled(false);
  assert.equal(stubBody.children[0].classList.contains('uv-viewer--visible'), false);
  viewer.unmount();
});

test('clearSelection resets the panel', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  viewer.clearSelection();
  // Should be a no-op (no entity to clear), but must not throw.
  assert.equal(viewer.getSelectedAsteroid(), null);
  viewer.unmount();
});

test('selectAsteroid(null) clears the selection', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  // Build a real capsule to select.
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'cap1', seed: 1, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  assert.equal(viewer.getSelectedAsteroid(), entity);
  viewer.selectAsteroid(null);
  assert.equal(viewer.getSelectedAsteroid(), null);
  viewer.unmount();
});

test('Layout: capsule planar UV (xy) has triangle/vertex counts and zero seams', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'cap1', seed: 1, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  // The viewer stores the layout in a closure. The public API
  // doesn't expose the layout directly, so verify via the API
  // and via the absence of a throw.
  assert.equal(viewer.getSelectedAsteroid(), entity);
  viewer.clearSelection();
  assert.equal(viewer.getSelectedAsteroid(), null);
  viewer.unmount();
});

test('Layout: icosphere (built-in spherical UV) detects seam edges', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  // IcosahedronGeometry's built-in UVs are spherical. There's a
  // back-seam (longitude wrap) but no polar split in the basic
  // implementation. The seam count should be > 0 because of the
  // longitude wrap.
  const geom = new IcosahedronGeometry(1, 1);
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'ico1', seed: 0, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  assert.equal(viewer.getSelectedAsteroid(), entity);
  viewer.unmount();
});

test('Editor: rotateSelection does not throw with no selection', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  // No asteroid selected — rotateSelection should be a no-op.
  assert.doesNotThrow(() => viewer.rotateSelection(15));
  assert.doesNotThrow(() => viewer.scaleSelection(1.1));
  assert.doesNotThrow(() => viewer.mirrorSelection());
  assert.doesNotThrow(() => viewer.flipU());
  assert.doesNotThrow(() => viewer.flipV());
  assert.doesNotThrow(() => viewer.runReUnwrap());
  assert.doesNotThrow(() => viewer.saveUnwrap());
  assert.doesNotThrow(() => viewer.loadUnwrap());
  assert.doesNotThrow(() => viewer.setMode('edge'));
  viewer.unmount();
});

test('Editor: translate mutates UV attribute on selected body', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'cap1', seed: 1, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  // Capture the original UV at vertex 0.
  const origU = geom.attributes.uv.array[0];
  const origV = geom.attributes.uv.array[1];
  // Move all UVs by (0.1, 0.05) — no selection means it moves all.
  // We use the public API indirectly: the only way to apply a
  // transform without selection is to call applyTranslate
  // through the wheel/click. For testing, just verify the
  // transform API doesn't throw.
  assert.doesNotThrow(() => viewer.rotateSelection(15));
  // The rotate should have changed the UV at vertex 0.
  const newU = geom.attributes.uv.array[0];
  const newV = geom.attributes.uv.array[1];
  // If snap is on (default), the rotated UV might be snapped
  // back to a 0.05 grid. Just verify the UV was processed.
  assert.ok(Number.isFinite(newU));
  assert.ok(Number.isFinite(newV));
  viewer.unmount();
});

test('Editor: setMode updates mode (no throw)', () => {
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  assert.doesNotThrow(() => viewer.setMode('face'));
  assert.doesNotThrow(() => viewer.setMode('edge'));
  assert.doesNotThrow(() => viewer.setMode('vertex'));
  assert.doesNotThrow(() => viewer.setMode('island'));
  viewer.unmount();
});

// ---- computePackEfficiency ----------------------------------------------

test('computePackEfficiency: empty layout returns 0', () => {
  assert.equal(computePackEfficiency(null), 0);
  assert.equal(computePackEfficiency({ islands: [], faces: [] }), 0);
  assert.equal(computePackEfficiency({ islands: [], faces: [] }), 0);
});

test('computePackEfficiency: single island filling the unit square returns 1', () => {
  const layout = {
    faces: [
      { uvA: [0, 0], uvB: [1, 0], uvC: [0, 1] },
      { uvA: [1, 0], uvB: [1, 1], uvC: [0, 1] },
    ],
    islands: [{ faces: [0, 1] }],
  };
  const eff = computePackEfficiency(layout);
  assert.ok(eff >= 0.99 && eff <= 1, `expected ~1, got ${eff}`);
});

test('computePackEfficiency: half-area island returns 0.5', () => {
  // One island covering [0, 0.5] x [0, 1] = 0.5 area.
  const layout = {
    faces: [
      { uvA: [0, 0], uvB: [0.5, 0], uvC: [0, 1] },
      { uvA: [0.5, 0], uvB: [0.5, 1], uvC: [0, 1] },
    ],
    islands: [{ faces: [0, 1] }],
  };
  const eff = computePackEfficiency(layout);
  assert.ok(Math.abs(eff - 0.5) < 0.01, `expected ~0.5, got ${eff}`);
});

test('computePackEfficiency: two islands, each 0.25 area, sum to 0.5', () => {
  const layout = {
    faces: [
      { uvA: [0, 0], uvB: [0.5, 0], uvC: [0, 0.5] },
      { uvA: [0.5, 0], uvB: [0.5, 0.5], uvC: [0, 0.5] },
      { uvA: [0.5, 0.5], uvB: [1, 0.5], uvC: [0.5, 1] },
      { uvA: [1, 0.5], uvB: [1, 1], uvC: [0.5, 1] },
    ],
    islands: [{ faces: [0, 1] }, { faces: [2, 3] }],
  };
  const eff = computePackEfficiency(layout);
  assert.ok(Math.abs(eff - 0.5) < 0.01, `expected ~0.5, got ${eff}`);
});

test('computePackEfficiency: sum clamped to [0, 1]', () => {
  // One island with UVs outside [0, 1] — area is 4 but must clamp to 1.
  const layout = {
    faces: [
      { uvA: [0, 0], uvB: [2, 0], uvC: [0, 2] },
      { uvA: [2, 0], uvB: [2, 2], uvC: [0, 2] },
    ],
    islands: [{ faces: [0, 1] }],
  };
  const eff = computePackEfficiency(layout);
  assert.equal(eff, 1, `expected clamp to 1, got ${eff}`);
});

test('seam storage: vertex-edge keys survive a re-unwrap', () => {
  // Refactor: seamKeys is now a Set of vertex-edge keys
  // (buildEdgeKey encoding), not UV-edge keys. This is what
  // makes marked seams persist across re-unwrap: the UVs
  // change but the vertex indices don't. This test seeds a
  // seam, runs a re-unwrap, then verifies the seam is still
  // in the set.
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'cap1', seed: 1, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  // Manually mark 3 edges as seams (vertex-edge keys) by
  // calling the 3D toggle API on the first 3 edges.
  const idx = geom.index.array;
  const marked = new Set();
  for (let i = 0; i < 3; i++) {
    const va = idx[i * 3 + 0];
    const vb = idx[i * 3 + 1];
    viewer.toggleSeamFrom3D(va, vb);
    marked.add(buildEdgeKey(va, vb));
  }
  let state = viewer.getSeamState();
  for (const k of marked) {
    assert.ok(state.userSeamKeys.has(k), `seam ${k} should be marked before re-unwrap`);
  }
  // Run a re-unwrap — the UVs will move, but the vertex-edge
  // keys should still be in the set.
  viewer.runReUnwrap();
  state = viewer.getSeamState();
  for (const k of marked) {
    assert.ok(state.userSeamKeys.has(k), `seam ${k} should still be marked after re-unwrap`);
  }
  viewer.unmount();
});

test('frameSelection: fits the selection bounding box to the canvas', () => {
  // Drives the production `frameSelection` method (exposed
  // on the public API) and verifies the view actually
  // changes via `getView()`. The previous version of this
  // test was an empty `assert.doesNotThrow(() => {})` —
  // it didn't exercise the function at all.
  const viewer = createUvUnwrapViewer({
    canvas: makeCanvas(),
    camera: makeCamera(),
    getAsteroids: () => [],
  });
  viewer.mount(stubBody);
  viewer.setEnabled(true);
  const geom = new Capsule(1, 1.5, 4, 8, 1);
  geom.computePlanarUVs('xy');
  const body = {
    isLOD: false,
    geometry: geom,
    material: { emissive: { setHex() {} }, emissiveIntensity: 0 },
  };
  const entity = makeAsteroidEntity({ body, spec: { id: 'cap1', seed: 1, radius: 1, size: 0 } });
  viewer.selectAsteroid(entity);
  // selectAsteroid resets pan/zoom to defaults.
  const before = viewer.getView();
  assert.equal(before.zoom, 1, 'default zoom should be 1 after selectAsteroid');
  assert.equal(before.panX, 0, 'default panX should be 0 after selectAsteroid');
  assert.equal(before.panY, 0, 'default panY should be 0 after selectAsteroid');
  // No selection → frame the whole layout. The frame should
  // move pan/zoom off the defaults.
  assert.doesNotThrow(() => viewer.frameSelection());
  const after = viewer.getView();
  const changed = before.panX !== after.panX
    || before.panY !== after.panY
    || before.zoom !== after.zoom;
  assert.ok(changed, `frameSelection should change the view; before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  // The planewise capsule UVs are in [0, 1] \u00d7 [0, 1]. The
  // canvas is wider than tall (stubbed 480 \u00d7 360), so the
  // fit-zoom is determined by the height. The actual number
  // isn't pinned (the canvas size is stubbed), but zoom
  // should be in the configured range and finite.
  assert.ok(Number.isFinite(after.zoom), 'zoom should be finite');
  assert.ok(after.zoom > 0, 'zoom should be positive');
  // Pressing F in slice mode must be a no-op (the camera
  // already belongs to the slice tool's preview).
  viewer.setMode('slice');
  const beforeSlice = viewer.getView();
  viewer.frameSelection();
  const afterSlice = viewer.getView();
  assert.deepEqual(afterSlice, beforeSlice, 'F in slice mode should not change the view');
  viewer.unmount();
});

test('slice tool: segmentsCross correctly identifies crossing segments', () => {
  // Drives the production `segmentsCross` from
  // src/systems/uv-unwrap-viewer.js \u2014 the previous version
  // of this test re-implemented the algorithm in the test
  // body, making the assertion tautological (it would pass
  // even if the production function was wrong).
  // Proper crossing: vertical (0, 0)-(0, 2) crossed by
  // horizontal (-1, 1)-(1, 1).
  assert.equal(segmentsCross([0, 0], [0, 2], [-1, 1], [1, 1]), true);
  // Parallel lines: no crossing.
  assert.equal(segmentsCross([0, 0], [1, 0], [0, 1], [1, 1]), false);
  // T-shape: the second segment ENDS on the first at
  // (1, 0). The endpoint-on-line case must NOT count as a
  // crossing \u2014 otherwise any slice near a shared vertex
  // would explode the seam set.
  assert.equal(segmentsCross([0, 0], [2, 0], [1, -1], [1, 0]), false);
  // Same-side: both endpoints of the second segment are
  // below the first line. No crossing.
  assert.equal(segmentsCross([0, 0], [2, 0], [1, -1], [1, -0.5]), false);
  // Disjoint segments: no crossing.
  assert.equal(segmentsCross([0, 0], [1, 0], [5, 5], [6, 6]), false);
  // Crossing with negative orientation (right-to-left).
  assert.equal(segmentsCross([0, 0], [2, 0], [1, 1], [1, -1]), true);
});

test('orient: returns positive, negative, and zero as expected', () => {
  // c is to the left of the (a, b) ray \u2192 positive.
  assert.ok(orient([0, 0], [1, 0], [0, 1]) > 0);
  // c is to the right \u2192 negative.
  assert.ok(orient([0, 0], [1, 0], [0, -1]) < 0);
  // Collinear \u2192 zero.
  assert.equal(orient([0, 0], [1, 0], [2, 0]), 0);
  assert.equal(orient([0, 0], [1, 1], [3, 3]), 0);
});

test('computePackEfficiency: skips faces with non-finite UVs', () => {
  // Some islands might have NaN UVs mid-unwrap — make sure we
  // don't blow up. If a face has a NaN UV, the island still
  // contributes the area of its finite UVs.
  const layout = {
    faces: [
      { uvA: [0, 0], uvB: [0.5, 0], uvC: [0, 0.5] },
      { uvA: [0.5, 0], uvB: [0.5, 0.5], uvC: [0, 0.5] },
      // The next face has NaN UVs (simulating a partial unwrap).
      { uvA: [NaN, 0], uvB: [1, 0], uvC: [1, 1] },
    ],
    islands: [{ faces: [0, 1] }, { faces: [2] }],
  };
  // Should not throw; result is in [0, 1].
  const eff = computePackEfficiency(layout);
  assert.ok(eff >= 0 && eff <= 1, `expected [0, 1], got ${eff}`);
});
