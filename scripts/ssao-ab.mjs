#!/usr/bin/env node
/**
 * v0.73.0 — SSAO A/B capture: the SAME showcase object frozen in place,
 * screenshotted with SSAO OFF and ON, then measured for micro-contrast.
 *
 * Uses the showcase's `setPaused(true)` hook (added v0.73.0) so the
 * asteroid's turntable spin freezes between the two captures — the only
 * pixel difference is the AO term. `window.SSAO` flips the pass live.
 *
 * Run: node scripts/ssao-ab.mjs [--url http://localhost:5175] [--index 1] [--out artifacts/ssao-ab]
 *   --index  the showcase catalogue entry (0-4 = the 5 asteroid shapes; 1 = cratered potato)
 * After both captures it shells out to scripts/measure-ssao-ab.py for the
 * micro-contrast comparison.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5175';
const index = args.includes('--index') ? Number(args[args.indexOf('--index') + 1]) : 1;
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'artifacts/ssao-ab';

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));

await page.goto(`${url}/?showcase`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__showcase && window.__showcase.isActive && window.__showcase.isActive(), null, { timeout: 15000 });
await page.waitForTimeout(2500); // let the first object + GLB settle

// Select the target object, wait for its textures, freeze the turntable.
await page.evaluate((idx) => window.__showcase.setIndex(idx), index);
await page.waitForTimeout(4000); // texture settle (1024x1024 maps load async)
await page.evaluate(() => window.__showcase.setPaused(true));
await page.waitForTimeout(300); // one settled paused frame

const label = await page.evaluate(() => window.__showcase.getLabel());

// --- OFF capture -----------------------------------------------------------
await page.evaluate(() => { window.SSAO = false; });
await page.waitForTimeout(600);
const offPath = path.join(outDir, `off-${index}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`);
await page.screenshot({ path: offPath });
console.log(`SSAO OFF -> ${offPath}`);

// --- ON capture ------------------------------------------------------------
await page.evaluate(() => { window.SSAO = true; });
await page.waitForTimeout(600);
const onPath = path.join(outDir, `on-${index}-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`);
await page.screenshot({ path: onPath });
console.log(`SSAO ON  -> ${onPath}`);

await browser.close();

// --- Measure (python3 + PIL) ----------------------------------------------
console.log('\nMeasuring micro-contrast (off vs on)...');
const py = spawnSync('python3', ['scripts/measure-ssao-ab.py', offPath, onPath], { encoding: 'utf8' });
if (py.status === 0) {
  console.log(py.stdout);
} else {
  console.error('measure-ssao-ab.py failed:\n' + py.stderr);
  process.exit(1);
}
