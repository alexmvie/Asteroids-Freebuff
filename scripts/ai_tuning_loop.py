#!/usr/bin/env python3
"""
scripts/ai_tuning_loop.py

Automated AI tuning loop.

1. Runs a short baseline capture to measure current AI performance.
2. Defines a mathematical target based on that baseline (theoretical
   ceiling derived from fire cooldown + spawn delay).
3. Uses random search over the tunable surface in src/entities/ai-tunables.js.
4. Runs browser captures, compares achieved rates to the target, and
   keeps the best parameter set.

Usage:
    python3 scripts/ai_tuning_loop.py [--iterations 8] [--seconds 60] [--fps 3]

The script is safe to interrupt (Ctrl-C); it restores the original
src/entities/ai-tunables.js on exit.

Python dependencies (in addition to the project dev server):
    pip install numpy pillow scipy
"""
import argparse
import itertools
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
TUNABLES_JS = ROOT / "src" / "entities" / "ai-tunables.js"
ARTIFACTS = ROOT / "artifacts" / "ai-tuning"

# ---------------------------------------------------------------------------
# Tunable surface
# ---------------------------------------------------------------------------
# Each entry maps the constant name to a list of candidate values.
# The loop samples combinations randomly so the search space can be
# large without exploding runtime.
TUNABLES = {
    "fireHeadingGate": [0.30, 0.35, 0.40, 0.45, 0.50, 0.55],
    "thrustHeadingGate": [0.20, 0.25, 0.30, 0.35, 0.40],
    "evadeDist": [8, 10, 12, 14, 16, 18],
    "powerupMaxChaseDist": [150, 200, 250, 300, 350, 400],
    "fireMinDist": [5, 10, 15, 20],
    "fireMaxDist": [120, 150, 180, 200],
    "powerupThrustGate": [0.05, 0.10, 0.15, 0.20],
    "asteroidSizeBias": [0, 4, 8, 12, 16],
}

# ---------------------------------------------------------------------------
# Mathematical model
# ---------------------------------------------------------------------------
# These targets are derived from the game constants and represent the
# theoretical ceiling the AI should approach, not an arbitrary goal.
# They are intentionally conservative so the loop does not chase an
# unreachable optimum.
#
# Asteroids/min:
#   - Fire cooldown = 0.18 s  => 5.55 shots/s  => 333 shots/min.
#   - Assume 50 % of shots hit a target.
#   - Each initial asteroid splits into ~3.6 sub-asteroids on average.
#   - Effective pieces/min ≈ 333 * 0.50 ≈ 166.
#   - We use a realistic target of 120 pieces/min.
#
# Powerups/min:
#   - DEMO spawn delay after pickup/expiry = 2.5 s.
#   - Average spawn distance from anchor ≈ 100 u.
#   - AI approach speed is capped at 30 u/s in collectBehavior.
#   - Travel time ≈ 100 / 30 ≈ 3.3 s + turn time ≈ 0.3 s.
#   - Cycle time ≈ 2.5 + 3.6 ≈ 6.1 s  => 60 / 6.1 ≈ 9.8 collections/min.
#   - We use a realistic target of 8 collections/min.
DEFAULT_MODEL = {
    "asteroids_per_min": 120,
    "powerups_per_min": 8,
}


# ---------------------------------------------------------------------------
# AI constant patching
# ---------------------------------------------------------------------------
def read_tunables():
    return TUNABLES_JS.read_text(encoding="utf-8")


def write_tunables(text):
    TUNABLES_JS.write_text(text, encoding="utf-8")


def patch_tunable(text, name, value):
    """Replace a numeric AI_TUNABLES constant in ai-tunables.js.

    Preserves the original number style (integer vs float) so the
    diff stays clean and the file remains readable.
    """
    # Find the original line to determine whether it was written as int or float.
    search_pattern = rf"({re.escape(name)}:\s*)([0-9]+(?:\.[0-9]+)?)(,?)"
    match = re.search(search_pattern, text)
    if not match:
        raise ValueError(f"Could not find tunable constant '{name}' in {TUNABLES_JS}")

    original = match.group(2)
    # If the original value looks like an integer, write an integer.
    if '.' not in original:
        formatted = str(int(round(value)))
    else:
        formatted = str(float(value))

    return re.sub(search_pattern, rf"\g<1>{formatted}\g<3>", text, count=1)


def apply_params(params):
    """Write the given parameter values into ai-tunables.js."""
    text = read_tunables()
    for name, value in params.items():
        text = patch_tunable(text, name, value)
    write_tunables(text)


# ---------------------------------------------------------------------------
# Capture + analysis
# ---------------------------------------------------------------------------
def run_capture(seconds, fps):
    """Run the browser capture and return the artifacts directory."""
    out_dir = ARTIFACTS / f"run_{int(time.time())}"
    out_dir.mkdir(parents=True, exist_ok=True)

    url = find_dev_server()
    if url is None:
        print("No dev server found on 5173/5174/5175; starting one...")
        start_dev_server()
        url = find_dev_server(timeout_s=15)
        if url is None:
            raise RuntimeError("Could not start/find a Vite dev server")

    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "ai_browser_capture.py"),
        "--url", url,
        "--seconds", str(seconds),
        "--fps", str(fps),
        "--out-dir", str(out_dir),
    ]
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=False)
    return out_dir


def find_dev_server(timeout_s=2):
    """Probe common Vite ports and return the first reachable URL."""
    import urllib.request
    for port in [5173, 5174, 5175, 5176, 5177, 5178]:
        url = f"http://127.0.0.1:{port}/"
        try:
            with urllib.request.urlopen(url, timeout=timeout_s):
                return url
        except Exception:
            continue
    return None


dev_server_process = None


def start_dev_server():
    """Start `npm run dev` in the background."""
    global dev_server_process
    dev_server_process = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def stop_dev_server():
    """Stop the dev server started by this script."""
    global dev_server_process
    if dev_server_process is not None:
        dev_server_process.terminate()
        try:
            dev_server_process.wait(timeout=5)
        except Exception:
            dev_server_process.kill()
        dev_server_process = None


def analyze_capture(out_dir, fps):
    """Run analyze_frames.py and return the parsed analysis.json."""
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "analyze_frames.py"),
        str(out_dir),
        "--fps", str(fps),
    ]
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=False)
    analysis_path = out_dir / "analysis.json"
    if analysis_path.exists():
        return json.loads(analysis_path.read_text())
    return {}


def read_game_metrics(out_dir):
    """Read the in-game metrics collected by the browser capture."""
    summary_path = out_dir / "summary.json"
    if not summary_path.exists():
        return {}
    try:
        data = json.loads(summary_path.read_text())
        return data.get("metrics", {}) or {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------
def score_run(metrics, duration_s, model):
    """Compare achieved rates to the mathematical model."""
    asteroids = metrics.get("asteroidsDestroyed", 0)
    powerups = metrics.get("powerupsCollected", 0)
    minutes = max(duration_s, 1) / 60.0

    ast_per_min = asteroids / minutes
    pwr_per_min = powerups / minutes

    # Normalized shortfall (0 = hit model, 1 = zero)
    ast_gap = max(0, 1 - ast_per_min / model["asteroids_per_min"])
    pwr_gap = max(0, 1 - pwr_per_min / model["powerups_per_min"])

    # Score: higher is better. Weight powerups a bit more because they
    # are rarer and harder to collect.
    score = (1 - ast_gap) + 2 * (1 - pwr_gap)

    return {
        "score": score,
        "asteroids": asteroids,
        "powerups": powerups,
        "asteroids_per_min": round(ast_per_min, 1),
        "powerups_per_min": round(pwr_per_min, 1),
        "asteroid_gap": round(ast_gap, 2),
        "powerup_gap": round(pwr_gap, 2),
    }


def random_params():
    """Sample a random parameter combination from the tunable grid."""
    return {name: random.choice(values) for name, values in TUNABLES.items()}


def params_from_file():
    """Read the current parameter values from ai-tunables.js."""
    text = read_tunables()
    params = {}
    for name in TUNABLES.keys():
        # Match both integers and floats.
        pattern = rf"{re.escape(name)}:\s*([0-9]+(?:\.[0-9]+)?),"
        match = re.search(pattern, text)
        if match:
            value = match.group(1)
            params[name] = int(value) if value.isdigit() else float(value)
    return params


def perturb_params(params, dims_to_perturb=2):
    """Return a neighbor of `params` by perturbing one or more dimensions."""
    new_params = dict(params)
    names = list(TUNABLES.keys())
    random.shuffle(names)
    for name in names[:dims_to_perturb]:
        values = TUNABLES[name]
        current = new_params[name]
        # Pick the nearest grid value that is different from current.
        candidates = [v for v in values if v != current]
        if candidates:
            # Prefer values close to current.
            candidates.sort(key=lambda v: abs(v - current))
            new_params[name] = random.choice(candidates[:2])
    return new_params


# ---------------------------------------------------------------------------
# Main tuning loop
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="AI tuning loop")
    parser.add_argument("--iterations", type=int, default=8, help="Number of tuning iterations")
    parser.add_argument("--seconds", type=int, default=60, help="Capture duration per iteration")
    parser.add_argument("--fps", type=int, default=3, help="Capture framerate")
    parser.add_argument("--restore", action="store_true", help="Restore original ai-tunables.js and exit")
    parser.add_argument("--baseline-seconds", type=int, default=30, help="Duration of baseline capture")
    args = parser.parse_args()

    pristine_backup = ARTIFACTS / "ai-tunables.pristine.js"
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    # Keep a pristine backup of the committed ai-tunables.js. Only
    # refresh it when there is no backup yet, or when the current file
    # is byte-identical to the backup (so manual edits are preserved).
    if not pristine_backup.exists():
        shutil.copy(TUNABLES_JS, pristine_backup)
    elif TUNABLES_JS.read_bytes() == pristine_backup.read_bytes():
        # Current file matches backup; refresh timestamp only.
        shutil.copy(TUNABLES_JS, pristine_backup)

    if args.restore:
        shutil.copy(pristine_backup, TUNABLES_JS)
        print(f"Restored {TUNABLES_JS} from pristine backup.")
        return

    print("=== AI Tuning Loop ===")
    print(f"Tunables: {list(TUNABLES.keys())}")
    print(f"Running {args.iterations} iterations of {args.seconds}s captures @ {args.fps}fps\n")

    # Baseline capture with current parameters to derive realistic targets.
    print("--- Running baseline capture ---")
    baseline_dir = run_capture(args.baseline_seconds, args.fps)
    baseline_metrics = read_game_metrics(baseline_dir)
    baseline_analysis = analyze_capture(baseline_dir, args.fps)
    baseline_minutes = args.baseline_seconds / 60.0

    # Derive model targets from baseline, capped at the theoretical ceiling.
    baseline_asteroids = baseline_metrics.get("asteroidsDestroyed", 0) / baseline_minutes
    baseline_powerups = baseline_metrics.get("powerupsCollected", 0) / baseline_minutes
    model = {
        "asteroids_per_min": min(
            max(baseline_asteroids * 1.3, 60),
            DEFAULT_MODEL["asteroids_per_min"],
        ),
        "powerups_per_min": min(
            max(baseline_powerups * 1.3, 4),
            DEFAULT_MODEL["powerups_per_min"],
        ),
    }
    print(f"Baseline: {baseline_asteroids:.1f} asteroids/min, {baseline_powerups:.1f} powerups/min")
    print(f"Model target: {model['asteroids_per_min']:.1f} asteroids/min, {model['powerups_per_min']:.1f} powerups/min\n")

    best = {"score": -1, "params": {}, "result": None}
    all_results = []
    tested_combos = set()

    # Hill-climbing state: start from the current committed params and
    # try small random perturbations around the best known set.
    current_params = params_from_file()
    hill_climb_every = max(1, args.iterations // 3)

    try:
        for iteration in range(args.iterations):
            # First third: random exploration. After that: hill-climb
            # from the best known params by perturbing one dimension.
            if iteration > 0 and iteration % hill_climb_every == 0 and best["params"]:
                params = perturb_params(best["params"])
            else:
                params = random_params()

            # Deduplicate exact combinations.
            attempts = 0
            while attempts < 100:
                key = tuple(sorted(params.items()))
                if key not in tested_combos:
                    tested_combos.add(key)
                    break
                params = random_params()
                attempts += 1

            print(f"\n--- Iteration {iteration + 1}/{args.iterations}: {params} ---")
            apply_params(params)
            print("Waiting for Vite hot-reload...")
            time.sleep(2)

            out_dir = run_capture(args.seconds, args.fps)
            game_metrics = read_game_metrics(out_dir)
            frame_analysis = analyze_capture(out_dir, args.fps)

            result = score_run(game_metrics, args.seconds, model)
            result["params"] = params
            result["frame_analysis"] = frame_analysis
            all_results.append(result)

            print(f"Asteroids: {result['asteroids']} ({result['asteroids_per_min']}/min, gap {result['asteroid_gap']})")
            print(f"Powerups:  {result['powerups']} ({result['powerups_per_min']}/min, gap {result['powerup_gap']})")
            print(f"Score:     {result['score']:.3f}")

            if result["score"] > best["score"]:
                best = {"score": result["score"], "params": params, "result": result}
                print("  -> New best!")

        print("\n=== Best Result ===")
        print(f"Params: {best['params']}")
        print(f"Score:  {best['score']:.3f}")
        print(f"Asteroids/min: {best['result']['asteroids_per_min']}")
        print(f"Powerups/min:  {best['result']['powerups_per_min']}")

        # Apply the best params permanently
        if best["params"]:
            apply_params(best["params"])
            print(f"\nApplied best params to {TUNABLES_JS}")

        # Save full report
        report_path = ARTIFACTS / "tuning_report.json"
        report_path.write_text(json.dumps({
            "model": model,
            "baseline": {
                "asteroids_per_min": baseline_asteroids,
                "powerups_per_min": baseline_powerups,
            },
            "best": best,
            "all_results": all_results,
        }, indent=2))
        print(f"Report saved to {report_path}")

    except KeyboardInterrupt:
        print("\nInterrupted by user. Restoring original ai-tunables.js...")
        shutil.copy(pristine_backup, TUNABLES_JS)
        raise
    finally:
        stop_dev_server()


if __name__ == "__main__":
    main()
