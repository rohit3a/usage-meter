#!/usr/bin/env python3
"""usage-meter collector.

Turns Claude Code's session transcripts into a compact usage ledger, merges
the plan-limit readings the mod records, and syncs ledgers between machines.

Layout under ~/.claude/usage-meter:
  config.json                     shared settings (plan), synced between machines
  hosts/<host>/days/<day>.json    one file per UTC day, written only by <host>
  hosts/<host>/limits.json        plan-limit readings from <host>'s sessions
  hosts/<host>/status.json        heartbeat: last ingest, sync results
  local/collector.json            this machine's host label and sync peers
  local/state.json                read offsets (never synced)
  local/limits/<session>.json     the mod's per-session readings (inbox)

Every request row is keyed by its API message id, so re-reading a transcript
never double counts. The desktop app keeps local copies of sessions it runs on
another machine over SSH (project folders named ssh-<session>); those are
ingested with their session marked "remote", and readers keep a message from a
remote copy only when no machine recorded it as its own. Works on Python 3.9+.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import fnmatch
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import live as livemod  # noqa: E402
import view as viewmod  # noqa: E402

VERSION = 4  # bump to rebuild every ledger from the transcripts
HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, ".claude", "usage-meter")
PROJECTS = os.path.join(HOME, ".claude", "projects")
HERE = os.path.dirname(os.path.abspath(__file__))
PRICES_PATH = os.path.join(HERE, "..", "prices.json")
KEEP_DAYS = 35
LIMIT_DAYS = 9
SCAN_SECONDS = 10
SEEN_PER_FILE = 400

_stop = threading.Event()


# ------------------------------------------------------------------ helpers


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_ms(stamp: str) -> int:
    try:
        return int(dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except (ValueError, AttributeError):
        return now_ms()


def day_of(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d")


def load_json(path: str, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path: str, data) -> None:
    """Atomic: readers (the mod, rsync) never see a half-written file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def log(msg: str) -> None:
    sys.stderr.write(f"{dt.datetime.now().strftime('%H:%M:%S')} {msg}\n")
    sys.stderr.flush()


STAMP_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(-\d+)?Z?[-_ ]*")


def stream_start(path: str, st) -> int:
    """When a stream log began: the ISO timestamp its name starts with, if any."""
    m = STAMP_RE.match(os.path.basename(path))
    if m:
        stamp = m.group(0).rstrip("-_ ").rstrip("Z")
        for fmt in ("%Y-%m-%dT%H-%M-%S-%f", "%Y-%m-%dT%H-%M-%S"):
            try:
                t = dt.datetime.strptime(stamp, fmt).replace(tzinfo=dt.timezone.utc)
                return min(int(t.timestamp() * 1000), int(st.st_mtime * 1000))
            except ValueError:
                continue
    return min(now_ms(), int(st.st_mtime * 1000))


def default_host() -> str:
    return socket.gethostname().split(".")[0]


def local_config() -> dict:
    cfg = load_json(os.path.join(ROOT, "local", "collector.json"), {})
    cfg.setdefault("host", default_host())
    cfg.setdefault("peers", [])
    cfg.setdefault("syncSeconds", 20)
    return cfg


# ------------------------------------------------------------------ pricing (for reports)


class Prices:
    """List prices, with dated changes (a price applies from its UTC date on) and
    prompt-length tiers (Haiku 5.5 charges more for prompts over 100k tokens)."""

    def __init__(self) -> None:
        p = load_json(PRICES_PATH, {})
        self.models = p.get("models", [])
        self.cw5 = p.get("cacheWrite5m", 1.25)
        self.cw1 = p.get("cacheWrite1h", 2.0)
        self.fast = p.get("fast", {})
        self.web = p.get("webSearchUsd", 0.01)
        self.fallback = p.get("fallback", "claude-opus-5-5")
        self.tiers = p.get("tiers", {})
        self.changes = sorted(
            ({**c, "fromMs": iso_ms(c["from"] + "T00:00:00Z")} for c in p.get("changes", [])),
            key=lambda c: c["fromMs"],
        )
        self._cache: dict = {}

    def of(self, model: str):
        if model in self._cache:
            return self._cache[model]
        m = re.sub(r"\[.*?\]", "", (model or "").lower())
        at = m.find("claude-")
        if at > 0:
            m = m[at:]
        hit = None
        for row in self.models:
            pid = row[0]
            if m == pid or m.startswith(pid + "-") or m.startswith(pid + "@"):
                hit = row
                break
        matched = hit is not None
        if hit is None:
            hit = next((r for r in self.models if r[0] == self.fallback), ["?", model, 4, 20, 0.2])
        mult = next((v for k, v in self.fast.items() if m == k or m.startswith(k + "-")), 2)
        self._cache[model] = (hit, mult, matched)
        return self._cache[model]

    def label(self, model: str) -> str:
        row, _, matched = self.of(model)
        return row[1] if matched else (model or "unknown")

    def family(self, model: str) -> str:
        m = (model or "").lower()
        for fam, keys in (("opus", ("opus",)), ("sonnet", ("sonnet",)), ("haiku", ("haiku",)), ("fable", ("fable", "mythos"))):
            if any(k in m for k in keys):
                return fam
        return "other"

    def is_long(self, model: str, prompt: int) -> bool:
        """Whether this request is priced at its model's long-prompt tier on the API."""
        tier = self.tiers.get(self.of(model)[0][0])
        return bool(tier) and prompt > tier.get("over", 1 << 62)

    def rates(self, model: str, ts: int, prompt: int, plan: bool = False):
        """(input, output, cache read) per MTok for this model at this time and prompt size.
        plan=True ignores API-only changes: the reference the plan-limit fit is learned against."""
        row, _, _ = self.of(model)
        pin, pout, pcr = row[2], row[3], row[4]
        for c in self.changes:
            if plan and c.get("apiOnly"):
                continue
            if c["model"] == row[0] and ts >= c["fromMs"]:
                pin, pout, pcr = c.get("in", pin), c.get("out", pout), c.get("cr", pcr)
        tier = self.tiers.get(row[0])
        if tier and prompt > tier.get("over", 1 << 62):
            pin, pout, pcr = tier.get("in", pin), tier.get("out", pout), tier.get("cr", pcr)
        return pin, pout, pcr

    def usd(self, model: str, i: int, o: int, cr: int, cw5: int, cw1: int, web: int, fast: int, ts: int = 0, plan: bool = False) -> float:
        (_, mult, _) = self.of(model)
        pin, pout, pcr = self.rates(model, ts or now_ms(), i + cr + cw5 + cw1, plan)
        usd = (i * pin + o * pout + cr * pcr + cw5 * pin * self.cw5 + cw1 * pin * self.cw1) / 1e6
        if fast:
            usd *= mult
        return usd + web * self.web


# ------------------------------------------------------------------ the day ledger


class Day:
    """One UTC day of requests for this host. Rows reference id tables:
    [ts, session, prompt, agent, model, in, out, cacheRead, cacheWrite5m,
     cacheWrite1h, webSearches, fast, messageId, effort, skill, mcpServer];
    prompt/agent/effort/skill/mcpServer -1 when none."""

    def __init__(self, host: str, day: str, doc: dict | None = None) -> None:
        self.dirty = False
        self.doc = doc or {
            "v": VERSION, "host": host, "day": day, "updatedAt": 0,
            "s": [], "p": [], "a": [], "m": [], "e": [], "k": [], "x": [],
            "sessions": {}, "prompts": {}, "agents": {}, "reqs": [],
        }
        self.ix = {k: {v: i for i, v in enumerate(self.doc[k])} for k in ("s", "p", "a", "m", "e", "k", "x")}
        self.seen = {r[12] for r in self.doc["reqs"]}

    def index(self, kind: str, key: str) -> int:
        if not key:
            return -1
        hit = self.ix[kind].get(key)
        if hit is None:
            hit = len(self.doc[kind])
            self.doc[kind].append(key)
            self.ix[kind][key] = hit
        return hit

    def add(self, row: list, msg_id: str, extra: list) -> bool:
        if msg_id in self.seen:
            return False
        self.seen.add(msg_id)
        self.doc["reqs"].append(row + [msg_id] + extra)
        self.dirty = True
        return True


class Ledger:
    def __init__(self, host: str) -> None:
        self.host = host
        self.dir = os.path.join(ROOT, "hosts", host, "days")
        self.days: dict = {}

    def day(self, name: str) -> Day:
        d = self.days.get(name)
        if d is None:
            doc = load_json(os.path.join(self.dir, f"{name}.json"), None)
            if doc is not None and doc.get("v") != VERSION:
                doc = None
            d = Day(self.host, name, doc)
            self.days[name] = d
        return d

    def flush(self, titles: dict) -> int:
        n = 0
        for name, d in self.days.items():
            for sid, meta in d.doc["sessions"].items():
                title = titles.get(sid)
                if title and meta.get("title") != title:
                    meta["title"] = title
                    d.dirty = True
            if not d.dirty:
                continue
            d.doc["reqs"].sort(key=lambda r: r[0])
            d.doc["updatedAt"] = now_ms()
            write_json(os.path.join(self.dir, f"{name}.json"), d.doc)
            d.dirty = False
            n += 1
        # keep only today and yesterday in memory
        keep = {day_of(now_ms()), day_of(now_ms() - 86_400_000)}
        self.days = {k: v for k, v in self.days.items() if k in keep or v.dirty}
        return n

    def prune(self) -> None:
        cutoff = day_of(now_ms() - KEEP_DAYS * 86_400_000)
        try:
            for name in os.listdir(self.dir):
                if name.endswith(".json") and name[:-5] < cutoff:
                    os.remove(os.path.join(self.dir, name))
        except OSError:
            pass


# ------------------------------------------------------------------ transcript ingestion

COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>", re.S)
ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
TAG_RE = re.compile(r"<[^>]+>")
COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


def prompt_text(content) -> str | None:
    """The person's words for a user entry, or None when it is not a prompt."""
    if isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if not texts and not content:
            return None
        content = " ".join(texts) or "(image)"
    if not isinstance(content, str):
        return None
    text = content.strip()
    if text.startswith("<command-name>") or "<command-name>" in text[:200]:
        cmd = COMMAND_RE.search(text)
        args = ARGS_RE.search(text)
        name = cmd.group(1).strip() if cmd else "/command"
        return f"{name} {args.group(1).strip() if args else ''}".strip()
    if text.startswith("<task-notification>"):
        return "(background task finished)"
    if text.startswith("<local-command") or text.startswith("Caveat:"):
        return None
    text = COMMENT_RE.sub(" ", text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    own = [ln for ln in lines if not ln.startswith(">")]
    # a reply that quotes an earlier message: label it by the person's own words
    picked = own or [ln.lstrip("> ").strip() for ln in lines]
    text = TAG_RE.sub(" ", " ".join(picked))
    return " ".join(text.split())[:140] or None


class Collector:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.host = cfg["host"]
        self.state_path = os.path.join(ROOT, "local", "state.json")
        self.state = load_json(self.state_path, {})
        if self.state.get("v") != VERSION:
            log(f"ledger format v{VERSION}: rebuilding from transcripts")
            shutil.rmtree(os.path.join(ROOT, "hosts", self.host, "days"), ignore_errors=True)
            self.state = {"v": VERSION, "files": {}, "titles": {}, "toolOwner": {}}
        self.state.setdefault("launches", [])
        self.main_paths: dict = {}
        self.ledger = Ledger(self.host)
        self.last_ingest = 0
        self.rows_total = 0
        self.last_walk = 0.0
        self.hot: list = []

    # -- discovery

    def transcripts(self):
        """(path, session, agent, remote) for every transcript touched in KEEP_DAYS; mains first."""
        cutoff = time.time() - KEEP_DAYS * 86400
        mains, agents = [], []
        try:
            projects = list(os.scandir(PROJECTS))
        except OSError:
            return []
        for proj in projects:
            if not proj.is_dir():
                continue
            remote = proj.name.startswith("ssh-")
            try:
                entries = list(os.scandir(proj.path))
            except OSError:
                continue
            for e in entries:
                try:
                    if e.is_file() and e.name.endswith(".jsonl"):
                        if not remote:
                            self.main_paths[e.name[:-6]] = e.path
                        if e.stat().st_mtime >= cutoff:
                            mains.append((e.path, e.name[:-6], "", remote))
                    elif e.is_dir():
                        sub = os.path.join(e.path, "subagents")
                        if not os.path.isdir(sub):
                            continue
                        for a in os.scandir(sub):
                            if a.name.startswith("agent-") and a.name.endswith(".jsonl"):
                                if a.stat().st_mtime >= cutoff:
                                    agents.append((a.path, e.name, a.name[6:-6], remote))
                except OSError:
                    continue
        # nested subagents after their parents, so the parent's Agent call is known
        def depth(item):
            meta = load_json(item[0][:-6] + ".meta.json", {})
            return meta.get("spawnDepth", 1)

        agents.sort(key=depth)
        return mains + agents

    # -- reading

    def ingest(self) -> int:
        added = 0
        # full directory walk once a minute; in between only re-check files written in the last hour
        if time.time() - self.last_walk >= 60:
            todo = self.transcripts()
            self.last_walk = time.time()
            self.hot = []
            for t in todo:
                try:
                    if self.last_walk - os.stat(t[0]).st_mtime < 3600:
                        self.hot.append(t)
                except OSError:
                    pass
        else:
            todo = self.hot
        for path, sid, aid, remote in todo:
            try:
                added += self.ingest_file(path, sid, aid, remote)
            except Exception:  # one bad file never stops the rest
                log(f"could not read {path}: {traceback.format_exc(limit=1).strip()}")
        for path, src in self.stream_logs():
            try:
                added += self.ingest_stream(path, src)
            except Exception:
                log(f"could not read {path}: {traceback.format_exc(limit=1).strip()}")
        if added:
            self.last_ingest = now_ms()
            self.rows_total += added
        return added

    def ingest_file(self, path: str, sid: str, aid: str, remote: bool) -> int:
        st = os.stat(path)
        files = self.state["files"]
        fs = files.get(path)
        if fs is None or fs.get("ino") != st.st_ino or st.st_size < fs.get("off", 0):
            fs = {"ino": st.st_ino, "off": 0, "prompt": "", "seen": []}
            files[path] = fs
        if st.st_size == fs["off"]:
            return 0
        with open(path, "rb") as f:
            f.seek(fs["off"])
            data = f.read(st.st_size - fs["off"])
        end = data.rfind(b"\n")
        if end < 0:
            return 0
        fs["off"] += end + 1
        meta = load_json(path[:-6] + ".meta.json", {}) if aid else {}
        seen = set(fs["seen"])
        added = 0
        for line in data[: end + 1].splitlines():
            try:
                d = json.loads(line)
            except ValueError:
                continue
            added += self.handle(d, sid, aid, meta, fs, seen, remote)
        fs["seen"] = list(seen)[-SEEN_PER_FILE:] if len(seen) > SEEN_PER_FILE else list(seen)
        return added

    def handle(self, d: dict, sid: str, aid: str, meta: dict, fs: dict, seen: set, remote: bool) -> int:
        kind = d.get("type")
        if kind == "custom-title" and d.get("customTitle"):
            self.state["titles"][sid] = str(d["customTitle"])[:80]
            return 0
        if kind == "user":
            if d.get("isMeta") or d.get("isCompactSummary"):
                return 0
            if aid:
                # a subagent's opening message carries the prompt that spawned it
                if not fs.get("prompt") and d.get("promptId"):
                    fs["prompt"] = d["promptId"]
                return 0
            if d.get("isSidechain"):
                return 0
            text = prompt_text((d.get("message") or {}).get("content"))
            if text is None:
                return 0
            pid = d.get("promptId") or d.get("uuid") or ""
            ts = iso_ms(d.get("timestamp", ""))
            day = self.ledger.day(day_of(ts))
            if pid not in day.doc["prompts"]:
                day.doc["prompts"][pid] = {"s": sid, "text": text, "at": ts}
                day.dirty = True
            fs["prompt"] = pid
            return 0
        if kind != "assistant":
            return 0
        msg = d.get("message") or {}
        usage = msg.get("usage")
        model = msg.get("model") or ""
        msg_id = msg.get("id") or d.get("requestId") or d.get("uuid")
        if not usage or not msg_id or model == "<synthetic>":
            return 0
        # remember who made each Agent call, for nested subagents' parents
        for block in msg.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = block.get("name")
            if name in ("Agent", "Task"):
                self.state["toolOwner"][block.get("id", "")] = aid
            launch = None
            if name == "Bash" and "codex exec" in str((block.get("input") or {}).get("command", "")):
                launch = "exec"
            elif name == "mcp__t3-code__delegate_task":
                launch = "t3"
            if launch and not remote:
                self.state["launches"].append({
                    "ts": iso_ms(d.get("timestamp", "")), "sid": sid, "prompt": fs.get("prompt", ""),
                    "cwd": d.get("cwd", ""), "via": launch,
                })
                self.state["launches"] = self.state["launches"][-600:]
        if msg_id in seen:
            return 0
        seen.add(msg_id)

        agent = aid or (d.get("agentId") if d.get("isSidechain") else "") or ""
        ts = iso_ms(d.get("timestamp", ""))
        day = self.ledger.day(day_of(ts))
        cc = usage.get("cache_creation") or {}
        cw_total = int(usage.get("cache_creation_input_tokens") or 0)
        cw5 = int(cc.get("ephemeral_5m_input_tokens") or 0)
        cw1 = int(cc.get("ephemeral_1h_input_tokens") or 0)
        if cw5 + cw1 == 0 and cw_total:
            cw5 = cw_total
        web = int(((usage.get("server_tool_use") or {}).get("web_search_requests")) or 0)
        fast = 1 if usage.get("speed") == "fast" else 0

        smeta = day.doc["sessions"].get(sid)
        if smeta is None:
            day.doc["sessions"][sid] = {
                "title": self.state["titles"].get(sid, ""),
                "cwd": d.get("cwd", ""),
                "entry": d.get("entrypoint", ""),
            }
            if remote:
                day.doc["sessions"][sid]["remote"] = True
        prompt = fs.get("prompt", "")
        if agent and agent not in day.doc["agents"]:
            parent_owner = self.state["toolOwner"].get(meta.get("toolUseId", ""), "")
            day.doc["agents"][agent] = {
                "s": sid,
                "type": meta.get("agentType") or d.get("attributionAgent") or "subagent",
                "desc": str(meta.get("description") or "")[:80],
                "parent": parent_owner if parent_owner != agent else "",
                "prompt": prompt,
                "at": ts,
            }
        row = [
            ts,
            day.index("s", sid),
            day.index("p", prompt),
            day.index("a", agent),
            day.index("m", model),
            int(usage.get("input_tokens") or 0),
            int(usage.get("output_tokens") or 0),
            int(usage.get("cache_read_input_tokens") or 0),
            cw5,
            cw1,
            web,
            fast,
        ]
        extra = [
            day.index("e", str(d.get("effort") or "")),
            day.index("k", str(d.get("attributionSkill") or "")),
            day.index("x", str(d.get("attributionMcpServer") or "")),
        ]
        return 1 if day.add(row, msg_id[-14:], extra) else 0

    # -- stream-json logs (claude -p --output-format stream-json) kept by other tools

    def stream_logs(self):
        """(path, source) for each stream-json log a "streamLogs" entry of
        local/collector.json names. Runs started with --no-session-persistence
        leave no transcript, so these logs are the only record of their usage."""
        cutoff = time.time() - KEEP_DAYS * 86400
        out = []
        for src in self.cfg.get("streamLogs") or []:
            pattern = re.compile(fnmatch.translate(src.get("match", "*.jsonl")))
            for folder in src.get("dirs") or []:
                try:
                    entries = list(os.scandir(os.path.expanduser(folder)))
                except OSError:
                    continue
                for e in entries:
                    try:
                        if pattern.match(e.name) and e.is_file() and e.stat().st_mtime >= cutoff:
                            out.append((e.path, src))
                    except OSError:
                        continue
        return out

    def ingest_stream(self, path: str, src: dict) -> int:
        """A stream-json log carries each request's input and cache tokens, but
        output only as running thinking estimates; its closing result event
        has the run's exact totals per model, so a final row per model makes
        up the difference. No line has a timestamp: rows are placed between
        the file's start (its name's timestamp, else the first sighting) and
        its last write, by how far into the file they are."""
        st = os.stat(path)
        streams = self.state.setdefault("streams", {})
        fs = streams.get(path)
        if fs is None or fs.get("ino") != st.st_ino or st.st_size < fs.get("off", 0):
            fs = {"ino": st.st_ino, "off": 0, "sid": "", "start": stream_start(path, st), "think": 0,
                  "sums": {}, "ids": [], "done": False}
            streams[path] = fs
        if fs["done"] or st.st_size == fs["off"]:
            return 0
        with open(path, "rb") as f:
            f.seek(fs["off"])
            data = f.read(st.st_size - fs["off"])
        end = data.rfind(b"\n")
        if end < 0:
            return 0
        base = fs["off"]
        fs["off"] += end + 1
        start, last = fs["start"], int(st.st_mtime * 1000)
        name = os.path.basename(path)[:-6]
        run = STAMP_RE.sub("", name) or name
        seen = set(fs["ids"])
        added = 0
        pos = base
        for line in data[: end + 1].splitlines(keepends=True):
            pos += len(line)
            try:
                d = json.loads(line)
            except ValueError:
                continue
            ts = start + int((last - start) * pos / max(st.st_size, 1))
            kind = d.get("type")
            if not fs["sid"] and d.get("session_id"):
                fs["sid"] = str(d["session_id"])
            sid = fs["sid"] or name
            if kind == "system" and d.get("subtype") == "thinking_tokens":
                fs["think"] += int(d.get("estimated_tokens_delta") or 0)
                continue
            if kind == "assistant":
                msg = d.get("message") or {}
                usage, model, mid = msg.get("usage"), msg.get("model") or "", msg.get("id") or ""
                if not usage or not mid or model == "<synthetic>" or mid in seen:
                    continue
                seen.add(mid)
                out = int(usage.get("output_tokens") or 0) + fs["think"]
                fs["think"] = 0
                vals = [int(usage.get("input_tokens") or 0), out, int(usage.get("cache_read_input_tokens") or 0),
                        int(usage.get("cache_creation_input_tokens") or 0)]
                sums = fs["sums"].setdefault(model, [0, 0, 0, 0])
                for i, v in enumerate(vals):
                    sums[i] += v
                added += self.stream_row(ts, sid, run, src, model, vals, mid[-14:])
            elif kind == "result":
                for model, mu in (d.get("modelUsage") or {}).items():
                    sums = fs["sums"].get(model, [0, 0, 0, 0])
                    total = [int(mu.get("inputTokens") or 0), int(mu.get("outputTokens") or 0),
                             int(mu.get("cacheReadInputTokens") or 0), int(mu.get("cacheCreationInputTokens") or 0)]
                    rest = [max(0, t - r) for t, r in zip(total, sums)]
                    if any(rest):
                        added += self.stream_row(last, sid, run, src, model, rest, f"{sid[:8]}~{model[-5:]}")
                fs["done"] = True
                break
        fs["ids"] = list(seen)[-SEEN_PER_FILE:]
        return added

    def stream_row(self, ts: int, sid: str, run: str, src: dict, model: str, vals: list, msg_id: str) -> int:
        day = self.ledger.day(day_of(ts))
        label = src.get("label") or "claude -p"
        if sid not in day.doc["sessions"]:
            day.doc["sessions"][sid] = {"title": f"{label} · {run}"[:80], "cwd": os.path.expanduser(src.get("cwd", "")),
                                        "entry": "stream-log"}
        pid = f"run-{sid}"
        if pid not in day.doc["prompts"]:
            day.doc["prompts"][pid] = {"s": sid, "text": f"{label}: {run}"[:140], "at": ts}
            day.dirty = True
        i, o, cr, cw = vals
        # claude -p writes its prompt cache with the 1-hour lifetime
        row = [ts, day.index("s", sid), day.index("p", pid), -1, day.index("m", model), i, o, cr, 0, cw, 0, 0]
        return 1 if day.add(row, msg_id, [-1, -1, -1]) else 0

    def save_state(self) -> None:
        # drop offsets for transcripts that no longer exist
        files = self.state["files"]
        for path in [p for p in files if not os.path.exists(p)]:
            del files[path]
        streams = self.state.get("streams", {})
        for path in [p for p in streams if not os.path.exists(p)]:
            del streams[path]
        owners = self.state["toolOwner"]
        if len(owners) > 20000:
            self.state["toolOwner"] = dict(list(owners.items())[-10000:])
        write_json(self.state_path, self.state)

    # -- plan-limit readings from the mod

    def merge_limits(self) -> None:
        inbox = os.path.join(ROOT, "local", "limits")
        out_path = os.path.join(ROOT, "hosts", self.host, "limits.json")
        cutoff = now_ms() - LIMIT_DAYS * 86_400_000
        current = load_json(out_path, {"samples": []})
        samples = {(s[0], s[1]): s for s in current.get("samples", []) if s[0] >= cutoff}
        before = len(samples)
        try:
            names = os.listdir(inbox)
        except OSError:
            names = []
        for name in names:
            path = os.path.join(inbox, name)
            if not name.endswith(".json"):
                continue
            try:
                if os.stat(path).st_mtime * 1000 < cutoff:
                    os.remove(path)
                    continue
            except OSError:
                continue
            for s in load_json(path, {}).get("samples", []):
                if isinstance(s, list) and len(s) >= 4 and s[0] >= cutoff:
                    samples[(s[0], s[1])] = s[:4]
        if len(samples) != before or not os.path.exists(out_path):
            write_json(out_path, {"samples": sorted(samples.values(), key=lambda s: s[0])})


# ------------------------------------------------------------------ sync


class Syncer:
    """Pushes this host's ledger to each peer and pulls theirs back.
    Each host only ever writes its own folder, so the two directions never collide."""

    def __init__(self, cfg: dict) -> None:
        self.host = cfg["host"]
        self.peers = cfg.get("peers", [])
        self.results: dict = {}
        self.cm = os.path.join(ROOT, "local", "cm-%C")

    def ssh_args(self) -> list:
        return [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
            "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
            "-o", "ControlMaster=auto", "-o", f"ControlPath={self.cm}", "-o", "ControlPersist=300",
        ]

    def run(self, argv: list, timeout: int = 60) -> None:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError((r.stderr or r.stdout or f"exit {r.returncode}").strip().splitlines()[-1][:200])

    def sync_peer(self, peer: dict) -> None:
        target = peer["ssh"]
        remote = peer.get("dir", ".claude/usage-meter")
        ssh = self.ssh_args()
        rsh = " ".join(ssh)
        self.run(ssh + [target, f"mkdir -p {remote}/hosts/{self.host}"], timeout=30)
        base = ["rsync", "-a", "--timeout=40", "-e", rsh]
        mine = os.path.join(ROOT, "hosts", self.host) + "/"
        self.run(base + ["--delete", mine, f"{target}:{remote}/hosts/{self.host}/"])
        self.run(base + ["--delete", "--exclude", f"/{self.host}/", f"{target}:{remote}/hosts/", os.path.join(ROOT, "hosts") + "/"])
        cfg = os.path.join(ROOT, "config.json")
        if os.path.exists(cfg):
            self.run(base + [cfg, f"{target}:{remote}/config.json"])

    def sync_all(self) -> None:
        for peer in self.peers:
            name = peer.get("name", peer["ssh"])
            prev = self.results.get(name, {})
            try:
                self.sync_peer(peer)
                self.results[name] = {"ok": True, "at": now_ms(), "lastOk": now_ms()}
            except Exception as err:  # offline, asleep, ssh refused: retried next round
                self.results[name] = {"ok": False, "at": now_ms(), "lastOk": prev.get("lastOk", 0), "error": str(err)[:200]}


# ------------------------------------------------------------------ plan detection


def subscription() -> str:
    for exe in (shutil.which("claude"), os.path.join(HOME, ".local", "bin", "claude")):
        if exe and os.path.exists(exe):
            try:
                r = subprocess.run([exe, "auth", "status", "--json"], capture_output=True, text=True, timeout=30)
                return str(json.loads(r.stdout).get("subscriptionType", ""))
            except Exception:
                return ""
    return ""


# ------------------------------------------------------------------ main loop


def write_status(c: Collector, s: Syncer | None, sub: str, started: int) -> None:
    write_json(os.path.join(ROOT, "hosts", c.host, "status.json"), {
        "host": c.host,
        "version": VERSION,
        "startedAt": started,
        "updatedAt": now_ms(),
        "lastIngestAt": c.last_ingest,
        "files": len(c.state["files"]),
        "subscription": sub,
        "sync": s.results if s else {},
    })


def run(once: bool = False) -> None:
    os.makedirs(os.path.join(ROOT, "local"), exist_ok=True)
    lock = open(os.path.join(ROOT, "local", "collector.lock"), "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another collector is already running")
        sys.exit(0 if once else 1)
    # the pid lets setup.py stop a collector no service manager owns
    lock.truncate(0)
    lock.write(str(os.getpid()))
    lock.flush()
    cfg = local_config()
    c = Collector(cfg)
    s = Syncer(cfg) if cfg.get("peers") else None
    builder = viewmod.ViewBuilder(ROOT, c.host, Prices(), HOME)
    codex_path = os.path.join(ROOT, "local", "codex-state.json")
    codex = livemod.CodexReader(c.host, load_json(codex_path, {}))
    if not c.state.get("launchesBackfilled"):
        c.transcripts()  # fills main_paths
        backfill_launches(c)
        codex.relink()
        c.state["launchesBackfilled"] = True
        c.save_state()
    fleet = livemod.FleetReader(c.host)
    live_body = ""
    live_sig = None
    last_save = 0.0
    last_codex_save = 0.0
    started = now_ms()
    sub = subscription()
    last_sub = time.time()
    last_sync = 0.0
    sync_thread: threading.Thread | None = None
    last_prune = 0.0
    log(f"collector v{VERSION} on {c.host}; peers: {[p.get('name') for p in cfg.get('peers', [])]}")

    def stop(*_):
        _stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while not _stop.is_set():
        t0 = time.time()
        try:
            added = c.ingest()
            wrote = c.ledger.flush(c.state["titles"])
            # offsets are cheap to redo (every row is keyed by message id), so save them every 5 min
            if (added or wrote) and time.time() - last_save >= 300:
                c.save_state()
                last_save = time.time()
            c.merge_limits()
            if time.time() - last_prune > 3600:
                c.ledger.prune()
                last_prune = time.time()
            if time.time() - last_sub > 3600:
                sub = subscription() or sub
                last_sub = time.time()
            if s and (once or time.time() - last_sync >= cfg.get("syncSeconds", 20)):
                if sync_thread is None or not sync_thread.is_alive():
                    last_sync = time.time()
                    sync_thread = threading.Thread(target=s.sync_all, daemon=True)
                    sync_thread.start()
                    if once:
                        sync_thread.join(timeout=120)
            write_status(c, s, sub, started)
            # Codex runs, live sessions, Stop requests, then the merged live.json
            if codex.scan(c.state["launches"]) and time.time() - last_codex_save >= 15:
                write_json(codex_path, codex.root_state)
                last_codex_save = time.time()
            handle_stops(codex)
            codex.escalate()
            host_dir = os.path.join(ROOT, "hosts", c.host)
            write_if_changed(os.path.join(host_dir, "codex.json"), codex.export())
            write_if_changed(os.path.join(host_dir, "fleet.json"), {"sessions": fleet.scan(c.main_paths, c.state["titles"])})
            sig = live_inputs()
            if sig != live_sig:
                live_body = write_live(c.host, live_body)
                live_sig = sig
            refresh = os.path.join(ROOT, "local", "refresh")
            asked = os.path.exists(refresh)
            if asked:
                try:
                    os.remove(refresh)
                except OSError:
                    pass
                live_body = write_live(c.host, "")
            t1 = time.time()
            if builder.maybe_build(force=asked):
                built_ms = (time.time() - t1) * 1000
                if built_ms > 1500:
                    log(f"view took {built_ms:.0f} ms")
            if added >= 500:
                log(f"+{added} requests ({time.time() - t0:.1f}s)")
        except Exception:
            log(f"cycle failed: {traceback.format_exc(limit=3)}")
        if once:
            break
        for _ in range(SCAN_SECONDS * 4):
            if _stop.wait(0.25) or os.path.exists(os.path.join(ROOT, "local", "refresh")):
                break
    c.ledger.flush(c.state["titles"])
    c.save_state()
    write_json(codex_path, codex.root_state)
    log("collector stopped")


def backfill_launches(c) -> None:
    """Claude's past `codex exec` / delegate_task calls, from the last 3 days of
    transcripts, so runs started before this collector existed get their parent."""
    cutoff = time.time() - 3 * 86400
    found = []
    for sid, path in list(c.main_paths.items()):
        try:
            if os.path.getmtime(path) < cutoff:
                continue
            prompt = ""
            with open(path, "rb") as f:
                for raw in f:
                    if b'"promptId"' not in raw and b"codex exec" not in raw and b"delegate_task" not in raw:
                        continue
                    try:
                        d = json.loads(raw)
                    except ValueError:
                        continue
                    if d.get("type") == "user" and not d.get("isSidechain") and d.get("promptId"):
                        if prompt_text((d.get("message") or {}).get("content")) is not None:
                            prompt = d["promptId"]
                        continue
                    if d.get("type") != "assistant":
                        continue
                    for b in (d.get("message") or {}).get("content") or []:
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        via = None
                        if b.get("name") == "Bash" and "codex exec" in str((b.get("input") or {}).get("command", "")):
                            via = "exec"
                        elif b.get("name") == "mcp__t3-code__delegate_task":
                            via = "t3"
                        if via:
                            found.append({"ts": iso_ms(d.get("timestamp", "")), "sid": sid, "prompt": prompt, "cwd": d.get("cwd", ""), "via": via})
        except OSError:
            continue
    found.sort(key=lambda x: x["ts"])
    c.state["launches"] = (found + c.state.get("launches", []))[-600:]
    log(f"found {len(found)} past Codex launches")


# ------------------------------------------------------------------ live state


_written: dict = {}


def write_if_changed(path: str, data) -> bool:
    text = json.dumps(data, sort_keys=True, separators=(",", ":"))
    if _written.get(path) == text:
        return False
    write_json(path, data)
    _written[path] = text
    return True


def handle_stops(codex) -> None:
    """The mod asks to stop a Codex run by dropping local/stop/<run>.json."""
    sdir = os.path.join(ROOT, "local", "stop")
    for name in os.listdir(sdir) if os.path.isdir(sdir) else []:
        path = os.path.join(sdir, name)
        try:
            os.remove(path)
        except OSError:
            continue
        if name.endswith(".json"):
            result = codex.stop(name[:-5])
            log(f"stop {name[:-5]}: {result}")


def live_inputs():
    """mtimes of every machine's codex.json and fleet.json: live.json changes only when they do."""
    out = []
    hosts_dir = os.path.join(ROOT, "hosts")
    for h in sorted(os.listdir(hosts_dir)) if os.path.isdir(hosts_dir) else []:
        for name in ("codex.json", "fleet.json"):
            try:
                out.append(os.stat(os.path.join(hosts_dir, h, name)).st_mtime)
            except OSError:
                out.append(0)
    return tuple(out)


def write_live(host: str, prev: str) -> str:
    """Every machine's Codex runs and live sessions in one small file for the mod."""
    runs, sessions, limits = [], [], None
    hosts_dir = os.path.join(ROOT, "hosts")
    for h in sorted(os.listdir(hosts_dir)) if os.path.isdir(hosts_dir) else []:
        cx = load_json(os.path.join(hosts_dir, h, "codex.json"), {})
        for r in cx.get("runs", []):
            r["isSelf"] = h == host
            runs.append(r)
        lim = cx.get("limits")
        if lim and (not limits or lim.get("at", 0) > limits.get("at", 0)):
            limits = lim
        for e in load_json(os.path.join(hosts_dir, h, "fleet.json"), {}).get("sessions", []):
            e["isSelf"] = h == host
            sessions.append(e)
    runs.sort(key=lambda r: (r["status"] != "running", -r.get("updated", 0)))
    body = json.dumps({"codex": {"limits": limits, "runs": runs[:60]}, "fleet": sessions}, sort_keys=True, separators=(",", ":"))
    if body != prev:
        data = json.loads(body)
        data["at"] = now_ms()
        write_json(os.path.join(ROOT, "local", "live.json"), data)
    return body


# ------------------------------------------------------------------ reports


def load_days(days: int = 8):
    out = []
    cutoff = day_of(now_ms() - days * 86_400_000)
    hosts_dir = os.path.join(ROOT, "hosts")
    for host in sorted(os.listdir(hosts_dir)) if os.path.isdir(hosts_dir) else []:
        ddir = os.path.join(hosts_dir, host, "days")
        for name in sorted(os.listdir(ddir)) if os.path.isdir(ddir) else []:
            if name.endswith(".json") and name[:-5] >= cutoff:
                doc = load_json(os.path.join(ddir, name), None)
                if doc:
                    out.append(doc)
    return out


def report(args) -> None:
    prices = Prices()
    docs = load_days(args.days)
    per_host: dict = {}
    per_session: dict = {}
    since = now_ms() - args.hours * 3_600_000
    seen = set()
    passes = []
    for remote_pass in (False, True):
        for doc in docs:
            for r in doc["reqs"]:
                sid = doc["s"][r[1]]
                if bool((doc["sessions"].get(sid) or {}).get("remote")) == remote_pass:
                    passes.append((doc, r))
    for doc, r in passes:
        if r[12] in seen:
            continue
        seen.add(r[12])
        if r[0] < since:
            continue
        usd = prices.usd(doc["m"][r[4]], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[0])
        per_host[doc["host"]] = per_host.get(doc["host"], 0) + usd
        sid = doc["s"][r[1]]
        if args.session and not sid.startswith(args.session):
            continue
        title = (doc["sessions"].get(sid) or {}).get("title") or sid[:8]
        key = (doc["host"], sid, title)
        per_session[key] = per_session.get(key, 0) + usd
    print(f"last {args.hours}h at API list prices")
    for h, usd in sorted(per_host.items()):
        print(f"  {h:8} ${usd:,.2f}")
    print("top sessions")
    for (h, sid, title), usd in sorted(per_session.items(), key=lambda x: -x[1])[:15]:
        print(f"  ${usd:9,.2f}  {h:4} {sid[:8]}  {title[:60]}")
    hosts_dir = os.path.join(ROOT, "hosts")
    for host in sorted(os.listdir(hosts_dir)) if os.path.isdir(hosts_dir) else []:
        st = load_json(os.path.join(hosts_dir, host, "status.json"), {})
        age = (now_ms() - st.get("updatedAt", 0)) / 1000
        print(f"{host}: heartbeat {age:.0f}s ago, sync {json.dumps(st.get('sync', {}))}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="collect and sync until stopped")
    sub.add_parser("once", help="one collect + sync pass")
    r = sub.add_parser("report", help="spend per host and session")
    r.add_argument("--hours", type=float, default=5)
    r.add_argument("--days", type=int, default=8)
    r.add_argument("--session", default="")
    i = sub.add_parser("install", help="run the collector as a background service, on this checkout's code")
    i.add_argument("--if-needed", action="store_true", help="do nothing while a collector on the same code is running")
    u = sub.add_parser("uninstall", help="stop and remove the background service (keeps your data)")
    st = sub.add_parser("status", help="whether the collector is running and up to date")
    cf = sub.add_parser("config", help="name this machine and the machines it syncs with, over SSH")
    cf.add_argument("--host", default="", help="this machine's name in the meter, e.g. Desktop")
    cf.add_argument("--peer", action="append", default=[], help="NAME=SSH-HOST of another machine (repeat); replaces the list")
    for p in (i, u, st, cf):
        p.add_argument("--json", action="store_true", help="one line of JSON, for the mod")
    args = ap.parse_args()
    if args.cmd == "run":
        run()
    elif args.cmd == "once":
        run(once=True)
    elif args.cmd in ("install", "uninstall", "status", "config"):
        import service

        try:
            if args.cmd == "install":
                out = service.install(args.if_needed)
            elif args.cmd == "config":
                out = service.configure(args.host, args.peer)
            else:
                out = getattr(service, args.cmd)()
        except Exception as err:
            out = {"action": "failed", "message": str(err)[:400]}
        if args.json:
            print(json.dumps(out))
        else:
            print("\n".join(f"{k}: {v}" for k, v in out.items()))
        sys.exit(1 if out.get("action") == "failed" else 0)
    else:
        report(args)


if __name__ == "__main__":
    main()
