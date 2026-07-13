#!/usr/bin/env python3
"""
Capture a sequence of screenshots from an already-running Vite dev server
and compile them into an MP4 video using ffmpeg. Also collects in-game
AI metrics from `window._aiMetrics` so the tuning loop can measure powerup
collection, score progression, etc.

This script assumes a dev server is already running at the target URL
(usually started by scripts/run-ai-loop.sh). It does NOT start its own
server, to avoid port conflicts and double resource usage.

Run: python3 scripts/ai_browser_capture.py --out-dir artifacts/ai-run --seconds 240 --fps 3
"""
import argparse
import json
import os
import subprocess
import sys
import time
import base64
from pathlib import Path

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

    ai_metrics = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
        # Surface JS runtime errors and console messages so a crashed
        # game loop is immediately visible in the capture logs.
        page.on('pageerror', lambda err: print(f'PAGE ERROR: {err}', file=sys.stderr))
        page.on('console', lambda msg: print(f'CONSOLE [{msg.type}]: {msg.text}', file=sys.stderr))
        # Use domcontentloaded + a short settle instead of networkidle.
        # The game canvas renders continuously, so networkidle may never fire.
        page.goto(args.url, wait_until='domcontentloaded', timeout=60000)
        time.sleep(2)
        page.wait_for_selector('canvas', timeout=10000)

        shots = []
        frame_interval = 1.0 / args.fps
        for i in range(args.seconds * args.fps):
            path = out_dir / f'frame_{i:03d}.jpg'
            frame_start = time.time()

            # Capture the largest canvas by asking the page to serialize it
            # as a JPEG data URL. This bypasses Playwright's screenshot
            # actionability/stability checks, which hang on a continuously
            # rendering WebGL canvas.
            data_url = page.evaluate('''() => {
                const canvases = Array.from(document.querySelectorAll('canvas'));
                if (!canvases.length) return null;
                const c = canvases.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
                try {
                    return c.toDataURL('image/jpeg', 0.92);
                } catch (e) {
                    return null;
                }
            }''')

            if data_url:
                header, b64 = data_url.split(',', 1)
                path.write_bytes(base64.b64decode(b64))
                shots.append(path)
            else:
                print(f'Warning: frame {i} capture returned no data', file=sys.stderr)

            # Collect in-game metrics exposed by main.js
            try:
                ai_metrics = page.evaluate('() => (window._aiMetrics || {})')
            except Exception as e:
                print(f'Warning: could not read _aiMetrics: {e}', file=sys.stderr)

            # Sleep to maintain the target frame rate, accounting for the time
            # the capture took.
            elapsed = time.time() - frame_start
            sleep_time = frame_interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

        browser.close()

    # Export as MP4 with ffmpeg (avoids loading all frames into RAM).
    out_video = out_dir / 'capture.mp4'
    ffmpeg_cmd = [
        'ffmpeg', '-y', '-framerate', str(args.fps),
        '-i', str(out_dir / 'frame_%03d.jpg'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        str(out_video),
    ]
    ffmpeg_result = run(ffmpeg_cmd)
    video_path = str(out_video) if ffmpeg_result.returncode == 0 and out_video.exists() else None
    if ffmpeg_result.returncode != 0:
        print(f'Warning: ffmpeg failed ({ffmpeg_result.returncode}): {ffmpeg_result.stderr}', file=sys.stderr)

    summary = {
        'captured': len(shots),
        'video': video_path,
        'url': args.url,
        'metrics': ai_metrics,
    }
    (out_dir / 'summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
