#!/usr/bin/env python3
"""
Analyze captured game frames to extract AI behavior metrics.
Run: python3 scripts/analyze_frames.py <frames-dir> [--fps 3]
"""
import sys
import json
import argparse
from pathlib import Path
import numpy as np
from PIL import Image

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

        metrics.append({
            "idx": i,
            "bright": round(bright, 2),
            "center_bright": round(center_bright, 2),
            "motion": round(motion, 2),
        })
        prev_img = img

    # Aggregate stats
    brights = [m["bright"] for m in metrics]
    motions = [m["motion"] for m in metrics]
    center_brights = [m["center_bright"] for m in metrics]

    print("=== Aggregate Metrics ===")
    print(f"Brightness:   mean={np.mean(brights):.1f}  min={min(brights):.1f}  max={max(brights):.1f}")
    print(f"CenterBright: mean={np.mean(center_brights):.1f}  min={min(center_brights):.1f}  max={max(center_brights):.1f}")
    print(f"Motion:       mean={np.mean(motions):.1f}  min={min(motions):.1f}  max={max(motions):.1f}")

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
