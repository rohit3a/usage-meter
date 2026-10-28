"""Installs the collector as a background service, keeps it on the plugin's
current code, and removes it again.

The plugin's own folder changes with every version (a marketplace install lives
under a versioned cache path), so the service never runs from it: install copies
collector/*.py and prices.json to ~/.claude/usage-meter/app/ and points the
service there. `install --if-needed` is what the mod runs at every session
start: it does nothing while a collector on the same code is running.

Service: a systemd user unit on Linux, a launchd agent on macOS, and where
neither is there (Windows, WSL without systemd, a container) a detached process that the
next session start brings back if it has died. USAGE_METER_SERVICE=process (or
systemd, launchd) overrides the choice.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time

import oscompat

HOME =os.path.expanduser("~")
ROOT = os.path.join(HOME, ".claude", "usage-meter")
LOCAL = os.path.join(ROOT, "local")
APP = os.path.join(ROOT, "app")
HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(LOCAL, "setup.json")
LOCK = os.path.join(LOCAL, "collector.lock")
LOG = os.path.join(LOCAL, "collector.log")
UNIT_NAME = "usage-meter.service"
UNIT = os.path.join(HOME, ".config", "systemd", "user", UNIT_NAME)
LABEL = "dev.usage-meter.collector"
PLIST = os.path.join(HOME, "Library", "LaunchAgents", LABEL + ".plist")


def sources() -> list[tuple[str, str]]:
    """(source path, path under app/) for every file the collector runs on."""
    files = [(os.path.join(HERE, n), os.path.join("collector", n)) for n in sorted(os.listdir(HERE)) if n.endswith(".py")]
    files.append((os.path.join(HERE, "..", "prices.json"), "prices.json"))
    return files


def stamp_of(files: list[tuple[str, str]]) -> str:
    h = hashlib.sha256()
    for src, rel in files:
        h.update(rel.encode())
        with open(src, "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:12]


def load(path: str, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def save(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def running_pid() -> int | None:
    """The running collector's pid, or None: it holds collector.lock while it runs."""
    try:
        f = open(LOCK, "a+")
    except OSError:
        return None
    try:
        oscompat.lock(f, blocking=False)
        oscompat.unlock(f)
        return None
    except OSError:
        f.seek(0)
        text = f.read().strip()
        return int(text) if text.isdigit() else -1
    finally:
        f.close()


def wait_for(alive: bool, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if (running_pid() is not None) == alive:
            return True
        time.sleep(0.25)
    return (running_pid() is not None) == alive


def sh(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(list(argv), capture_output=True, text=True, timeout=60)


def manager() -> str:
    forced = os.environ.get("USAGE_METER_SERVICE", "")
    if forced in ("systemd", "launchd", "process"):
        return forced
    if sys.platform == "darwin" and shutil.which("launchctl"):
        return "launchd"
    if sys.platform.startswith("linux") and shutil.which("systemctl"):
        try:
            if sh("systemctl", "--user", "show-environment").returncode == 0:
                return "systemd"
        except Exception:
            pass
    return "process"


def copy_app(files: list[tuple[str, str]]) -> None:
    os.makedirs(os.path.join(APP, "collector"), exist_ok=True)
    for src, rel in files:
        dst = os.path.join(APP, rel)
        shutil.copyfile(src, dst + ".tmp")
        os.replace(dst + ".tmp", dst)
    keep = {rel for _, rel in files}
    for n in os.listdir(os.path.join(APP, "collector")):
        rel = os.path.join("collector", n)
        if n.endswith(".py") and rel not in keep:
            os.remove(os.path.join(APP, rel))
    shutil.rmtree(os.path.join(APP, "collector", "__pycache__"), ignore_errors=True)


def stop_stray() -> None:
    """Stops a collector the service manager doesn't own (an older install, a detached start)."""
    pid = running_pid()
    if pid and pid > 0:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        if not wait_for(False, 10):
            try:
                os.kill(pid, oscompat.SIGKILL)
            except OSError:
                pass
            wait_for(False, 3)


def argv() -> list[str]:
    return [sys.executable, os.path.join(APP, "collector", "umeter.py"), "run"]


def start_systemd() -> None:
    os.makedirs(os.path.dirname(UNIT), exist_ok=True)
    cmd = " ".join(f'"{a}"' if " " in a else a for a in argv())
    with open(UNIT, "w") as f:
        f.write(
            "[Unit]\n"
            "Description=usage-meter collector (Claude Code usage ledger and sync)\n"
            "After=network-online.target\n\n"
            "[Service]\n"
            f"ExecStart={cmd}\n"
            "Restart=always\n"
            "RestartSec=5\n"
            "Nice=10\n\n"
            "[Install]\n"
            "WantedBy=default.target\n"
        )
    sh("systemctl", "--user", "daemon-reload")
    sh("systemctl", "--user", "enable", UNIT_NAME)
    sh("systemctl", "--user", "stop", UNIT_NAME)
    stop_stray()
    r = sh("systemctl", "--user", "start", UNIT_NAME)
    if r.returncode != 0:
        raise RuntimeError(f"systemctl --user start failed: {(r.stderr or r.stdout).strip()[:300]}")


def plist_xml() -> str:
    args = "".join(f"<string>{a}</string>" for a in argv())
    path = f"{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>{args}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>{path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>StandardErrorPath</key><string>{LOG}</string>
  <key>StandardOutPath</key><string>{LOG}</string>
</dict>
</plist>
"""


def launchd_domain() -> str:
    return f"gui/{os.getuid()}"


def stop_launchd() -> None:
    target = f"{launchd_domain()}/{LABEL}"
    if sh("launchctl", "print", target).returncode == 0:
        sh("launchctl", "bootout", target)
        # bootstrap fails (error 5) while the old instance is still unloading
        for _ in range(20):
            if sh("launchctl", "print", target).returncode != 0:
                break
            time.sleep(0.5)


def start_launchd() -> None:
    os.makedirs(os.path.dirname(PLIST), exist_ok=True)
    with open(PLIST, "w") as f:
        f.write(plist_xml())
    stop_launchd()
    stop_stray()
    err = ""
    for _ in range(5):
        r = sh("launchctl", "bootstrap", launchd_domain(), PLIST)
        if r.returncode == 0:
            return
        err = (r.stderr or r.stdout).strip()
        time.sleep(2)
    raise RuntimeError(f"launchctl bootstrap failed: {err[:300]}")


def start_process() -> None:
    stop_stray()
    with open(LOG, "a") as log:
        oscompat.spawn_detached(argv(), log)


def stop_service(kind: str) -> None:
    if kind == "systemd" or os.path.exists(UNIT):
        if shutil.which("systemctl"):
            sh("systemctl", "--user", "disable", "--now", UNIT_NAME)
        if os.path.exists(UNIT):
            os.remove(UNIT)
            if shutil.which("systemctl"):
                sh("systemctl", "--user", "daemon-reload")
    if kind == "launchd" or os.path.exists(PLIST):
        if shutil.which("launchctl"):
            stop_launchd()
        if os.path.exists(PLIST):
            os.remove(PLIST)
    stop_stray()


def install(if_needed: bool) -> dict:
    os.makedirs(LOCAL, exist_ok=True)
    with open(os.path.join(LOCAL, "setup.lock"), "w") as guard:
        oscompat.lock(guard)  # sessions starting together take turns
        prev = load(SETUP, {})
        if if_needed and prev.get("disabled"):
            return {"action": "disabled", "message": "Auto-start is off (/burn uninstall). /burn setup turns it back on."}
        if sys.version_info < (3, 9):
            return {"action": "failed", "message": f"usage-meter needs Python 3.9 or later; python3 here is {sys.version.split()[0]}."}
        files = sources()
        stamp = stamp_of(files)
        if if_needed and running_pid() is not None and prev.get("stamp") == stamp and prev.get("python") == sys.executable:
            return {"action": "ok", "service": prev.get("service"), "stamp": stamp}
        kind = manager()
        copy_app(files)
        {"systemd": start_systemd, "launchd": start_launchd, "process": start_process}[kind]()
        if not wait_for(True, 15):
            tail = ""
            try:
                with open(LOG) as f:
                    tail = f.read()[-400:]
            except OSError:
                pass
            hint = {"systemd": "journalctl --user -u usage-meter", "launchd": LOG, "process": LOG}[kind]
            return {"action": "failed", "service": kind, "message": f"The collector didn't start; see {hint}. {tail}".strip()}
        save(SETUP, {"stamp": stamp, "service": kind, "python": sys.executable, "installedAt": int(time.time() * 1000),
                     "firstInstalledAt": prev.get("firstInstalledAt") or int(time.time() * 1000)})
        if not prev.get("stamp"):
            action = "installed"
        elif prev.get("stamp") != stamp:
            action = "updated"
        else:
            action = "started"
        return {"action": action, "service": kind, "stamp": stamp}


def uninstall() -> dict:
    os.makedirs(LOCAL, exist_ok=True)
    with open(os.path.join(LOCAL, "setup.lock"), "w") as guard:
        oscompat.lock(guard)
        prev = load(SETUP, {})
        stop_service(prev.get("service", ""))
        shutil.rmtree(APP, ignore_errors=True)
        save(SETUP, {"disabled": True, "uninstalledAt": int(time.time() * 1000)})
        return {"action": "uninstalled", "message": f"Collector stopped and removed. Your usage history is still in {ROOT}; delete that folder to remove it too."}


def configure(host: str, peers: list[str], restart: bool = True) -> dict:
    """Names this machine and its sync peers (NAME=SSH-HOST), then restarts the collector on them."""
    path = os.path.join(LOCAL, "collector.json")
    os.makedirs(LOCAL, exist_ok=True)
    cfg = load(path, {})
    if host:
        cfg["host"] = host
    if peers:
        bad = [p for p in peers if "=" not in p]
        if bad:
            return {"action": "failed", "message": f"a peer is NAME=SSH-HOST, e.g. Laptop=my-laptop (got {', '.join(bad)})"}
        cfg["peers"] = [{"name": p.split("=", 1)[0], "ssh": p.split("=", 1)[1], "dir": ".claude/usage-meter"} for p in peers]
    cfg.setdefault("peers", [])
    cfg.setdefault("syncSeconds", 20)
    save(path, cfg)
    out = {"action": "configured", "host": cfg.get("host", "(this machine's name)"), "peers": ", ".join(f"{p['name']}={p['ssh']}" for p in cfg["peers"]) or "none"}
    if restart and running_pid() is not None:
        prev = load(SETUP, {})
        if prev.get("service") == "systemd":
            sh("systemctl", "--user", "restart", UNIT_NAME)
        elif prev.get("service") == "launchd":
            sh("launchctl", "kickstart", "-k", f"{launchd_domain()}/{LABEL}")
        else:
            stop_stray()
            start_process()
    return out


def status() -> dict:
    prev = load(SETUP, {})
    pid = running_pid()
    return {
        "running": pid is not None,
        "pid": pid if pid and pid > 0 else None,
        "service": prev.get("service"),
        "upToDate": prev.get("stamp") == stamp_of(sources()),
        "disabled": bool(prev.get("disabled")),
        "data": ROOT,
    }
