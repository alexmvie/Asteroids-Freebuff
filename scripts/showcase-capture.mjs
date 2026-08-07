#!/usr/bin/env node
/**
 * v0.72.0 — Capture every object-viewer showcase entry as a PNG.
 *
 * Uses Playwright (npm dep) against a running Vite dev server. The
 * showcase mode exposes `window.__showcase` (next/prev/setIndex/
 * texNext/getLabel), so we can walk the catalogue deterministically
 * and save one screenshot per object. Output: artifacts/showcase/<n>-<slug>.png
 *
 * Run: node scripts/showcase-capture.mjs [--url http://localhost:5175] [--out artifacts/showcase] [--textures]
 *   --textures  also capture all 5 texture variants for the 5 asteroid shapes
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5175';
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'artifacts/showcase';
const withTextures = args.includes('--textures');

function slug(label) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE ERROR:', m.text());
});

await page.goto(`${url}/?showcase`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__showcase && window.__showcase.isActive && window.__showcase.isActive(), null, { timeout: 15000 });
await page.waitForTimeout(2500); // let the first object + GLB settle

const count = await page.evaluate(() => window.__showcase.getCount());
console.log(`Showcase active, ${count} entries. Capturing...`);

const files = [];
for (let i = 0; i < count; i++) {
  await page.evaluate((idx) => window.__showcase.setIndex(idx), i);
  // 4s: the 1024x1024 albedo/normal/roughness maps load async — with
  // less wait the untextured fallback (white) pollutes the measurement
  // (that's what happened with the v1-v3 captures: "blue" = white map
  // multiplied by the warm tint, not the actual texture).
  await page.waitForTimeout(4000); // let LOD/texture swap settle

  if (withTextures) {
    const baseLabel = await page.evaluate(() => window.__showcase.getLabel());
    const isAsteroid = baseLabel.startsWith('Asteroid');
    if (isAsteroid) {
      for (let t = 1; t <= 5; t++) {
        // Jump directly to texture t: texNext up to 5 times from 1 (cheap).
        await page.evaluate(() => {
          const s = window.__showcase;
          // Reset to texture 1 first by cycling down from current.
          while (!window.__showcase.getLabel().includes('Texture 1/5')) s.texPrev();
          for (let k = 0; k < 5; k++) s.texNext();
        });
        // Now normalize: the loop above left us at texture (current+1). Simplify:
        // just capture current label; textures will naturally rotate across t via
        // repeated texNext — instead, walk explicitly:
        await page.evaluate(() => {
          const s = window.__showcase;
          // ensure texture 1
          while (!s.getLabel().includes('Texture 1/5')) s.texPrev();
          for (let k = 1; k < t; k++) s.texNext();
        });
        await page.waitForTimeout(700);
        const label = await page.evaluate(() => window.__showcase.getLabel());
        const file = path.join(outDir, `${String(i).padStart(2, '0')}-${slug(label)}.png`);
        await page.screenshot({ path: file });
        files.push(file);
        console.log(`  [tex ${t}/5] ${label} -> ${file}`);
      }
      continue;
    }
  }

  const label = await page.evaluate(() => window.__showcase.getLabel());
  const file = path.join(outDir, `${String(i).padStart(2, '0')}-${slug(label)}.png`);
  await page.screenshot({ path: file });
  files.push(file);
  console.log(`  ${label} -> ${file}`);
}

await browser.close();
console.log(`\nDone. ${files.length} screenshots in ${outDir}`);
