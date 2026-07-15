#!/usr/bin/env python3
"""
Analyze captured game frames to extract AI behavior metrics.
Run: python3 scripts/analyze_frames.py <frames-dir> [--fps 3]

Dependencies:
    pip install numpy pillow scipy

`scipy.ndimage.label` is used for fast connected-component labeling of
optical markers. If scipy is not installed, a pure-Python fallback is
used, but it is much slower on large frames.
"""
import sys
import json
import argparse
from pathlib import Path
import numpy as np
from PIL import Image

# ---------------------------------------------------------------------------
# Optical marker detection (capture-markers.js)
# ---------------------------------------------------------------------------
# The game renders high-contrast wireframe markers for video analysis:
#   - Ship:     bright green  (0x00ff00)
#   - Asteroid: bright red    (0xff0000)
#   - Powerup:  bright yellow (0xffff00)
# JPEG compression creates artifacts, so we use a generous RGB threshold.

MARKER_COLORS = {
    'ship': np.array([0, 255, 0], dtype=np.int16),
    'asteroid': np.array([255, 0, 0], dtype=np.int16),
    'powerup': np.array([255, 255, 0], dtype=np.int16),
}


def _label_blobs(mask):
    """Simple 4-connected component labeling without scipy."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    current = 0
    for y in range(h):
        for x in range(w):
            if not mask[y, x] or labels[y, x]:
                continue
            current += 1
            stack = [(y, x)]
            labels[y, x] = current
            while stack:
                cy, cx = stack.pop()
                for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = current
                        stack.append((ny, nx))
    return labels, current


def detect_markers(img_array, threshold=60, min_pixels=20):
    """
    Detect colored markers in a frame.

    Returns a dict with per-color stats:
        { color_name: { count, centroid_x, centroid_y, bbox } }
    For asteroids, count is the number of connected red blobs.
    """
    img = img_array.astype(np.int16)
    h, w = img.shape[:2]
    result = {}

    for name, color in MARKER_COLORS.items():
        diff = np.abs(img - color)
        mask = np.all(diff <= threshold, axis=-1)
        pixels = int(mask.sum())

        centroid = None
        bbox = None
        blob_count = 0

        if pixels >= min_pixels:
            # Connected-component labeling (4-connectivity) to count blobs.
            # Fallback to a simple scan if scipy is not installed.
            try:
                from scipy import ndimage
                labeled, num_features = ndimage.label(mask)
                blob_count = int(num_features)
            except Exception:
                blob_count = _label_blobs(mask)

            # Compute centroid and bounding box of all marker pixels.
            ys, xs = np.where(mask)
            if len(xs):
                centroid = (float(xs.mean()), float(ys.mean()))
                bbox = {
                    'x': int(xs.min()),
                    'y': int(ys.min()),
                    'w': int(xs.max() - xs.min() + 1),
                    'h': int(ys.max() - ys.min() + 1),
                }

        result[name] = {
            'count': blob_count if name == 'asteroid' else (1 if pixels >= min_pixels else 0),
            'pixels': pixels,
            'centroid': centroid,
            'bbox': bbox,
        }

    return result


def analyze_frames(frames_dir, fps=3):
    frames_dir = Path(frames_dir)
    pngs = sorted(frames_dir.glob("frame_*.png"))
    jpgs = sorted(frames_dir.glob("frame_*.jpg"))
    frames = pngs or jpgs
    if not frames:
        print(f"No frames found in {frames_dir}")
        return

    print(f"Analyzing {len(frames)} frames from {frames_dir}")
    print(f"Duration: {len(frames)/fps:.1f}s @ {fps}fps\n")

    metrics = []
    for i, p in enumerate(frames):
        img = np.array(Image.open(p).convert("RGB"))
        gray = np.mean(img, axis=2)

        # Region of interest: center 50% (game area)
        h, w = gray.shape
        hc, wc = h // 2, w // 2
        center = gray[hc-h//4:hc+h//4, wc-w//4:wc+w//4]

        bright = float(gray.mean())
        center_bright = float(center.mean())

        # Motion: frame-to-frame absolute difference
        motion = 0.0
        if i > 0:
            prev = np.mean(prev_img, axis=2)
            motion = float(np.mean(np.abs(gray - prev)))
            center_motion = float(np.mean(np.abs(center - prev[hc-h//4:hc+h//4, wc-w//4:wc+w//4])))

        # Optical marker detection for video analysis
        markers = detect_markers(img)

        metrics.append({
            "idx": i,
            "bright": round(bright, 2),
            "center_bright": round(center_bright, 2),
            "motion": round(motion, 2),
            "markers": markers,
        })
        prev_img = img

    # Aggregate stats
    brights = [m["bright"] for m in metrics]
    motions = [m["motion"] for m in metrics]
    center_brights = [m["center_bright"] for m in metrics]

    # Detect completely black frames (common when WebGL preserveDrawingBuffer
    # is not set and canvas.toDataURL() reads a cleared buffer).
    black_frames = sum(1 for b in brights if b == 0)
    if black_frames == len(metrics) and len(metrics) > 0:
        print("\n[!] WARNING: All frames are entirely black!")
        print("[!] Ensure WebGL preserveDrawingBuffer: true is set in the renderer.\n")

    print("=== Aggregate Metrics ===")
    print(f"Brightness:   mean={np.mean(brights):.1f}  min={min(brights):.1f}  max={max(brights):.1f}")
    print(f"CenterBright: mean={np.mean(center_brights):.1f}  min={min(center_brights):.1f}  max={max(center_brights):.1f}")
    print(f"Motion:       mean={np.mean(motions):.1f}  min={min(motions):.1f}  max={max(motions):.1f}")

    # Marker-based object counts (median per frame to ignore transient drops)
    for color in ['ship', 'asteroid', 'powerup']:
        counts = [m['markers'][color]['count'] for m in metrics]
        pixels = [m['markers'][color]['pixels'] for m in metrics]
        print(f"{color.capitalize():10} count median={int(np.median(counts))}  "
              f"pixels/frame median={int(np.median(pixels))}")

    # Detect idle periods (low motion sustained)
    idle_threshold = 0.5
    idle_frames = sum(1 for m in metrics if m["motion"] < idle_threshold)
    idle_pct = idle_frames / len(metrics) * 100
    print(f"\n=== Behavior Patterns ===")
    print(f"Low-motion (idle <{idle_threshold}): {idle_frames}/{len(metrics)} frames = {idle_pct:.0f}%")

    # Detect combat bursts (high motion)
    high_motion_threshold = 5.0
    high_motion_frames = sum(1 for m in metrics if m["motion"] > high_motion_threshold)
    high_motion_pct = high_motion_frames / len(metrics) * 100
    print(f"High-motion (>{high_motion_threshold}): {high_motion_frames}/{len(metrics)} frames = {high_motion_pct:.0f}%")

    # Brightness variation (indicator of firing/explosions)
    bright_std = np.std(brights)
    print(f"Brightness σ: {bright_std:.2f} (higher = more explosions/firing)")

    # Idle streak detection
    idle_streaks = []
    current_streak = 0
    for m in metrics:
        if m["motion"] < idle_threshold:
            current_streak += 1
        else:
            if current_streak >= 3:  # 1+ seconds at 3fps
                idle_streaks.append(current_streak)
            current_streak = 0
    if current_streak >= 3:
        idle_streaks.append(current_streak)

    if idle_streaks:
        print(f"\n=== Idle Streaks (>=1s) ===")
        print(f"Count: {len(idle_streaks)}")
        print(f"Max idle: {max(idle_streaks)/fps:.1f}s ({max(idle_streaks)} frames)")
        total_idle_time = sum(idle_streaks) / fps
        print(f"Total idle time: {total_idle_time:.1f}s")
        # Show the 5 longest idle streaks
        sorted_streaks = sorted(idle_streaks, reverse=True)[:5]
        for i, s in enumerate(sorted_streaks):
            print(f"  #{i+1}: {s/fps:.1f}s ({s} frames)")

    # Per-second summary (every N frames)
    print(f"\n=== Per-Second Summary ({fps}fps) ===")
    step = fps  # 1 second
    for i in range(0, len(metrics), step):
        chunk = metrics[i : i + step]
        avg_motion = np.mean([m["motion"] for m in chunk])
        avg_bright = np.mean([m["bright"] for m in chunk])
        bar = "█" * int(min(avg_motion, 10))
        sec = i // fps
        print(f"  s{sec:3d}  motion={avg_motion:5.1f}  bright={avg_bright:5.1f}  {bar}")

    # Load game metrics captured by the browser capture script (if present)
    game_metrics = {}
    summary_path = frames_dir / "summary.json"
    if summary_path.exists():
        try:
            summary_data = json.loads(summary_path.read_text())
            game_metrics = summary_data.get("metrics", {}) or {}
        except Exception:
            game_metrics = {}

    # Save detailed metrics
    out_path = frames_dir / "analysis.json"
    with open(out_path, "w") as f:
        json.dump({
            "count": len(metrics),
            "duration_s": round(len(metrics) / fps, 1),
            "mean_bright": round(np.mean(brights), 2),
            "mean_motion": round(np.mean(motions), 2),
            "max_motion": round(max(motions), 2),
            "idle_pct": round(idle_pct, 1),
            "high_motion_pct": round(high_motion_pct, 1),
            "bright_std": round(bright_std, 2),
            "idle_streaks": len(idle_streaks),
            "max_idle_streak_s": round(max(idle_streaks) / fps, 1) if idle_streaks else 0,
            "markers": {
                "ship": {
                    "median_count": int(np.median([m["markers"]["ship"]["count"] for m in metrics])),
                    "median_pixels": int(np.median([m["markers"]["ship"]["pixels"] for m in metrics])),
                },
                "asteroid": {
                    "median_count": int(np.median([m["markers"]["asteroid"]["count"] for m in metrics])),
                    "median_pixels": int(np.median([m["markers"]["asteroid"]["pixels"] for m in metrics])),
                },
                "powerup": {
                    "median_count": int(np.median([m["markers"]["powerup"]["count"] for m in metrics])),
                    "median_pixels": int(np.median([m["markers"]["powerup"]["pixels"] for m in metrics])),
                },
            },
            "game_metrics": game_metrics,
        }, f, indent=2)
    print(f"\nDetailed analysis saved to {out_path}")
    if game_metrics:
        print("\n=== Game Metrics ===")
        for key, value in game_metrics.items():
            print(f"  {key}: {value}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("frames_dir", help="Directory with frame_*.png files")
    parser.add_argument("--fps", type=int, default=3, help="Capture framerate")
    args = parser.parse_args()
    analyze_frames(args.frames_dir, args.fps)
