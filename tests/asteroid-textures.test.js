import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TEXTURE_DIR = 'public/textures';
const TEXTURES = [
  { name: 'albedo',    path: `${TEXTURE_DIR}/asteroid-albedo.png` },
  { name: 'normal',    path: `${TEXTURE_DIR}/asteroid-normal.png` },
  { name: 'roughness', path: `${TEXTURE_DIR}/asteroid-roughness.png` },
  { name: 'bump',      path: `${TEXTURE_DIR}/asteroid-bump.png` },
];

// PNG signature (8 bytes: 89 50 4E 47 0D 0A 1A 0A)
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// -----------------------------------------------------------------------
// File-existence + magic-byte checks (one per map).
//
// Regression guard: the paths are referenced from src/entities/asteroid.js
// (the ASTEROID_*_URL constants). If a refactor accidentally drops or
// renames a file, the test catches it before the player sees a flat-
// shaded asteroid in production.
// -----------------------------------------------------------------------

for (const { name, path } of TEXTURES) {
  test(`Asteroid texture: ${name} asset exists and is a non-trivial PNG`, () => {
    assert.ok(existsSync(path), `expected asteroid texture at ${path}`);
    const size = statSync(path).size;
    assert.ok(
      size > 100_000,
      `asteroid ${name} texture is suspiciously small (${size} bytes) — was the asset re-encoded at low quality?`,
    );
    // PNG magic-number check. We don't read the file in full; the
    // first 8 bytes are the PNG signature.
    const head = readFileSync(path).subarray(0, 8);
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      assert.equal(
        head[i], PNG_SIGNATURE[i],
        `asteroid ${name} is not a valid PNG (signature byte ${i} = 0x${head[i].toString(16)}, expected 0x${PNG_SIGNATURE[i].toString(16)})`,
      );
    }
  });
}

// -----------------------------------------------------------------------
// Cross-cutting: all 4 maps are 1024×1024 (power-of-two).
//
// Power-of-two dimensions get full mipmap + texture-compression
// support in WebGL. The source atlas crops were ~1018×1019 (close to
// square, not power-of-two), so they're resized with
// `magick … -resize 1024x1024!` to force exact 1024×1024. The `!`
// is the key — without it ImageMagick preserves aspect ratio and
// can land at 1023×1024.
// -----------------------------------------------------------------------

test('Asteroid texture set: all 4 maps are 1024×1024 (power-of-two)', () => {
  // Cheap check: PNG width/height are 4 bytes each at fixed offsets
  // in the IHDR chunk (bytes 16–23). Width is big-endian at offset
  // 16, height at offset 20. Reading the first 24 bytes is enough
  // to verify dimensions without a full image library.
  for (const { name, path } of TEXTURES) {
    const head = readFileSync(path).subarray(0, 24);
    const w = (head[16] << 24) | (head[17] << 16) | (head[18] << 8) | head[19];
    const h = (head[20] << 24) | (head[21] << 16) | (head[22] << 8) | head[23];
    assert.equal(w, 1024, `${name} width = ${w}, expected 1024`);
    assert.equal(h, 1024, `${name} height = ${h}, expected 1024`);
  }
});

// -----------------------------------------------------------------------
// Cross-cutting: the black separator outline is NOT in any of the
// 4 crops.
//
// The user-provided atlas is a 2×2 grid separated by a ~10px black
// outline. The crops are taken with a 1px margin from the separator
// so the outline never enters the final material. We sample the
// 4 outermost pixels of each crop (top-left, top-right, bottom-left,
// bottom-right) — none of them should be pure black, which would
// indicate the crop included the separator.
// -----------------------------------------------------------------------

test('Asteroid texture set: black separator outline is not in any crop (no pure-black corner pixels)', () => {
  // Lazy-load the assets via the `magick` CLI to avoid pulling a
  // Node-side image-decode dependency. We check the mean of each
  // of the 4 corner 4×4 patches — a corner that included the
  // black separator would have mean ≈ 0.
  for (const { name, path } of TEXTURES) {
    const dims = (execSync(`magick identify -format '%w %h' ${path}`).toString()).trim().split(' ');
    const w = parseInt(dims[0], 10);
    const h = parseInt(dims[1], 10);
    const corners = [
      { x: 0, y: 0, label: 'top-left' },
      { x: w - 4, y: 0, label: 'top-right' },
      { x: 0, y: h - 4, label: 'bottom-left' },
      { x: w - 4, y: h - 4, label: 'bottom-right' },
    ];
    for (const { x, y, label } of corners) {
      const mean = parseFloat(
        execSync(
          `magick ${path} -crop 4x4+${x}+${y} -format '%[fx:mean]' info:`,
        ).toString().trim(),
      );
      assert.ok(
        mean > 0.05,
        `${name} ${label} corner mean = ${mean}, expected > 0.05 (crop may have included the black separator)`,
      );
    }
  }
});
