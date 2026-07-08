#!/usr/bin/env bash
# scripts/run-ai-loop.sh
#
# Hands-off AI analysis loop: start Vite → capture game frames → generate
# video/GIF + summary → stop Vite.
#
# Usage:
#   ./scripts/run-ai-loop.sh                    # default: ffmpeg, 6s, 8fps
#   ./scripts/run-ai-loop.sh --mode browser     # Playwright canvas capture
#   ./scripts/run-ai-loop.sh --seconds 10 --fps 6
#   ./scripts/run-ai-loop.sh --out-dir artifacts/ai-run-42
#
# Requirements:
#   - ffmpeg mode: ffmpeg installed + macOS screen recording permission
#   - browser mode: Python + playwright (`pip install playwright`)
#   - Python packages: PIL, numpy, imageio

set -euo pipefail

# ---- defaults ----
MODE=ffmpeg
SECONDS=6
FPS=8
OUT_DIR="artifacts/ai-loop"
PORT=5173
HOST="127.0.0.1"

# ---- parse args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --seconds) SECONDS="$2"; shift 2 ;;
    --fps) FPS="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--mode ffmpeg|browser] [--seconds N] [--fps N] [--out-dir PATH] [--port N]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT_DIR_FULL="$PROJECT_DIR/$OUT_DIR"
mkdir -p "$OUT_DIR_FULL"

echo "=== AI Loop: mode=$MODE seconds=$SECONDS fps=$FPS out=$OUT_DIR ==="

# ---- helper: wait for Vite ----
wait_for_vite() {
  local url="http://$HOST:$PORT"
  echo "  Waiting for Vite at $url ..."
  for i in $(seq 1 30); do
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' "$url" --connect-timeout 1 2>/dev/null || echo '000')
    if [ "$status" -ge 200 ] && [ "$status" -lt 400 ]; then
      echo "  Vite ready after ${i}s (HTTP $status)"
      return 0
    fi
    sleep 1
  done
  echo "  ERROR: Vite did not become ready in 30s"
  kill "$VITE_PID" 2>/dev/null || true
  exit 1
}

# ---- helper: cleanup on exit ----
cleanup() {
  local exit_code=$?
  if [[ -n "${VITE_PID:-}" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    echo "  Stopping Vite (PID $VITE_PID)..."
    kill "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
    echo "  Vite stopped"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---- start Vite (if not already running) ----
if lsof -i ":$PORT" -sTCP:LISTEN -P 2>/dev/null | grep -q node; then
  echo "  Vite already running on port $PORT — reusing"
  VITE_PID=""
else
  echo "  Starting Vite on $HOST:$PORT ..."
  cd "$PROJECT_DIR"
  npm run dev -- --host "$HOST" --port "$PORT" > /tmp/ai-loop-vite.log 2>&1 &
  VITE_PID=$!
  wait_for_vite
fi

# ---- capture ----
case "$MODE" in
  ffmpeg)
    echo "  Capturing with ffmpeg (screen)..."
    python3 "$SCRIPT_DIR/ai_video_loop.py" \
      --out-dir "$OUT_DIR_FULL" \
      --seconds "$SECONDS" \
      --fps "$FPS"
    ;;
  browser)
    echo "  Capturing with Playwright (canvas)..."
    python3 "$SCRIPT_DIR/ai_browser_capture.py" \
      --out-dir "$OUT_DIR_FULL" \
      --url "http://$HOST:$PORT/" \
      --seconds "$SECONDS" \
      --fps "$FPS"
    ;;
  *)
    echo "Unknown mode: $MODE (use ffmpeg or browser)"
    exit 1
    ;;
esac

echo ""
echo "=== Done ==="
echo "  Output: $OUT_DIR_FULL/"
ls -lh "$OUT_DIR_FULL/" 2>/dev/null || echo "  (empty)"
