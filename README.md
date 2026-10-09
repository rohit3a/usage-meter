# usage-meter

**Where every Claude token goes, live.** A Claude Code mod that shows your plan-limit %,
tokens and API-equivalent $, split by machine, session, subagent, prompt and model,
right inside Claude Code: in the status line, a live band above the prompt, and a `/burn` pane.

- **Limit %, learned from your own data.** It fits how fast each model burns *your* plan's
  5h and weekly limits, so "budget left" is in real terms rather than guesswork.
- **API-equivalent $** for every request at list prices, cache writes by TTL, fast mode, web search.
- **Every machine in one view.** Run a collector on each box and they sync over SSH.
- **Codex too.** Follows Codex runs, links the ones Claude launched to the chat that started them, and can stop them.
- **Never double counts.** Every request is keyed by its API message id.
- **Stays fast.** A background collector does the math; the mod only redraws when the summary changes.

## Install

Needs Python 3.9+ and Claude Code (terminal or the desktop app's Code tab). Linux or macOS.

```bash
git clone https://github.com/rohit3a/usage-meter.git
cd usage-meter
deploy/install.sh
```

Then open a new Claude Code session (or run `/reload-plugins` in an open one) and type `/burn`.

`install.sh` is idempotent. It links `mod/` into `~/.claude/skills/usage-meter` so every session
loads it, and installs the collector as a systemd user service (Linux) or launchd agent (macOS).
The first run reads your existing transcripts, so history shows up right away.

### More than one machine

Name each machine and point it at the others by SSH host (anything `ssh <host>` reaches,
e.g. a Tailscale name). Key-based SSH is required; sync runs in the background.

```bash
deploy/install.sh --host Desktop --peer Laptop=my-laptop   # on the desktop
deploy/install.sh --host Laptop                             # on the laptop
```

## How it works

- **`collector/umeter.py`**: one per machine, always running (systemd user
  service on Linux, launchd agent on macOS). Reads Claude Code's transcripts
  (`~/.claude/projects/**.jsonl`) incrementally into a compact ledger, one file per
  UTC day, at `~/.claude/usage-meter/hosts/<host>/days/`. Each request is keyed by
  its API message id, so nothing is counted twice, and carries its model, effort
  level, skill and MCP server. With peers configured it syncs every 20 s over
  SSH: it pushes its own `hosts/<host>/` and pulls each peer's.
- **`collector/view.py`**: inside the collector, does all the arithmetic in its own
  process and writes `local/view.json` (about 75 KB), plus a detail file per recently
  active session in `local/sessions/`. A rebuild takes about 0.15 s and only runs
  when the ledger or the limit readings change.
- **`mod/`**: the Claude Code mod. It reads `view.json` only when it changes (a
  stat every 2 s while the pane is open), records the plan-limit readings only a
  live session sees, and draws the status line, the live band above the prompt and
  the `/burn` pane. It never crunches the ledger itself, so the UI stays responsive.
- **`collector/live.py`**: follows Codex runs (`~/.codex/sessions/**/rollout-*.jsonl`)
  and live Claude sessions (Claude Code's own `~/.claude/sessions/<pid>.json` plus
  each transcript's tail). Each machine writes `hosts/<host>/codex.json` and
  `fleet.json` (synced); the collector merges every machine's into `local/live.json`.
  A Codex run Claude started (`codex exec` in a Bash call, or T3 Code's delegate_task) is
  linked to that chat and prompt. **Stop** drops `local/stop/<run>.json`; the
  collector sends SIGINT (SIGTERM after 8 s) only to a process that is Codex *and*
  holds that run's log open.
- **`mod/prices.json`**: list prices for the collector. Cache writes are priced by
  TTL (5m 1.25×, 1h 2× input); fast mode 2× on Opus 5/5.5; web search $0.01.

### Data

```
~/.claude/usage-meter/
  config.json                    plan name and price (synced)
  local/view.json                everything the pane draws (rebuilt by the collector)
  local/sessions/<id>.json       per-session detail for "This session"
  local/live.json                Codex runs, Codex limits and live sessions, every machine
  local/refresh                  the pane's Refresh button: rebuild now
  hosts/<host>/days/<day>.json   requests; written only by <host>'s collector
  hosts/<host>/limits.json       5h / 7d limit readings
  hosts/<host>/status.json       collector heartbeat and sync results
  local/collector.json           this machine's name and sync peers
  local/state.json               transcript read offsets (rebuildable)
```

The desktop app keeps local copies of sessions it runs on another machine over SSH
(`~/.claude/projects/ssh-*` on the client). They're ingested with the session
marked `remote`. A message from a remote copy counts only when no machine
recorded it as its own, so remote sessions aren't double counted and a remote host
without a collector still shows up.

### How the % is attributed

Two meters, kept separate:

- **API-equivalent $**: every request at today's API list prices (`mod/prices.json`,
  with dated changes), so the Sonnet 5.5 cache-read cut shows up here.
- **Limit %**: how fast each model uses *your plan's* limits, learned from data.
  Anthropic reports each window in whole points. Sessions save a reading on every
  change (and every 10 minutes), so the collector knows when each point was first
  seen while someone was watching. Between two such crossings, points =
  Σ over model families (weight × plan-reference $), where plan-reference $
  ignores API-only price changes (`"apiOnly": true`; Claude Code plan limits didn't
  change with the Sonnet cut). The weights are fit by least squares, each pulled
  toward the overall rate with about one point's worth of evidence, so a family with
  no data counts like its price and one with data counts like its data.

In practice Sonnet 5.5 cache reads have measured at about 0.70× Opus per token, and a
week holds about 3.5 full 5h windows. Your own weights are learned from your own readings.

Budget left = (100 − % − 0.5) / Opus weight, shown as Opus-equivalent $. Burn = the
last fifth of the window's usage by model × its weight. "Outside Claude Code" is
only claimed when there are 3+ consistent stretches and the gap is a whole point.

## Check


```bash
systemctl --user status usage-meter          # Linux (macOS: launchctl print gui/$UID/dev.usage-meter.collector)
python3 collector/umeter.py report --hours 5 # spend per machine and session
(cd mod && claude plugin validate . && claude plugin test .)
```

Bump `VERSION` in `umeter.py` when the ledger format changes: each machine
rebuilds from its transcripts on restart (about 20 s to a minute).

## License

MIT
