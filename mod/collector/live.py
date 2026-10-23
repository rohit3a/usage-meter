"""Live state for the mod: Codex runs and the fleet of Claude sessions.

CodexReader follows ~/.codex/sessions/**/rollout-*.jsonl incrementally: each run's
task, model, every command and file edit, progress notes, token counts, the
Codex plan limit, and how it ended. A run Claude launched (`codex exec` in a
Bash call, or T3 Code's delegate_task) is linked to that Claude session and
prompt. FleetReader reads Claude Code's own per-process status files
(~/.claude/sessions/<pid>.json) plus the tail of each live transcript to say
whether a session is working, waiting on the person, or done.

Both write small JSON files the collector syncs; nothing here runs inside Claude
Code. Python 3.9+.
"""
from __future__ import annotations

import datetime as dt
import glob
import json
import os
import re
import signal
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CODEX_DIR = os.path.join(HOME, ".codex", "sessions")
SESSIONS_DIR = os.path.join(HOME, ".claude", "sessions")
KEEP_RUNS_MS = 2 * 86_400_000
SHOW_RUNS_MS = 2 * 86_400_000
STALE_MS = 15 * 60_000
LONG_TOOLS = {"Bash", "Agent", "Task", "Monitor", "WebFetch", "WebSearch", "Workflow"}

CMD_RE = re.compile(r"""\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)""")


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_ms(stamp) -> int:
    if isinstance(stamp, (int, float)):
        return int(stamp * 1000) if stamp < 1e12 else int(stamp)
    try:
        return int(dt.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return now_ms()


def clip(text: str, n: int) -> str:
    one = " ".join(str(text or "").split())
    return one if len(one) <= n else one[: n - 1] + "…"


def project_of(cwd: str) -> str:
    if not cwd:
        return "?"
    cwd = cwd.replace("file://", "")
    root = cwd.split("/.claude/worktrees/")[0].rstrip("/")
    if root in ("", HOME):
        return "~ (home)"
    return os.path.basename(root) or root


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def shell_text(command) -> str:
    """The command a person would recognise, without the shell wrapper."""
    if isinstance(command, list):
        if len(command) >= 3 and command[1] in ("-lc", "-c"):
            return command[-1]
        return " ".join(str(c) for c in command)
    return str(command or "")


def code_command(code: str) -> str:
    m = CMD_RE.search(code or "")
    if not m:
        return "running a script"
    raw = m.group(1)
    if raw.startswith('"'):
        try:
            return json.loads(raw)
        except ValueError:
            return raw[1:-1]
    return raw[1:-1]


# ---------------------------------------------------------------------- Codex


class CodexReader:
    def __init__(self, host: str, state: dict) -> None:
        self.host = host
        self.root_state = state
        self.state = state.setdefault("codex", {"files": {}, "runs": {}, "limits": None})
        self.pids: dict = {}
        self.pid_scan_at = 0.0

    def files(self) -> list:
        out = []
        cutoff = time.time() - KEEP_RUNS_MS / 1000
        for back in range(0, 3):
            d = dt.date.today() - dt.timedelta(days=back)
            for path in glob.glob(os.path.join(CODEX_DIR, d.strftime("%Y/%m/%d"), "rollout-*.jsonl")):
                try:
                    if os.stat(path).st_mtime >= cutoff:
                        out.append(path)
                except OSError:
                    pass
        return out

    def scan(self, launches: list) -> bool:
        changed = False
        for path in self.files():
            try:
                changed |= self.read(path)
            except Exception as err:  # one odd file never stops the rest
                sys.stderr.write(f"codex: could not read {path}: {err}\n")
        runs = self.state["runs"]
        for rid in [r for r, run in runs.items() if now_ms() - run.get("updated", 0) > KEEP_RUNS_MS]:
            del runs[rid]
        for path in [p for p in self.state["files"] if not os.path.exists(p)]:
            del self.state["files"][path]
        changed |= self.link(launches)
        changed |= self.liveness()
        return changed

    def read(self, path: str) -> bool:
        st = os.stat(path)
        fs = self.state["files"].get(path)
        if fs is None or fs.get("ino") != st.st_ino or st.st_size < fs.get("off", 0):
            fs = {"ino": st.st_ino, "off": 0, "pending": {}}
            self.state["files"][path] = fs
        if st.st_size == fs["off"]:
            return False
        with open(path, "rb") as f:
            f.seek(fs["off"])
            data = f.read(st.st_size - fs["off"])
        end = data.rfind(b"\n")
        if end < 0:
            return False
        fs["off"] += end + 1
        rid = fs.get("run") or os.path.basename(path)[:-6]
        run = self.state["runs"].get(rid)
        if run is None:
            run = {
                "id": rid, "host": self.host, "file": path, "started": 0, "updated": 0, "ended": 0,
                "status": "idle", "origin": "", "cwd": "", "project": "?", "model": "", "tier": "",
                "task": "", "progress": "", "current": None, "currentSince": 0, "steps": [],
                "counts": {"cmds": 0, "edits": 0, "mcp": 0, "agents": 0}, "tokens": [0, 0, 0, 0],
                "final": "", "reason": "", "parent": None, "turns": 0,
            }
            self.state["runs"][rid] = run
        fs["run"] = rid
        for line in data[: end + 1].splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            self.handle(run, fs, d)
        run["updated"] = max(run["updated"], int(st.st_mtime * 1000))
        return True

    def step(self, run: dict, kind: str, text: str, ts: int, ok=None) -> None:
        run["steps"].append({"k": kind, "t": clip(text, 160), "ts": ts, "ok": ok})
        if len(run["steps"]) > 14:
            del run["steps"][: len(run["steps"]) - 14]

    def handle(self, run: dict, fs: dict, d: dict) -> None:
        kind = d.get("type")
        p = d.get("payload") or {}
        ts = iso_ms(d.get("timestamp")) if d.get("timestamp") else now_ms()
        sub = p.get("type")
        if kind == "session_meta":
            run["started"] = run["started"] or iso_ms(p.get("timestamp") or d.get("timestamp"))
            run["cwd"] = p.get("cwd", "")
            run["project"] = project_of(run["cwd"])
            o = p.get("originator") or ""
            run["origin"] = {"codex_exec": "exec", "Codex Desktop": "app"}.get(o, o)
            return
        if kind == "event_msg" and sub == "thread_settings_applied":
            ts_ = p.get("thread_settings") or {}
            run["model"] = ts_.get("model") or run["model"]
            run["tier"] = ts_.get("service_tier") or run["tier"]
            return
        if kind == "event_msg" and sub == "task_started":
            run["status"] = "running"
            run["turns"] += 1
            run["ended"] = 0
            return
        if kind == "event_msg" and sub == "task_complete":
            run["status"] = "done"
            run["final"] = clip(p.get("last_agent_message") or run["progress"], 900)
            run["ended"] = ts
            run["current"] = None
            fs["pending"] = {}
            return
        if kind == "event_msg" and sub == "turn_aborted":
            run["status"] = "stopped" if run.get("stopAsked") else "aborted"
            run["reason"] = p.get("reason") or ""
            run["ended"] = ts
            run["current"] = None
            fs["pending"] = {}
            return
        if kind == "event_msg" and sub == "token_count":
            info = (p.get("info") or {}).get("total_token_usage") or {}
            run["tokens"] = [
                int(info.get("input_tokens") or 0),
                int(info.get("cached_input_tokens") or 0),
                int(info.get("output_tokens") or 0),
                int(info.get("reasoning_output_tokens") or 0),
            ]
            rl = p.get("rate_limits")
            if rl and (not self.state["limits"] or ts >= self.state["limits"].get("at", 0)):
                self.state["limits"] = {"at": ts, **rl}
            return
        if kind == "event_msg" and sub == "item_completed":
            item = p.get("item") or {}
            it = item.get("type")
            if it == "UserMessage":
                text = " ".join(c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict))
                if not run["task"]:
                    run["task"] = clip(text, 600)
            elif it == "AgentMessage":
                text = " ".join(c.get("text", "") for c in item.get("content") or [] if isinstance(c, dict))
                if text.strip():
                    run["progress"] = clip(text, 300)
            elif it == "CommandExecution":
                code = item.get("exit_code")
                ok = None if item.get("status") not in ("completed", "failed") else (item.get("status") == "completed" and code in (None, 0))
                self.step(run, "cmd", shell_text(item.get("command")), ts, ok)
                run["counts"]["cmds"] += 1
            elif it == "FileChange":
                for path, ch in (item.get("changes") or {}).items():
                    verb = {"add": "created", "delete": "deleted"}.get((ch or {}).get("type"), "edited")
                    self.step(run, "edit", f"{verb} {os.path.basename(path)}", ts, True)
                    run["counts"]["edits"] += 1
            elif it == "McpToolCall":
                self.step(run, "mcp", f"{item.get('server', '?')} · {item.get('tool', '?')}", ts, item.get("status") == "completed")
                run["counts"]["mcp"] += 1
            elif it in ("SubAgentActivity", "CollabAgentToolCall"):
                self.step(run, "agent", item.get("description") or item.get("agent") or "sub-agent", ts, None)
                run["counts"]["agents"] += 1
            elif it == "ContextCompaction":
                self.step(run, "note", "compacted its context", ts, None)
            return
        if kind == "response_item" and sub in ("function_call", "custom_tool_call"):
            call = p.get("call_id") or p.get("id") or ""
            if sub == "function_call":
                try:
                    args = json.loads(p.get("arguments") or "{}")
                except ValueError:
                    args = {}
                text = shell_text(args.get("cmd") or args.get("command") or "") or p.get("name", "tool")
            else:
                text = code_command(p.get("input") or "")
            fs["pending"][call] = [text, ts]
            run["current"] = clip(text, 200)
            run["currentSince"] = ts
            return
        if kind == "response_item" and sub in ("function_call_output", "custom_tool_call_output"):
            fs["pending"].pop(p.get("call_id") or "", None)
            if fs["pending"]:
                text, since = list(fs["pending"].values())[-1]
                run["current"] = clip(text, 200)
                run["currentSince"] = since
            else:
                run["current"] = None
            return

    def relink(self) -> None:
        for run in self.state["runs"].values():
            if not run["parent"]:
                run["linkTried"] = 0

    def link(self, launches: list) -> bool:
        """Tie a run to the Claude session and prompt that launched it."""
        changed = False
        for run in self.state["runs"].values():
            if run["parent"] or run["origin"] not in ("exec", "T3 Code") or not run["started"]:
                continue
            if now_ms() - run["started"] > 30 * 60_000 and run.get("linkTried", 0) > 3:
                continue
            best = None
            for ln in launches:
                gap = run["started"] - ln["ts"]
                if not -5_000 <= gap <= 180_000:
                    continue
                if (ln.get("via") == "t3") != (run["origin"] == "T3 Code"):
                    continue
                score = abs(gap) - (60_000 if run["cwd"] and ln.get("cwd") and (run["cwd"].startswith(ln["cwd"]) or ln["cwd"].startswith(run["cwd"])) else 0)
                if best is None or score < best[0]:
                    best = (score, ln)
            run["linkTried"] = run.get("linkTried", 0) + 1
            if best:
                ln = best[1]
                run["parent"] = {"sid": ln["sid"], "prompt": ln.get("prompt", ""), "host": self.host}
                changed = True
        return changed

    def find_pids(self) -> dict:
        """rollout path -> pid of the Codex process writing it."""
        running = {r["file"] for r in self.state["runs"].values() if r["status"] == "running"}
        if not running:
            return {}
        out = {}
        if sys.platform.startswith("linux"):
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                try:
                    with open(f"/proc/{pid}/cmdline", "rb") as f:
                        cmd = f.read(400)
                    if b"codex" not in cmd:
                        continue
                    for fd in os.listdir(f"/proc/{pid}/fd"):
                        try:
                            target = os.readlink(f"/proc/{pid}/fd/{fd}")
                        except OSError:
                            continue
                        if target in running:
                            out[target] = int(pid)
                except OSError:
                    continue
        else:
            for path in running:
                try:
                    r = subprocess.run(["lsof", "-t", "--", path], capture_output=True, text=True, timeout=5)
                    for line in r.stdout.split():
                        if line.isdigit():
                            out[path] = int(line)
                            break
                except Exception:
                    pass
        return out

    def liveness(self) -> bool:
        # which Codex processes are alive: every 15 s is plenty
        if time.time() - self.pid_scan_at >= 15:
            self.pids = self.find_pids()
            self.pid_scan_at = time.time()
        changed = False
        for run in self.state["runs"].values():
            if run["status"] != "running":
                continue
            alive = run["file"] in self.pids
            run["pid"] = self.pids.get(run["file"])
            if now_ms() - run["updated"] > STALE_MS:
                # the desktop app keeps quiet threads open; exec runs that went
                # silent with no process left have died
                if alive and run["origin"] == "app":
                    run["status"] = "idle"
                elif not alive:
                    run["status"] = "stale"
                else:
                    continue
                run["current"] = None
                changed = True
        return changed

    def stop(self, rid: str) -> str:
        run = self.state["runs"].get(rid)
        if not run or run["status"] != "running":
            return "not running"
        pid = self.find_pids().get(run["file"])
        if not pid:
            return "no process"
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                if b"codex" not in f.read(400):
                    return "not codex"
        except OSError:
            pass  # macOS: lsof matched the run's own file
        run["stopAsked"] = now_ms()
        os.kill(pid, signal.SIGINT)
        return "stopping"

    def escalate(self) -> None:
        """A run asked to stop that's still alive after 8 s gets SIGTERM."""
        for run in self.state["runs"].values():
            asked = run.get("stopAsked")
            if asked and run["status"] == "running" and now_ms() - asked > 8000 and not run.get("termSent"):
                pid = self.find_pids().get(run["file"])
                if pid:
                    os.kill(pid, signal.SIGTERM)
                run["termSent"] = True

    def export(self) -> dict:
        runs = [
            {k: v for k, v in r.items() if k not in ("linkTried", "termSent")}
            for r in self.state["runs"].values()
            if (r["status"] == "running" or now_ms() - r["updated"] <= SHOW_RUNS_MS) and (r["task"] or r["status"] == "running")
        ]
        runs.sort(key=lambda r: (r["status"] != "running", -r["updated"]))
        return {"limits": self.state.get("limits"), "runs": runs[:60]}


# ---------------------------------------------------------------------- fleet


def tool_summary(name: str, inp: dict) -> str:
    inp = inp or {}
    if name == "Bash":
        return clip((inp.get("description") or inp.get("command") or "").splitlines()[0] if (inp.get("description") or inp.get("command")) else "a command", 90)
    if name in ("Edit", "Write", "Read", "NotebookEdit"):
        return f"{name.lower()} {os.path.basename(inp.get('file_path') or inp.get('notebook_path') or '')}"
    if name in ("Agent", "Task"):
        return f"subagent: {inp.get('description') or inp.get('subagent_type') or ''}"
    if name == "AskUserQuestion":
        qs = inp.get("questions") or []
        return clip(qs[0].get("question", "a question") if qs else "a question", 140)
    if name.startswith("mcp__"):
        parts = name.split("__")
        return f"{parts[1] if len(parts) > 1 else 'mcp'}: {parts[-1]}"
    return name


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class FleetReader:
    def __init__(self, host: str) -> None:
        self.host = host
        self.tails: dict = {}

    def scan(self, main_paths: dict, titles: dict) -> list:
        out = []
        for path in glob.glob(os.path.join(SESSIONS_DIR, "*.json")):
            s = load_json(path, None)
            if not s or not s.get("sessionId") or not s.get("pid") or not alive(int(s["pid"])):
                continue
            sid = s["sessionId"]
            entry = {
                "sid": sid, "host": self.host, "pid": s["pid"], "name": s.get("name") or titles.get(sid) or "",
                "cwd": s.get("cwd", ""), "project": project_of(s.get("cwd", "")), "entry": s.get("entrypoint", ""),
                "kind": s.get("kind", ""), "startedAt": s.get("startedAt", 0),
                "since": s.get("statusUpdatedAt") or s.get("updatedAt") or 0, "state": "idle", "detail": "",
                "lastAt": 0,
            }
            tail = self.tail(main_paths.get(sid))
            entry["lastAt"] = tail["at"]
            busy = s.get("status") == "busy"
            pending = tail["pending"]
            if not busy:
                entry["state"] = "your-turn"
                entry["detail"] = tail["text"] or "finished"
            elif pending and pending[0] in ("AskUserQuestion", "ExitPlanMode"):
                entry["state"] = "needs-you"
                entry["detail"] = pending[1] if pending[0] == "AskUserQuestion" else "a plan is ready for your approval"
            elif pending and pending[0] not in LONG_TOOLS and now_ms() - tail["at"] > 5 * 60_000:
                entry["state"] = "needs-you"
                entry["detail"] = f"probably waiting for permission: {pending[1]}"
            else:
                entry["state"] = "working"
                entry["detail"] = pending[1] if pending else (tail["action"] or "thinking")
            out.append(entry)
        out.sort(key=lambda e: e["sid"])
        return out

    def tail(self, path) -> dict:
        """The transcript's last state, re-read only when the file changed."""
        try:
            st = os.stat(path) if path else None
        except OSError:
            st = None
        if st is None:
            return {"at": 0, "pending": None, "text": "", "action": ""}
        key = (st.st_mtime, st.st_size)
        hit = self.tails.get(path)
        if hit and hit[0] == key:
            return hit[1]
        res = self.read_tail(path)
        self.tails[path] = (key, res)
        return res

    def read_tail(self, path) -> dict:
        res = {"at": 0, "pending": None, "text": "", "action": ""}
        if not path or not os.path.exists(path):
            return res
        try:
            size = os.path.getsize(path)
            res["at"] = int(os.path.getmtime(path) * 1000)
            with open(path, "rb") as f:
                f.seek(max(0, size - 262_144))
                lines = f.read().splitlines()
        except OSError:
            return res
        uses: dict = {}
        done: set = set()
        last_text = ""
        last_action = ""
        for raw in lines:
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if d.get("isSidechain"):
                continue
            t = d.get("type")
            content = (d.get("message") or {}).get("content")
            if t == "assistant" and isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use":
                        uses[b.get("id")] = (b.get("name", ""), tool_summary(b.get("name", ""), b.get("input")))
                        last_action = uses[b.get("id")][1]
                    elif b.get("type") == "text" and b.get("text", "").strip():
                        last_text = b["text"]
            elif t == "user" and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        done.add(b.get("tool_use_id"))
        open_uses = [v for k, v in uses.items() if k not in done]
        res["pending"] = open_uses[-1] if open_uses else None
        first = next((ln for ln in last_text.splitlines() if ln.strip()), "")
        res["text"] = clip(first.lstrip("#*> "), 140)
        res["action"] = last_action
        return res
