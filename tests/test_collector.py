"""Collector tests: synthetic transcripts -> ledger -> view.json, against a golden file.

Run from the repository root:
    python3 -m unittest discover -s tests -v
Refresh the golden file after an intended change to the view:
    UPDATE_GOLDEN=1 python3 -m unittest discover -s tests
Stdlib only, like the collector.
"""
from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

os.environ["TZ"] = "UTC"
time.tzset()

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLLECTOR = os.path.join(REPO, "mod", "collector")
GOLDEN = os.path.join(REPO, "tests", "golden", "view.json")
sys.path.insert(0, COLLECTOR)

import umeter  # noqa: E402
import view as viewmod  # noqa: E402

HOUR = 3_600_000
T0 = 1_792_756_800_000  # 2026-10-23T12:00:00Z
NOW = T0 + 2 * HOUR


def iso(ms: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000)) + ".000Z"


def user(ms: int, sid: str, cwd: str, text: str, pid: str) -> dict:
    return {"type": "user", "timestamp": iso(ms), "sessionId": sid, "cwd": cwd, "promptId": pid, "uuid": pid,
            "message": {"role": "user", "content": text}}


def assistant(ms: int, sid: str, cwd: str, mid: str, model: str, i=1000, o=500, cr=20_000, cw5=0, cw1=2000, **extra) -> dict:
    usage = {"input_tokens": i, "output_tokens": o, "cache_read_input_tokens": cr,
             "cache_creation_input_tokens": cw5 + cw1,
             "cache_creation": {"ephemeral_5m_input_tokens": cw5, "ephemeral_1h_input_tokens": cw1}}
    usage.update(extra.pop("usage", {}))
    d = {"type": "assistant", "timestamp": iso(ms), "sessionId": sid, "cwd": cwd,
         "message": {"id": mid, "model": model, "role": "assistant", "usage": usage, "content": []}}
    d.update(extra)
    return d


def write_jsonl(path: str, rows: list) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def make_home(home: str) -> None:
    """Two projects, three UTC days, a subagent, a duplicate, a synthetic line, a renamed session."""
    projects = os.path.join(home, ".claude", "projects")
    a_cwd, b_cwd = f"{home}/code/alpha", f"{home}/code/beta"
    a, b = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"
    rows_a = []
    for day in (2, 1, 0):
        base = T0 - day * 24 * HOUR
        pid = f"p-a-{day}"
        rows_a.append(user(base - 2 * HOUR, a, a_cwd, f"Alpha task on day -{day}", pid))
        for n in range(6):  # spread over the readings below, so several point crossings have spend between them
            rows_a.append(assistant(base - 2 * HOUR + n * 20 * 60_000 + 30_000, a, a_cwd, f"msg_a{day}{n}", "claude-opus-5-5", o=300 + 50 * n + 37 * day, cw1=12_000))
    rows_a.append(assistant(T0 + 10 * 60_000, a, a_cwd, "msg_a05", "claude-opus-5-5"))  # duplicate id: counted once
    rows_a.append(assistant(T0 + 11 * 60_000, a, a_cwd, "msg_syn", "<synthetic>"))  # never counted
    rows_a.append(assistant(T0 + 12 * 60_000, a, a_cwd, "msg_fast", "claude-opus-5-5", usage={"speed": "fast"}))
    rows_a.append({"type": "custom-title", "sessionId": a, "customTitle": "Alpha, renamed"})
    write_jsonl(os.path.join(projects, "-code-alpha", f"{a}.jsonl"), rows_a)

    rows_b = [user(T0 - HOUR, b, b_cwd, "Beta: long prompts on Haiku", "p-b-0")]
    for n in range(4):
        rows_b.append(assistant(T0 - HOUR + n * 60_000, b, b_cwd, f"msg_b{n}", "claude-haiku-5-5", i=500, cr=150_000 * (n % 2)))
        rows_b.append(assistant(T0 - HOUR + n * 60_000 + 30_000, b, b_cwd, f"msg_bs{n}", "claude-sonnet-5-5"))
    write_jsonl(os.path.join(projects, "-code-beta", f"{b}.jsonl"), rows_b)

    sub = os.path.join(projects, "-code-beta", b, "subagents")
    write_jsonl(os.path.join(sub, "agent-abc123.jsonl"),
                [assistant(T0 - HOUR + 5 * 60_000 + n * 1000, b, b_cwd, f"msg_sub{n}", "claude-sonnet-5-5", isSidechain=True)
                 for n in range(3)])
    with open(os.path.join(sub, "agent-abc123.meta.json"), "w") as f:
        json.dump({"agentType": "Explore", "description": "find callers"}, f)

    local = os.path.join(home, ".claude", "usage-meter", "local")
    os.makedirs(local, exist_ok=True)
    with open(os.path.join(local, "collector.json"), "w") as f:
        json.dump({"host": "Test", "peers": []}, f)
    # limit readings a watching session saved: whole points, crossing every ~20 minutes
    resets5, resets7 = T0 + 3 * HOUR, T0 + 4 * 24 * HOUR
    samples = []
    for n in range(12):
        ts = T0 - 2 * HOUR + n * 10 * 60_000
        samples.append([ts, "five_hour", 2 + n // 2, resets5])
        samples.append([ts, "seven_day", 10 + n // 4, resets7])
    os.makedirs(os.path.join(local, "limits"), exist_ok=True)
    with open(os.path.join(local, "limits", "sess.json"), "w") as f:
        json.dump({"sessionId": "sess", "samples": samples}, f)


def stable(view: dict) -> dict:
    """Drops what depends on the wall clock of the collector run, not on the data, and rounds
    floats to 9 significant digits (summation order follows the directory listing)."""
    def walk(x):
        if isinstance(x, float):
            return float(f"{x:.9g}")
        if isinstance(x, dict):
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x

    view = walk(json.loads(json.dumps(view)))
    for h in view.get("view", {}).get("hosts", []):
        h.pop("updatedAt", None)
    view.get("view", {}).pop("config", None)
    return view


class CollectorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.mkdtemp(prefix="umeter-test-")
        make_home(cls.home)
        env = dict(os.environ, HOME=cls.home, TZ="UTC")
        r = subprocess.run([sys.executable, os.path.join(COLLECTOR, "umeter.py"), "once"], env=env,
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            raise RuntimeError(r.stdout + r.stderr)
        cls.root = os.path.join(cls.home, ".claude", "usage-meter")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.home, ignore_errors=True)

    def builder(self) -> viewmod.ViewBuilder:
        return viewmod.ViewBuilder(self.root, "Test", umeter.Prices(), self.home)

    def build(self, b=None):
        b = b or self.builder()
        lims = b.limits()
        entries = b.load(b.day_files(NOW))
        b.dedupe(entries)
        return b.build(entries, lims, NOW)

    def test_ingest(self):
        days = os.path.join(self.root, "hosts", "Test", "days")
        reqs = []
        for name in sorted(os.listdir(days)):
            with open(os.path.join(days, name)) as f:
                reqs += json.load(f)["reqs"]
        # 18 + fast (alpha) + 8 (beta) + 3 (subagent); the duplicate and the synthetic line are dropped
        self.assertEqual(len(reqs), 30)
        self.assertEqual(len(os.listdir(days)), 3)

    def test_view_matches_golden(self):
        view, details = self.build()
        got = stable({"view": view, "details": details})
        if os.environ.get("UPDATE_GOLDEN"):
            os.makedirs(os.path.dirname(GOLDEN), exist_ok=True)
            with open(GOLDEN, "w") as f:
                json.dump(got, f, indent=1, sort_keys=True)
                f.write("\n")
        with open(GOLDEN) as f:
            want = json.load(f)
        self.assertEqual(json.dumps(got, sort_keys=True), json.dumps(want, sort_keys=True),
                         "view changed: if intended, refresh with UPDATE_GOLDEN=1")

    def test_newest_metadata_wins(self):
        view, _ = self.build()
        titles = {t["id"]: t["label"] for t in view["week"]["threads"]}
        self.assertEqual(titles["aaaaaaaa-0000-0000-0000-000000000001"], "Alpha, renamed")

    def test_pricer_matches_usd(self):
        prices = umeter.Prices()
        rnd = random.Random(7)
        models = [row[0] for row in prices.models] + ["claude-opus-5-5[1m]", "some-unknown-model"]
        stamps = [c["fromMs"] + d for c in prices.changes for d in (-1, 0, 1)] + [T0]
        for model in models:
            for ts in stamps:
                day_start = ts - ts % (24 * HOUR)
                for plan in (False, True):
                    usd = prices.pricer(model, day_start, plan)
                    for _ in range(20):
                        t = [rnd.choice([0, 10, 5000, 120_000, 400_000]) for _ in range(5)] + [rnd.randint(0, 2), rnd.randint(0, 1)]
                        want = prices.usd(model, *t, ts=day_start + 3_600_000, plan=plan)
                        self.assertAlmostEqual(usd(*t), want, places=12, msg=f"{model} {ts} {plan} {t}")

    def test_release_skips_reparse_when_unchanged(self):
        b = self.builder()
        self.assertTrue(b.maybe_build(force=True))
        b.release()
        b.last_build = 0  # an hour has passed
        self.assertFalse(b.maybe_build())
        self.assertEqual(b.entries, {})


if __name__ == "__main__":
    unittest.main()
