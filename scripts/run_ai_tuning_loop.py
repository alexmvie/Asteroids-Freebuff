#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path


def run(cmd, cwd=None):
    print('+', ' '.join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=False, text=True, capture_output=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out-dir', default='artifacts/ai-tuning')
    parser.add_argument('--steps', type=int, default=90)
    parser.add_argument('--dt', type=float, default=0.016)
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    scenario = {
        'shipStart': {'x': 0, 'z': 0, 'yaw': 0, 'vx': 0, 'vz': 0},
        'powerup': {'x': 80, 'z': 0},
        'asteroids': [
            {'x': 60, 'z': 20, 'vx': 0, 'vz': 0, 'radius': 6},
            {'x': 70, 'z': -10, 'vx': 0, 'vz': 0, 'radius': 6},
        ],
    }

    script = Path('scripts/run_ai_tuning_loop.py').resolve()
    node_code = f"""
import {{ compareAiPresets }} from './src/entities/ai-tuning.js';
import fs from 'node:fs';
const scenario = {json.dumps(scenario)};
const result = compareAiPresets({{ scenario, steps: {args.steps}, dt: {args.dt} }});
fs.writeFileSync('./{out_dir}/comparison.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
"""
    proc = run(['node', '--input-type=module', '-e', node_code], cwd=Path.cwd())
    print(proc.stdout)
    print(proc.stderr)
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)

    print('wrote', out_dir / 'comparison.json')


if __name__ == '__main__':
    main()
