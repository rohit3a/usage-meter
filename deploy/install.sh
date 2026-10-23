#!/usr/bin/env bash
# Installs usage-meter from this checkout: the mod for every Claude Code session
# on this machine, and the collector as a background service. Safe to re-run.
#   deploy/install.sh
#   deploy/install.sh --host Desktop --peer Laptop=my-laptop
# Most people don't need this: `/plugin install usage-meter --marketplace rohit3a/usage-meter`
# in Claude Code does the same, and the mod starts the collector by itself.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host|--peer) ARGS+=("$1" "$2"); shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
PY="$(command -v python3 || true)"
if [ -z "$PY" ] || ! "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 9))'; then
  echo "usage-meter needs Python 3.9 or later as python3" >&2
  exit 1
fi
UMETER="$HERE/mod/collector/umeter.py"

# 1. this machine's name and sync peers, when given
if [ ${#ARGS[@]} -gt 0 ]; then
  "$PY" "$UMETER" config "${ARGS[@]}"
fi

# 2. the mod, for every session: a plugin in ~/.claude/skills loads everywhere,
#    and a session already open picks it up with /reload-plugins
mkdir -p "$HOME/.claude/skills"
ln -sfn "$HERE/mod" "$HOME/.claude/skills/usage-meter"
echo "mod: ~/.claude/skills/usage-meter -> $HERE/mod"

# 3. builds before function hooks were on by default need this switch; later ones ignore it
"$PY" - "$HOME/.claude/settings.json" <<'EOF'
import json, os, shutil, sys
path = sys.argv[1]
d = {}
if os.path.exists(path):
    with open(path) as f:
        d = json.load(f)
env = d.setdefault("env", {})
changed = False
if env.get("CLAUDE_CODE_ENABLE_FUNCTION_HOOKS") != "1":
    env["CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"] = "1"
    changed = True
old = env.get("CLAUDE_CODE_PLUGIN_DIRS")
if old is not None:  # older installs of this mod loaded it from here
    dirs = [x for x in old.split(":") if x and "usage-meter" not in x]
    if ":".join(dirs) != old:
        if dirs:
            env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
        else:
            del env["CLAUDE_CODE_PLUGIN_DIRS"]
        changed = True
if changed:
    note = ""
    if os.path.exists(path):
        shutil.copy(path, path + ".bak-usage-meter")
        note = " (backup: settings.json.bak-usage-meter)"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    print("settings: updated ~/.claude/settings.json" + note)
EOF

# 4. the collector, as a service that restarts by itself
"$PY" "$UMETER" install
echo "done: open Claude Code (or /reload-plugins in an open session) and type /burn"
