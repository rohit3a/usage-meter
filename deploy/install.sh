#!/usr/bin/env bash
# Installs usage-meter from this checkout on this machine: the collector as a
# background service, and the mod for every Claude Code session. Safe to re-run.
#   deploy/install.sh
#   deploy/install.sh --host Desktop --peer Laptop=my-laptop
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HOST=""
PEERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --peer) PEERS+=("$2"); shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
DATA="$HOME/.claude/usage-meter"
PY="$(command -v python3)"
mkdir -p "$DATA/local"

# 1. this machine's name and sync peers
python3 - "$DATA/local/collector.json" "$HOST" ${PEERS[@]+"${PEERS[@]}"} <<'EOF'
import json, sys
path, host, *peers = sys.argv[1:]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
if host:
    cfg["host"] = host
if peers:
    cfg["peers"] = [{"name": p.split("=", 1)[0], "ssh": p.split("=", 1)[1], "dir": ".claude/usage-meter"} for p in peers]
cfg.setdefault("peers", [])
cfg.setdefault("syncSeconds", 20)
json.dump(cfg, open(path, "w"), indent=2)
print("collector:", json.dumps(cfg))
EOF

# 2. load the mod in every Claude Code session on this machine. A plugin in
#    ~/.claude/skills loads everywhere, and a session already open picks it up
#    with /reload-plugins. (CLAUDE_CODE_PLUGIN_DIRS was read only at startup.)
mkdir -p "$HOME/.claude/skills"
ln -sfn "$HERE/mod" "$HOME/.claude/skills/usage-meter"
echo "mod: ~/.claude/skills/usage-meter -> $HERE/mod"
python3 - "$HOME/.claude/settings.json" <<'EOF'
import json, os, shutil, sys, time
path = sys.argv[1]
if not os.path.exists(path):
    sys.exit(0)
d = json.load(open(path))
env = d.get("env", {})
old = env.get("CLAUDE_CODE_PLUGIN_DIRS")
if old is None:
    sys.exit(0)
dirs = [x for x in old.split(":") if x and "usage-meter" not in x]
if ":".join(dirs) == old:
    sys.exit(0)
backup = path + ".bak-usage-meter"
if os.path.exists(backup):
    backup += time.strftime("-%Y%m%d-%H%M%S")
shutil.copy(path, backup)
if dirs:
    env["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
else:
    del env["CLAUDE_CODE_PLUGIN_DIRS"]
with open(path, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
print("settings: removed usage-meter from CLAUDE_CODE_PLUGIN_DIRS (backup", backup + ")")
EOF

# 3. the collector as a service that restarts by itself
if [ "$(uname)" = "Darwin" ]; then
  LABEL="dev.usage-meter.collector"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$HERE/collector/umeter.py</string><string>run</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$DATA/local/collector.log</string>
  <key>StandardOutPath</key><string>$DATA/local/collector.log</string>
</dict>
</plist>
EOF
  DOMAIN="gui/$(id -u)"
  # bootstrap fails (error 5) while the old instance is still unloading: wait it out, then retry
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 20); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
  fi
  for attempt in 1 2 3 4 5; do
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && break
    [ "$attempt" = 5 ] && { echo "launchd refused the service" >&2; exit 1; }
    sleep 2
  done
  launchctl print "$DOMAIN/$LABEL" | grep -q "state = running" || launchctl kickstart "$DOMAIN/$LABEL"
  echo "service: launchd $LABEL"
else
  UNIT="$HOME/.config/systemd/user/usage-meter.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=usage-meter collector (Claude Code usage ledger and sync)
After=network-online.target

[Service]
ExecStart=$PY $HERE/collector/umeter.py run
Restart=always
RestartSec=5
Nice=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable usage-meter.service >/dev/null
  systemctl --user restart usage-meter.service
  echo "service: systemd --user usage-meter.service"
fi
