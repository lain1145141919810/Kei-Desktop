#!/usr/bin/env bash
# Launch the Kei Desktop shell on Linux against the Round 05 candidate host.
# Usage: frontend/scripts/start-linux.sh [data-dir]
#   KEI_HOST_PYTHON   Python that runs kei-host.pyz (default: backend-acceptance/.venv/bin/python)
#   KEI_HOST_ARTIFACT host artifact (default: backend-acceptance/kei-host.pyz)
#   KEI_PROFILE_DIR   Electron profile (default: ~/.config/kei-desktop-shell)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
export KEI_HOST_PYTHON="${KEI_HOST_PYTHON:-$repo/backend-acceptance/.venv/bin/python}"
export KEI_HOST_ARTIFACT="${KEI_HOST_ARTIFACT:-$repo/backend-acceptance/kei-host.pyz}"
export KEI_DATA_DIR="${1:-${KEI_DATA_DIR:-$repo/backend-acceptance/kei-linux-acceptance-data}}"
cd "$here"
exec ./node_modules/.bin/electron . "${@:2}"
