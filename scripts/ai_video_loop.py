#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import imageio
import numpy as np
from PIL import Image


def run(cmd, cwd=None):
    print('+', ' '.join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=False, text=True, capture_output=True)


def capture_frames(out_dir: Path, seconds: int = 8, fps: int = 12):
    """Capture *seconds × fps* individual frames from the main display.

    Uses ffmpeg (avfoundation on macOS) if available; falls back to
    placeholder frames of uniform colour.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    n_frames = seconds * fps

    ffmpeg = shutil.which('ffmpeg')
    if ffmpeg:
        pattern = str(out_dir / 'frame_%03d.png')
        # Use -t (wall-clock duration) + -vf fps= (filter) instead of -frames:v + -r.
        # -frames:v + -r with a live avfoundation input can produce fewer frames
        # than expected because the -r decimation interacts unpredictably with
        # the real-time capture start-up.  -t gives a clean wall-clock window.
        cmd = [
            ffmpeg, '-y',
            '-f', 'avfoundation',
            '-i', '1:none',                # screen 1, no audio
            '-t', str(seconds),
            '-vf', f'fps={fps}',
            pattern,
        ]
        proc = run(cmd)
        if proc.returncode == 0:
            frames = []
            for i in range(n_frames):
                p = out_dir / f'frame_{i:03d}.png'
                if p.exists():
                    frames.append(np.array(Image.open(p).convert('RGB')))
                    p.unlink()
            # Accept within 90% of target — live capture may drop 1-2 frames
            # on avfoundation start-up.
            if len(frames) >= n_frames * 0.9:
                return frames
            print(f'  ffmpeg: expected ~{n_frames} frames, got {len(frames)} — using placeholder fallback')
        else:
            print('  ffmpeg capture failed, using placeholder frames')

    # Fallback: solid-colour placeholders (no screen-capture available)
    frames = []
    img = np.zeros((180, 320, 3), dtype=np.uint8)
    img[:] = (20, 20, 30)
    # Draw a small cyan rectangle so placeholder frames are visually distinct
    img[20:60, 20:120] = (80, 220, 255)
    for _ in range(n_frames):
        frames.append(img.copy())
    return frames


def analyze_frames(frames):
    metrics = []
    for idx, frame in enumerate(frames):
        gray = np.mean(frame, axis=2)
        bright = float(gray.mean())
        motion = float(np.mean(np.abs(np.diff(gray, axis=0))))
        metrics.append({'idx': idx, 'bright': bright, 'motion': motion})
    return metrics


def write_summary(metrics, out_json: Path):
    if metrics:
        summary = {
            'count': len(metrics),
            'mean_bright': float(np.mean([m['bright'] for m in metrics])),
            'mean_motion': float(np.mean([m['motion'] for m in metrics])),
            'max_motion': float(np.max([m['motion'] for m in metrics])),
        }
    else:
        summary = {'count': 0, 'mean_bright': 0.0, 'mean_motion': 0.0, 'max_motion': 0.0}
    out_json.write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description='Capture and analyze game frames via ffmpeg.')
    parser.add_argument('--out-dir', default='artifacts/ai-video')
    parser.add_argument('--seconds', type=int, default=6)
    parser.add_argument('--fps', type=int, default=8)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = capture_frames(out_dir, seconds=args.seconds, fps=args.fps)
    video_path = out_dir / 'capture.mp4'
    try:
        imageio.mimsave(video_path, frames, fps=args.fps)
    except Exception as exc:
        print('video export warning:', exc)
        video_path = out_dir / 'capture.gif'
        try:
            imageio.mimsave(video_path, frames, fps=args.fps, loop=0)
        except Exception:
            # Last resort: PIL fromarray + save
            pil_frames = [Image.fromarray(f) for f in frames]
            pil_frames[0].save(video_path, save_all=True, append_images=pil_frames[1:],
                               duration=1000 // args.fps, loop=0)
    metrics = analyze_frames(frames)
    write_summary(metrics, out_dir / 'summary.json')
    print(f'frames: {len(frames)}')
    print('video:', video_path)


if __name__ == '__main__':
    main()
