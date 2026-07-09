#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import imageio
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright


def run(cmd, cwd=None):
    print('+', ' '.join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=False, text=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-dir', default='artifacts/ai-browser')
    parser.add_argument('--url', default='http://127.0.0.1:5173/')
    parser.add_argument('--seconds', type=int, default=6)
    parser.add_argument('--fps', type=int, default=8)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not Path('package.json').exists():
        raise SystemExit('Run from the project root')

    print('Starting Vite dev server...')
    server = subprocess.Popen(['npm', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(60):
            time.sleep(0.5)
            if server.poll() is not None:
                break
            try:
                import urllib.request
                with urllib.request.urlopen(args.url, timeout=1) as resp:
                    if resp.status < 500:
                        break
            except Exception:
                continue
        else:
            print('Vite did not become ready in time')

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
            page.goto(args.url, wait_until='networkidle')
            time.sleep(2)
            page.wait_for_selector('canvas', timeout=10000)
            shots = []
            for i in range(args.seconds * args.fps):
                path = out_dir / f'frame_{i:03d}.png'
                # Capture the main game canvas rather than the whole page, which
                # includes HUD overlays and other UI chrome that distort the view.
                # The main scene uses the largest canvas element on the page.
                canvas = page.evaluate('''() => {
                    const canvases = Array.from(document.querySelectorAll('canvas'));
                    if (!canvases.length) return null;
                    return canvases
                        .map((c, i) => ({ i, width: c.width, height: c.height, rect: c.getBoundingClientRect() }))
                        .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0].i;
                }''')
                if canvas is not None:
                    page.locator('canvas').nth(canvas).screenshot(path=path)
                else:
                    page.screenshot(path=path, full_page=False)
                shots.append(path)
                time.sleep(1 / args.fps)
            browser.close()

        # Export as MP4 (no GIF fallback).
        frames_np = [np.array(Image.open(p).convert('RGB')) for p in shots]
        out_video = out_dir / 'capture.mp4'
        imageio.mimsave(out_video, frames_np, fps=args.fps)
        summary = {
            'captured': len(shots),
            'video': str(out_video),
            'url': args.url,
        }
        (out_dir / 'summary.json').write_text(json.dumps(summary, indent=2))
        print(json.dumps(summary, indent=2))
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == '__main__':
    main()
