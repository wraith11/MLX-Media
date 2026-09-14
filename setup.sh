#!/usr/bin/env bash
#
# MLX Media — single setup & launch script (macOS / Apple Silicon).
#
# Usage:
#   ./setup.sh          # first run: install everything, then start
#   ./setup.sh --serve  # start backend + built frontend (production)
#   ./setup.sh --dev    # start backend + Vite dev server
#   ./setup.sh --rebuild # rebuild frontend without reinstall
#
# Default host is 0.0.0.0 so the web UI is reachable from other devices
# on the local network (headless Mac use case). Override with MFLUX_HOST.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
HOST="${MFLUX_HOST:-0.0.0.0}"
PORT="${MFLUX_PORT:-7861}"

log() { echo -e "\033[1;36m[mlx-media]\033[0m $*"; }
err() { echo -e "\033[1;31m[mlx-media] ERROR:\033[0m $*" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || err "Fehlendes Programm: '$1'. Bitte installieren (z.B. via Homebrew)."
}

detect_python() {
  # Prefer a Python that satisfies InvokeAI-style constraints (>=3.11, <3.13).
  for py in python3.12 python3.11 python3.10; do
    if command -v "$py" >/dev/null 2>&1; then
      echo "$py"
      return 0
    fi
  done
  # Fall back to python3 if its version is acceptable.
  if command -v python3 >/dev/null 2>&1; then
    local v
    v="$(python3 -c 'import sys; print("%d.%d" % (sys.version_info[0], sys.version_info[1]))')"
    case "$v" in
      3.10|3.11|3.12) echo "python3"; return 0 ;;
    esac
  fi
  err "Python 3.10/3.11/3.12 wird benötigt, wurde aber nicht gefunden."
}

setup_python() {
  if [ -x "$VENV_DIR/bin/python" ]; then
    log "venv bereits vorhanden."
    return
  fi
  local PY
  PY="$(detect_python)"
  log "Erzeuge venv mit $PY …"
  "$PY" -m venv "$VENV_DIR"
  log "venv erstellt."
}

install_deps() {
  log "Installiere Python-Abhängigkeiten …"
  "$VENV_DIR/bin/python" -m pip install --upgrade pip
  "$VENV_DIR/bin/python" -m pip install -r "$ROOT_DIR/requirements.txt"
  log "Python-Abhängigkeiten fertig."
}

build_frontend() {
  require_command node
  require_command npm
  log "Baue Frontend …"
  (cd "$ROOT_DIR/frontend" && npm install && npm run build)
  log "Frontend gebaut (frontend/dist)."
}

predownload_models() {
  # Optionally pre-download the inpainting (Fill) model so the first inpaint
  # job does not stall on a large Hugging Face download.
  if [ -x "$VENV_DIR/bin/python" ]; then
    log "Lade FLUX.1-Fill-dev für Inpainting vor (einmalig, groß) …"
    "$VENV_DIR/bin/python" - <<'PY'
from mflux.flux.flux import Flux1
Flux1.from_huggingface(model_name="flux.1-fill-dev", quantize=None)
print("FLUX.1-Fill-dev bereit.")
PY
  else
    log "venv fehlt — Modell-Vorabladen übersprungen (erst ./setup.sh)."
  fi
}

setup_video() {
  # Provision the isolated mlx-video runner + Wan 2.1 model (large download).
  # Requires uv (https://astral.sh/uv) and >= 64 GiB unified memory / 40 GiB free.
  require_command git
  require_command uv
  if [ ! -x "$VENV_DIR/bin/python" ]; then
    log "venv fehlt — baue zuerst die Basis-Umgebung."
    setup_python
    install_deps
  fi
  log "Prüfe Video-Voraussetzungen (Architektur, Speicher, Festplatte) …"
  "$VENV_DIR/bin/python" "$ROOT_DIR/scripts/setup_mlx_video_runner.py" plan || true
  log "Provisionschritt läuft. Das lädt Engine + Wan-Modell und konvertiert es (dauert lange, mehrere GiB)."
  "$VENV_DIR/bin/python" "$ROOT_DIR/scripts/setup_mlx_video_runner.py" provision
  log "Video-Runner fertig. Status im Video-Tab prüfen."
}

start_prod() {
  if [ ! -f "$ROOT_DIR/frontend/dist/index.html" ]; then
    log "Frontend noch nicht gebaut — baue zuerst."
    build_frontend
  fi
  log "Starte Backend + WebUI auf http://$HOST:$PORT"
  cd "$ROOT_DIR"
  exec "$VENV_DIR/bin/python" api_main.py --host "$HOST" --port "$PORT"
}

start_dev() {
  require_command node
  require_command npm
  log "Starte Backend auf http://$HOST:$PORT …"
  cd "$ROOT_DIR"
  "$VENV_DIR/bin/python" api_main.py --host "$HOST" --port "$PORT" &
  BACKEND_PID=$!
  trap "kill $BACKEND_PID 2>/dev/null || true" EXIT
  log "Starte Vite-Dev-Server auf http://localhost:5173 …"
  cd "$ROOT_DIR/frontend"
  npm run dev
}

MODE="prod"
case "${1:-}" in
  --serve) MODE="prod" ;;
  --dev) MODE="dev" ;;
  --rebuild) MODE="rebuild" ;;
  --models) MODE="models" ;;
  --help|-h)
    echo "MLX Media Setup"
    echo "  ./setup.sh           Erstinstallation + Start"
    echo "  ./setup.sh --serve   Nur starten (Backend + gebautes Frontend)"
    echo "  ./setup.sh --dev     Starten im Entwicklungsmodus (Vite)"
    echo "  ./setup.sh --rebuild Frontend neu bauen (nach Änderungen)"
    echo "  ./setup.sh --models  Inpainting-Modell (FLUX.1-Fill-dev) vorab laden"
    exit 0
    ;;
esac

if [ "$MODE" = "rebuild" ]; then
  build_frontend
  exit 0
fi

if [ "$MODE" = "models" ]; then
  predownload_models
  exit 0
fi

# First-run path: install everything, then start.
if [ ! -x "$VENV_DIR/bin/python" ] || [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
  setup_python
  install_deps
  build_frontend
fi

if [ "$MODE" = "dev" ]; then
  start_dev
else
  start_prod
fi