#!/usr/bin/env bash
# One-line install of usage-meter, for a shell:
#   curl -fsSL https://raw.githubusercontent.com/rohit3a/usage-meter/main/install.sh | bash
# Clones (or updates) the repository into ~/.local/share/usage-meter and runs
# deploy/install.sh there; any arguments are passed on (--host, --peer).
set -euo pipefail
DEST="${USAGE_METER_DIR:-$HOME/.local/share/usage-meter}"
REPO="${USAGE_METER_REPO:-https://github.com/rohit3a/usage-meter.git}"
command -v git >/dev/null || { echo "usage-meter: needs git" >&2; exit 1; }
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" pull --ff-only --quiet
else
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --depth 1 "$REPO" "$DEST"
fi
exec bash "$DEST/deploy/install.sh" "$@"
