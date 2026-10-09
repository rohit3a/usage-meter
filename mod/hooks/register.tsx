import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type {
  CodexRun,
  CodexWindow,
  ContextView,
  FleetEntry,
  HistoryDay,
  Live,
  Pulse,
  Scope,
  ScopeView,
  Tab,
  ThreadRow,
  Tokens,
  View,
  ViewRow,
  WindowView,
} from '../types'

// The collector (collector/umeter.py, one per machine) reads Claude Code's
// transcripts, syncs every machine's ledger and does all the arithmetic in
// its own process, writing ~/.claude/usage-meter/local/view.json. This mod
// only reads that file when it changes, records the plan-limit readings a
// live session sees, and draws. Nothing heavy runs inside Claude Code.

type $T = EngineInterface
/** ts, window kind, percent used, resetsAt (ms, 0 unknown) */
type Lim = [number, string, number, number]

const PANE = 'usage-meter'
const HEARTBEAT = 10 * 60_000
const ALERTS = [80, 90, 95]
const LABELS: Record<string, string | undefined> = { five_hour: '5h', seven_day: '7d' }
const HOST_COLORS = ['#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#8b949e']

const viewA = atom({ plugin: 'usage-meter', key: 'view' } as const, null)
const pulseA = atom({ plugin: 'usage-meter', key: 'pulse' } as const, null)
const mineA = atom({ plugin: 'usage-meter', key: 'mine' } as const, null)
const contextA = atom({ plugin: 'usage-meter', key: 'context' } as const, null)
const ccA = atom({ plugin: 'usage-meter', key: 'cc' } as const, null)
const liveA = atom({ plugin: 'usage-meter', key: 'live' } as const, null)
const tabA = atom({ plugin: 'usage-meter', key: 'tab' } as const, 'overview')
const scopeA = atom({ plugin: 'usage-meter', key: 'scope' } as const, 'window')
const expandedA = atom({ plugin: 'usage-meter', key: 'expanded' } as const, [])
const allA = atom({ plugin: 'usage-meter', key: 'isAllShown' } as const, false)
const hiddenA = atom({ plugin: 'usage-meter', key: 'isBandHidden' } as const, false)

// ---------------------------------------------------------------- files

let root = ''
let sessionId = ''
let viewMtime = -1
let mineMtime = -1
let mineFor = ''

async function initPaths($: $T): Promise<void> {
  if (!root) root = `${(await $.env.get('HOME')) ?? '.'}/.claude/usage-meter`
}

async function mtimeOf($: $T, path: string): Promise<number | null> {
  try {
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** Reads view.json and this session's detail file, only when they changed. */
async function loadView($: $T): Promise<void> {
  await initPaths($)
  const vm = await mtimeOf($, `${root}/local/view.json`)
  if (vm !== null && vm !== viewMtime) {
    try {
      const view = JSON.parse(String(await $.fs.read(`${root}/local/view.json`))) as View
      viewMtime = vm
      pulseRates = view.windows.find(w => w.kind === 'five_hour')?.rates ?? null
      await update($, viewA, () => view)
    } catch {
      // mid-replace: the next tick reads it
    }
  }
  if (!sessionId) return
  const path = `${root}/local/sessions/${sessionId}.json`
  const mm = await mtimeOf($, path)
  if (mm !== null && (mm !== mineMtime || mineFor !== sessionId)) {
    try {
      const mine = JSON.parse(String(await $.fs.read(path))) as ScopeView
      mineMtime = mm
      mineFor = sessionId
      await update($, mineA, () => mine)
    } catch {
      // try again next tick
    }
  }
}

/** live.json: Codex runs and live sessions on every machine, rewritten every few seconds. */
let pulseMtime = -1
let pulse: Pulse | null = null

async function loadPulse($: $T): Promise<void> {
  await initPaths($)
  const m = await mtimeOf($, `${root}/local/live.json`)
  if (m === null || m === pulseMtime) return
  try {
    const next = JSON.parse(String(await $.fs.read(`${root}/local/live.json`))) as Pulse
    pulseMtime = m
    pulse = next
    await update($, pulseA, () => next)
  } catch {
    // mid-replace: the next tick reads it
  }
}

/** The 5h window's learned points per plan-reference $, by model family (kept from view.json). */
let pulseRates: Record<string, number | undefined> | null = null

/** Codex calls this session has in flight (a Bash `codex exec` still running). */
let codexCalls = 0

function myRunningCodex(): CodexRun | undefined {
  return pulse?.codex.runs.find(r => r.status === 'running' && r.parent?.sid === sessionId)
}

/** Asks the collector to re-read everything now, then picks up what it writes. */
async function refreshNow($: $T): Promise<void> {
  await initPaths($)
  await $.fs.write(`${root}/local/refresh`, String(await $.clock.now()))
  for (const ms of [800, 1800, 3500]) {
    $.clock.after(ms, () => void Promise.all([loadView($), loadPulse($)]))
  }
}

async function stopCodex($: $T, run: CodexRun): Promise<void> {
  await initPaths($)
  await $.fs.write(`${root}/local/stop/${run.id}.json`, JSON.stringify({ at: await $.clock.now() }))
  $.ui.toast(`Asking Codex to stop: ${run.task.slice(0, 60)}`, { timeoutMs: 5000 })
}

// ---------------------------------------------------------------- plan-limit readings

const samples: Lim[] = []
const lastLim = new Map<string, Lim>()
const alerted = new Set<string>()
let isSamplesDirty = false
let ccUsd: number | null = null

function windowId(resetsAt: number): number {
  return Math.round(resetsAt / 600_000)
}

/** Records a reading when it changes, and every ten minutes while unchanged so
 * the collector knows the session was watching when a point was crossed. */
function recordLim($: $T, now: number, w: SessionRateLimit): void {
  const resets = w.resetsAt ? Date.parse(w.resetsAt) || 0 : 0
  const prev = lastLim.get(w.kind)
  const isSame = prev !== undefined && prev[2] === w.percentUsed && windowId(prev[3]) === windowId(resets)
  if (isSame && now - prev[0] < HEARTBEAT) return
  const row: Lim = [now, w.kind, w.percentUsed, resets]
  samples.push(row)
  if (samples.length > 3000) samples.splice(0, samples.length - 3000)
  lastLim.set(w.kind, row)
  isSamplesDirty = true
  if (isSame) return
  for (const at of ALERTS) {
    const key = `${w.kind}:${windowId(resets)}:${at}`
    if (w.percentUsed < at || alerted.has(key)) continue
    alerted.add(key)
    if (prev === undefined) continue
    const left = resets > now ? `, resets in ${fmtDur(resets - now)}` : ''
    $.ui.toast(`${LABELS[w.kind] ?? w.kind} limit at ${w.percentUsed}%${left}`, { timeoutMs: 8000 })
  }
}

async function saveSamples($: $T): Promise<void> {
  if (!isSamplesDirty || !sessionId || !root) return
  isSamplesDirty = false
  try {
    await $.fs.write(`${root}/local/limits/${sessionId}.json`, JSON.stringify({ sessionId, samples }))
  } catch (err) {
    isSamplesDirty = true
    $.ui.log(`usage-meter: could not save limit readings: ${String(err)}`, { to: 'debug' })
  }
}

async function sample($: $T): Promise<void> {
  const u = await $.session.usage()
  const now = await $.clock.now()
  if (u.cost && u.cost.usd !== ccUsd) {
    ccUsd = u.cost.usd
    await update($, ccA, () => ccUsd)
  }
  for (const w of u.rateLimits) recordLim($, now, w)
  $.ui.status(statusText())
}

function statusText(): string {
  const parts: string[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const x = lastLim.get(kind)
    if (x) parts.push(`${LABELS[kind]} ${x[2]}%`)
  }
  if (ccUsd !== null) parts.push(`${fmtUsd(ccUsd)} session`)
  return parts.length ? parts.join(' · ') : 'usage-meter'
}

/** Enough of the price list to show a turn's cost before the collector has it. */
/** planCr: the cache-read price the plan-limit weights are learned against (API-only cuts left out). */
/** prompt: tokens sent; Haiku 5.5 is priced 5x past 100k, and that gets a plan weight of its own. */
function rateCard(model: string, prompt = 0): { label: string; fam: string; in: number; out: number; cr: number; planCr: number } {
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) {
    const cr = m.includes('5-1') ? 0.25 : 1
    return { label: 'Fable', fam: 'fable', in: 10, out: 50, cr, planCr: cr }
  }
  if (m.includes('opus-5-5')) return { label: 'Opus 5.5', fam: 'opus', in: 4, out: 20, cr: 0.2, planCr: 0.2 }
  if (m.includes('opus')) return { label: 'Opus', fam: 'opus', in: 5, out: 25, cr: 0.5, planCr: 0.5 }
  if (m.includes('sonnet-4')) return { label: 'Sonnet 4.x', fam: 'sonnet', in: 3, out: 15, cr: 0.3, planCr: 0.3 }
  if (m.includes('sonnet-5-5')) return { label: 'Sonnet 5.5', fam: 'sonnet', in: 2, out: 10, cr: 0.1, planCr: 0.2 }
  if (m.includes('sonnet')) return { label: 'Sonnet', fam: 'sonnet', in: 2, out: 10, cr: 0.2, planCr: 0.2 }
  if (m.includes('haiku-5-5') && prompt > 100_000) return { label: 'Haiku 5.5', fam: 'haiku-long', in: 0.5, out: 2.5, cr: 0.05, planCr: 0.05 }
  if (m.includes('haiku-5-5')) return { label: 'Haiku 5.5', fam: 'haiku', in: 0.1, out: 0.5, cr: 0.01, planCr: 0.01 }
  if (m.includes('haiku')) return { label: 'Haiku', fam: 'haiku', in: 1, out: 5, cr: 0.1, planCr: 0.1 }
  return { label: model || 'model', fam: 'other', in: 4, out: 20, cr: 0.2, planCr: 0.2 }
}

async function computeContext($: $T): Promise<void> {
  const u = await $.session.usage({ breakdown: 'summary' })
  const b = u.context.breakdown
  if (!b) return
  const servers = new Map<string, { tokens: number; tools: number }>()
  for (const t of b.mcpTools) {
    if (!t.isLoaded) continue
    const s = servers.get(t.serverName) ?? { tokens: 0, tools: 0 }
    s.tokens += t.tokens
    s.tools += 1
    servers.set(t.serverName, s)
  }
  const p = rateCard(await $.session.model())
  const resend = u.context.tokens ?? null
  const ctx: ContextView = {
    model: p.label,
    total: b.totalTokens,
    max: b.rawMaxTokens,
    categories: b.categories
      .filter(c => c.kind === 'used' && c.tokens > 0)
      .sort((a, c) => c.tokens - a.tokens)
      .map(c => ({ name: c.name, tokens: c.tokens })),
    mcp: [...servers.entries()]
      .map(([server, s]) => ({ server, ...s }))
      .sort((a, c) => c.tokens - a.tokens)
      .slice(0, 8),
    resend,
    readUsd: resend === null ? null : (resend * p.cr) / 1e6,
    writeUsd: resend === null ? null : (resend * p.in * 2) / 1e6,
  }
  await update($, contextA, () => ctx)
}

// ---------------------------------------------------------------- live turn (band)

let live: Live | null = null
let liveTurn = ''
let mainTurn = ''
const agentTurn = new Map<string, string>()
const agentLabel = new Map<string, string>()
const liveAgents = new Map<string, { label: string; usd: number; isRunning: boolean }>()

async function pushLive($: $T): Promise<void> {
  if (!live) return
  const agents = [...liveAgents.values()].sort((a, b) => b.usd - a.usd).slice(0, 6)
  const copy: Live = { ...live, tok: [live.tok[0], live.tok[1], live.tok[2], live.tok[3]], agents: agents.map(a => ({ ...a })) }
  await update($, liveA, () => copy)
}

// ---------------------------------------------------------------- formatting

function fmtTok(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

function fmtUsd(n: number): string {
  if (n < 100) return `$${n.toFixed(2)}`
  if (n < 10_000) return `$${Math.round(n).toLocaleString('en-US')}`
  return `$${(n / 1000).toFixed(1)}k`
}

/** Estimated shares of a limit: never shown more precisely than the data allows. */
function fmtShare(n: number | null): string {
  if (n === null) return ''
  if (n < 0.1) return '<0.1%'
  return `≈${n < 10 ? n.toFixed(1) : Math.round(n)}%`
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const hours = Math.floor(m / 60)
  if (hours < 48) return `${hours}h ${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function sumTok(t: Tokens): number {
  return t[0] + t[1] + t[2] + t[3]
}

/** Tokens with what they mostly are: a turn's millions are the context re-read from cache. */
function tokText(t: Tokens): string {
  const total = sumTok(t)
  const cached = total > 0 ? Math.round((t[2] / total) * 100) : 0
  return `${fmtTok(total)} tok${cached >= 50 ? ` (${cached}% cached)` : ''}`
}

function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= n) return one
  const cut = one.slice(0, Math.max(1, n - 1))
  const space = cut.lastIndexOf(' ')
  return `${space > n * 0.6 ? cut.slice(0, space) : cut}…`
}

function pctColor(pct: number): string {
  return pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'
}

function svgBar(pct: number): string {
  const fill = pct >= 90 ? '#f85149' : pct >= 70 ? '#d29922' : '#3fb950'
  const w = Math.max(0, Math.min(500, (pct / 100) * 500))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 10" width="2000" height="40" preserveAspectRatio="none">` +
    `<rect width="500" height="10" rx="5" fill="#8b949e" fill-opacity="0.22"/>` +
    (w > 0 ? `<rect width="${Math.max(10, w).toFixed(1)}" height="10" rx="5" fill="${fill}"/>` : '') +
    `</svg>`
  )
}

function svgHistory(days: HistoryDay[], hosts: string[]): string {
  const max = Math.max(1, ...days.map(d => d.total))
  const width = 700
  const height = 150
  const pad = 22
  const bw = width / Math.max(1, days.length)
  let out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height + pad}" width="${width}" height="${height + pad}">`
  days.forEach((d, i) => {
    let y = height
    hosts.forEach((host, j) => {
      const usd = d.hosts[host] ?? 0
      if (usd <= 0) return
      const bar = (usd / max) * (height - 8)
      y -= bar
      out += `<rect x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${bar.toFixed(1)}" rx="3" fill="${HOST_COLORS[j % HOST_COLORS.length]}"/>`
    })
    if ((days.length - 1 - i) % 2 === 0) {
      out += `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${height + 16}" font-size="13" text-anchor="middle" fill="#8b949e" font-family="system-ui">${d.label.split(' ')[1] ?? ''}</text>`
    }
  })
  return `${out}</svg>`
}

function paceLine(w: WindowView, now: number): { text: string; isBad: boolean } {
  if (w.isReset) return { text: 'reset · waiting for the next reading', isBad: false }
  const parts = [w.resetsAt ? `${fmtDur(w.resetsAt - now)} left` : '']
  if (w.usdLeft !== null && w.usdLeft > 0) parts.push(`≈${fmtUsd(w.usdLeft)} to go`)
  let isBad = false
  if (w.fullAt !== null && w.resetsAt !== null && w.fullAt < w.resetsAt) {
    parts.push(`runs out in ~${fmtDur(w.fullAt - now)}`)
    isBad = true
  } else if (w.atReset !== null) {
    parts.push(`~${Math.round(w.atReset)}% at reset`)
  }
  return { text: parts.filter(Boolean).join(' · '), isBad }
}

/** What the "outside Claude Code" check found, in plain words. */
const OUTSIDE: Record<WindowView['outside'], string> = {
  unknown: 'Usage outside Claude Code (claude.ai, phone): too early to tell',
  none: '✓ Claude Code accounts for all of this limit',
  some: 'The rest came from outside Claude Code: claude.ai, the phone app or Cowork',
}

const CONFIDENCE: Record<string, string | undefined> = {
  none: 'no estimate yet',
  rough: 'rough estimate',
  low: 'low confidence',
  medium: 'medium confidence',
  high: 'high confidence',
}

function summaryText(v: View | null, now: number): string {
  if (!v) return 'No usage data yet: the collector writes it within seconds of starting.'
  const lines = v.windows.map(w => `${w.label} limit ${w.pct}% · ${paceLine(w, now).text}`)
  lines.push(`5h window ${fmtUsd(v.window.usd)} · last 30 days ${fmtUsd(v.monthUsd)}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await initPaths($)
    sessionId = await $.session.id()
    await $.command.register({
      name: 'burn',
      description: 'Usage meter: plan limits, budget left, and where every token went',
      argumentHint: '[text|band]',
      immediate: true,
    })
    // Cheap: a stat or two. Reads view.json only when the collector rewrote it.
    let tick = 0
    $.clock.every(2000, () => {
      tick += 1
      void (async () => {
        const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
        if (isOpen || tick % 15 === 0) await loadView($)
        const isCodexLive = codexCalls > 0 || myRunningCodex() !== undefined
        if (isOpen || isCodexLive || tick % 15 === 0) await loadPulse($)
        if (isCodexLive || isOpen) $.ui.invalidate('ui.render')
        if (isOpen && tick % 5 === 0 && (await read($, tabA)) === 'context') await computeContext($)
        if (tick % 2 === 0) await saveSamples($)
      })()
    })
    void sample($).then(() => Promise.all([loadView($), loadPulse($)]))

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    mainTurn = e.turnId
    liveTurn = e.turnId
    liveAgents.clear()
    live = { turnId: e.turnId, startedAt: now, endedAt: null, usd: 0, tok: [0, 0, 0, 0], reqs: 0, agents: [] }
    await pushLive($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const turn = (e.parentAgentId ? agentTurn.get(e.parentAgentId) : undefined) ?? mainTurn
      agentTurn.set(r.agentId, turn)
      const label = e.description ? `${e.subagentType}: ${e.description}` : e.subagentType || 'subagent'
      agentLabel.set(r.agentId, label)
      if (turn === liveTurn && live) {
        liveAgents.set(r.agentId, { label, usd: 0, isRunning: true })
        await pushLive($)
      }
    }

    return r
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      const u = r.usage
      if (u) {
        const turn = e.agentId ? (agentTurn.get(e.agentId) ?? mainTurn) : e.turnId
        if (live && turn === liveTurn) {
          const p = rateCard(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
          const rest = (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_creation_input_tokens * p.in * 2) / 1e6
          const usd = rest + (u.cache_read_input_tokens * p.cr) / 1e6
          const planUsd = rest + (u.cache_read_input_tokens * p.planCr) / 1e6
          const k5 = pulseRates?.[p.fam] ?? pulseRates?.opus
          live.usd += usd
          if (k5 !== undefined) live.pts = (live.pts ?? 0) + planUsd * k5
          live.tok[0] += u.input_tokens
          live.tok[1] += u.output_tokens
          live.tok[2] += u.cache_read_input_tokens
          live.tok[3] += u.cache_creation_input_tokens
          live.reqs += 1
          if (e.agentId) {
            const cur = liveAgents.get(e.agentId)
            liveAgents.set(e.agentId, {
              label: cur?.label ?? agentLabel.get(e.agentId) ?? 'subagent',
              usd: (cur?.usd ?? 0) + usd,
              isRunning: cur?.isRunning ?? true,
            })
          }
          await pushLive($)
        }
        await sample($)
      }
    } catch (err) {
      $.ui.log(`usage-meter: live update failed: ${String(err)}`, { to: 'debug' })
    }

    return r
  })

  // A Bash call that runs `codex exec`: the band follows that Codex run live.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!/\bcodex\s+exec\b/.test(e.command)) return next(e)
    codexCalls += 1
    try {
      return await next(e)
    } finally {
      codexCalls = Math.max(0, codexCalls - 1)
      void loadPulse($)
    }
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId) {
      const cur = liveAgents.get(e.agentId)
      if (cur) {
        cur.isRunning = false
        await pushLive($)
      }
    } else if (live && live.turnId === e.turnId) {
      live.endedAt = now
      await pushLive($)
      void saveSamples($)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.cost && e.cost.usd !== ccUsd) {
      ccUsd = e.cost.usd
      await update($, ccA, () => ccUsd)
    }
    for (const w of e.rateLimits) recordLim($, now, w)
    $.ui.status(statusText())

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await saveSamples($)
    if (e.reason === 'clear') {
      live = null
      liveTurn = ''
      liveAgents.clear()
      sessionId = ''
      ccUsd = null
    }

    return next(e)
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    if (!sessionId) sessionId = await $.session.id()
    const arg = e.args.trim()
    if (arg === 'band') {
      const isHidden = await read($, hiddenA)
      await update($, hiddenA, () => !isHidden)
      return { text: isHidden ? 'Band shown.' : 'Band hidden.' }
    }
    await Promise.all([loadView($), loadPulse($)])
    if (arg === 'text') return { text: summaryText(await read($, viewA), await $.clock.now()) }
    const opened = await $.ui.open({ id: PANE, title: 'Usage' })
    if (!opened.isPlaced) return { text: summaryText(await read($, viewA), await $.clock.now()) }

    return {}
  })

  // ---- the band above the prompt: this turn's burn, and Codex when it's running for this chat

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenA))) return next(e)
    const lv = await read($, liveA)
    const p = await read($, pulseA)
    const run = p?.codex.runs.find(r => r.status === 'running' && r.parent?.sid === sessionId)
    const v = await read($, viewA)
    if (!lv && !run && !v) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    const W = e.props.bodyColumns

    let turnRow: JSX.Element | null = null
    if (lv) {
      const isWorking = lv.endedAt === null
      const r5 = v?.windows.find(w => w.kind === 'five_hour')?.rate ?? null
      const running = lv.agents.filter(a => a.isRunning).length
      // each request re-sends the whole conversation: its average size is the context
      const context = lv.reqs > 0 ? (lv.tok[0] + lv.tok[2] + lv.tok[3]) / lv.reqs : 0
      const parts = [
        isWorking ? '● this turn' : 'last turn',
        fmtUsd(lv.usd),
        `${lv.reqs} request${lv.reqs === 1 ? '' : 's'}`,
        tokText(lv.tok),
        context >= 300_000 ? `context ${fmtTok(context)}` : '',
        lv.pts !== undefined ? `${fmtShare(lv.pts)} of 5h` : r5 === null ? '' : `${fmtShare(lv.usd * r5)} of 5h`,
        lv.agents.length ? `${lv.agents.length} subagent${lv.agents.length === 1 ? '' : 's'}${running ? ` (${running} running)` : ''}` : '',
      ].filter(Boolean)
      turnRow = (
        <Box flexDirection="row" width={W}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor={!isWorking} wrap="truncate-end">
              {parts.join(' · ')}
            </Text>
          </Box>
          <Button key="details" label="details" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Usage' })} />
          <Text> </Text>
          <Button key="hide" label="hide" plain dimColor onPress={() => void update($, hiddenA, () => true)} />
        </Box>
      )
    }

    let codexRow: JSX.Element | null = null
    if (run) {
      const doing = run.current ? `▶ ${run.current}` : run.progress || 'thinking'
      const line = `◆ Codex · ${doing}`
      const meta = ` · ${fmtDur(now - (run.started || now))} · ${fmtTok(run.tokens[0] + run.tokens[2])} tok`
      codexRow = (
        <Box flexDirection="row" width={W}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color="cyan" wrap="truncate-end">
              {clip(line, Math.max(20, W - meta.length - 16))}
              <Text dimColor>{meta}</Text>
            </Text>
          </Box>
          <Button
            key="codex-watch"
            label="watch"
            plain
            dimColor
            onPress={() => void update($, tabA, () => 'codex').then(() => $.ui.open({ id: PANE, title: 'Usage' }))}
          />
          {run.isSelf && <Text> </Text>}
          {run.isSelf && <Button key="codex-stop" label="stop" plain dimColor onPress={() => void stopCodex($, run)} />}
        </Box>
      )
    }

    // Before the first turn: a slim meter, so the analysis is always one click away
    // (the status line is plain text and can't be clicked).
    let meterRow: JSX.Element | null = null
    if (!turnRow && v) {
      const cw = p?.codex.limits?.primary
      const cc = await read($, ccA)
      const parts = [
        ...v.windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day').map(w => `${w.label} ${w.pct}%`),
        cw ? `Codex ${Math.round(cw.used_percent)}%` : '',
        cc !== null ? `${fmtUsd(cc)} session` : '',
      ].filter(Boolean)
      meterRow = (
        <Box flexDirection="row" width={W}>
          <Box flexGrow={1} flexShrink={1}>
            <Text dimColor wrap="truncate-end">
              {parts.join(' · ')}
            </Text>
          </Box>
          <Button key="details" label="open usage" plain dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Usage' })} />
          <Text> </Text>
          <Button key="hide" label="hide" plain dimColor onPress={() => void update($, hiddenA, () => true)} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={W}>
        {codexRow}
        {turnRow ?? meterRow}
      </Box>
    )
  })

  // ---- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    // chosen by surface: the terminal draws no Svg and the mobile app no Select
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const Select = e.surface !== 'mobile' && 'Select' in els ? els.Select : undefined
    const v = await read($, viewA)
    const W = Math.max(28, e.props.bodyColumns)

    if (!v) {
      return (
        <Box flexDirection="column" width={W}>
          <Text bold>Starting up</Text>
          <Text dimColor wrap="wrap">
            Waiting for the collector's first summary. If this stays, the collector isn't running: see the README at github.com/rohit3a/usage-meter.
          </Text>
        </Box>
      )
    }
    const tab = await read($, tabA)
    const scope = await read($, scopeA)
    const now = await $.clock.now()

    // ---- building blocks. Proportional fonts on the desktop: alignment comes
    // from flex boxes, never from spaces.
    const Line = (p: { left: string; right?: string; bold?: boolean; dim?: boolean; color?: string; indent?: number; rightDim?: boolean }) => (
      <Box flexDirection="row" width={W - (p.indent ?? 0)} marginLeft={p.indent ?? 0}>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold={p.bold} dimColor={p.dim} wrap="truncate-end">
            {p.left}
          </Text>
        </Box>
        {p.right !== undefined && (
          <Box flexShrink={0} marginLeft={1}>
            <Text bold={p.bold} dimColor={p.rightDim ?? p.dim} color={p.color}>
              {p.right}
            </Text>
          </Box>
        )}
      </Box>
    )
    const Note = (p: { text: string; color?: string; indent?: number; wrap?: boolean }) => (
      <Box width={W - (p.indent ?? 0)} marginLeft={p.indent ?? 0}>
        <Text dimColor={!p.color} color={p.color} wrap={p.wrap ? 'wrap' : 'truncate-end'}>
          {p.text}
        </Text>
      </Box>
    )
    const Section = (p: { title: string; right?: string }) => (
      <Box flexDirection="column" marginTop={1}>
        <Line left={p.title.toUpperCase()} right={p.right} bold dim rightDim={false} />
      </Box>
    )
    const Bar = (p: { pct: number }) =>
      Svg ? (
        <Box width={W}>
          <Svg source={svgBar(p.pct)} alt={`${p.pct}% used`} />
        </Box>
      ) : (
        <Text color={pctColor(p.pct)}>
          {'━'.repeat(Math.max(0, Math.min(W, Math.round((p.pct / 100) * W)))) +
            '─'.repeat(Math.max(0, W - Math.round((p.pct / 100) * W)))}
        </Text>
      )
    const share = (row: ViewRow) => fmtShare(scope === 'week' ? row.p7 : row.p5)
    const meta = (row: ViewRow) =>
      [share(row), tokText(row.tok), row.ms > 0 ? fmtDur(row.ms) : '', row.sub].filter(Boolean).join(' · ')
    const Row = (p: { row: ViewRow }) => (
      <Box flexDirection="column">
        <Line left={p.row.label} right={fmtUsd(p.row.usd)} />
        <Note text={meta(p.row)} />
      </Box>
    )
    const Compact = (p: { row: ViewRow; total: number }) => (
      <Line left={p.row.label} right={`${fmtUsd(p.row.usd)} · ${p.total > 0 ? Math.round((p.row.usd / p.total) * 100) : 0}%`} rightDim={false} />
    )

    const Para = (p: { text: string; indent?: number }) => (
      <Box width={W - (p.indent ?? 0)} marginLeft={p.indent ?? 0}>
        <Text wrap="wrap">{p.text}</Text>
      </Box>
    )
    const stepIcon = (k: string, ok: boolean | null) =>
      k === 'cmd' ? (ok === false ? '✕' : '$') : k === 'edit' ? '✎' : k === 'mcp' ? '⚙' : k === 'agent' ? '↳' : '·'
    const statusIcon: Record<CodexRun['status'], string> = { running: '●', done: '✓', aborted: '✕', stopped: '⏹', stale: '⚠', idle: '○' }
    const statusWord: Record<CodexRun['status'], string> = {
      running: 'running', done: 'finished', aborted: 'interrupted', stopped: 'stopped by you', stale: 'stopped responding', idle: 'idle',
    }
    const originOf = (r: CodexRun) =>
      r.origin === 'exec' ? (r.parent ? 'started by Claude' : 'codex exec') : r.origin === 'app' ? 'Codex app' : r.origin || 'Codex'

    // ---- header: the limits, always on top
    const limits = v.windows.map(w => {
      const pace = paceLine(w, now)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Line left={`${w.label} limit`} right={`${w.pct}%`} bold color={pctColor(w.pct)} />
          <Bar pct={w.pct} />
          <Note text={pace.text} color={pace.isBad ? 'red' : undefined} />
        </Box>
      )
    })

    // ---- navigation: one row of dropdowns where the surface has them
    const tabs: [Tab, string][] = [
      ['overview', 'Overview'],
      ['sessions', 'Sessions'],
      ['codex', 'Codex'],
      ['threads', 'Threads'],
      ['tasks', 'Tasks'],
      ['breakdown', 'Breakdown'],
      ['history', 'History'],
      ['accuracy', 'Accuracy'],
      ['context', 'Context'],
    ]
    const scopes: [Scope, string][] = [
      ['window', '5h window'],
      ['week', '7 days'],
      ['session', 'This session'],
    ]
    const usesScope = tab === 'threads' || tab === 'tasks' || tab === 'breakdown'
    // a long list shown in full folds back when the view or the scope changes
    const pickTab = (t: string) => {
      void update($, allA, () => false)
      void update($, tabA, () => t as Tab).then(() => (t === 'context' ? computeContext($) : loadView($)))
    }
    const pickScope = (x: string) => {
      void update($, allA, () => false)
      void update($, scopeA, () => x as Scope)
    }
    const age = Math.max(0, now - Math.max(v.builtAt, (await read($, pulseA))?.at ?? 0))
    const refresh = (
      <Box flexDirection="row" flexShrink={0} marginLeft={1}>
        <Text dimColor>{age < 10_000 ? 'now ' : `${fmtDur(age)} ago `}</Text>
        <Button key="refresh" label="↻ Refresh" plain onPress={() => void refreshNow($)} />
      </Box>
    )
    const nav = Select ? (
      <Box flexDirection="row" width={W} flexWrap="wrap">
        <Box marginRight={2}>
          <Select key="tab" options={tabs.map(([value, label]) => ({ value, label }))} value={tab} onSelect={pickTab} />
        </Box>
        {usesScope && <Select key="scope" options={scopes.map(([value, label]) => ({ value, label }))} value={scope} onSelect={pickScope} />}
        <Box flexGrow={1} />
        {refresh}
      </Box>
    ) : (
      <Box flexDirection="column" width={W}>
        <Box flexDirection="row" flexWrap="wrap">
          {tabs.map(([t, label]) => (
            <Button key={`tab-${t}`} label={label} plain variant={t === tab ? 'primary' : undefined} dimColor={t !== tab} onPress={() => pickTab(t)} />
          ))}
        </Box>
        {refresh}
        {usesScope && (
          <Box flexDirection="row" flexWrap="wrap">
            {scopes.map(([x, label]) => (
              <Button key={`scope-${x}`} label={label} plain variant={x === scope ? 'primary' : undefined} dimColor={x !== scope} onPress={() => pickScope(x)} />
            ))}
          </Box>
        )}
      </Box>
    )

    // ---- Codex's own plan limit, and the live sessions at a glance
    const pl = await read($, pulseA)
    const cl = pl?.codex.limits
    const cwLabel = (cw: CodexWindow) =>
      cw.window_minutes >= 10_000 ? 'week' : cw.window_minutes === 300 ? '5h' : `${Math.round(cw.window_minutes / 60)}h`
    const credits = cl?.credits?.balance ? Math.round(Number(cl.credits.balance)) : null
    const codexHeader = [cl?.primary, cl?.secondary]
      .filter((cw): cw is CodexWindow => !!cw)
      .map(cw => (
        <Box flexDirection="column" marginBottom={1}>
          <Line left={`Codex ${cwLabel(cw)}`} right={`${Math.round(cw.used_percent)}%`} bold color={pctColor(cw.used_percent)} />
          <Bar pct={cw.used_percent} />
          <Note
            text={[
              `${fmtDur(cw.resets_at * 1000 - now)} left`,
              cl?.plan_type ? `${cl.plan_type[0]?.toUpperCase() ?? ''}${cl.plan_type.slice(1)} plan` : '',
              credits !== null ? `${credits.toLocaleString('en-US')} credits` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        </Box>
      ))
    const fleet: FleetEntry[] = pl?.fleet ?? []
    const count = (state: FleetEntry['state']) => fleet.filter(f => f.state === state).length
    const codexRunning = (pl?.codex.runs ?? []).filter(r => r.status === 'running')
    const summary = [
      count('needs-you') ? `${count('needs-you')} need you` : '',
      count('working') ? `${count('working')} working` : '',
      count('your-turn') ? `${count('your-turn')} your turn` : '',
      codexRunning.length ? `${codexRunning.length} Codex` : '',
    ].filter(Boolean)
    const fleetSummary =
      summary.length > 0 ? (
        <Box marginBottom={1}>
          <Button
            key="fleet-summary"
            label={`Sessions: ${summary.join(' · ')}`}
            plain
            variant={count('needs-you') ? 'primary' : undefined}
            onPress={() => pickTab('sessions')}
          />
        </Box>
      ) : null

    const mine = await read($, mineA)
    const scoped: ScopeView | null = scope === 'session' ? mine : scope === 'week' ? v.week : v.window
    const cc = await read($, ccA)
    const mineUsd = mine?.usd ?? v.sessionUsd[sessionId] ?? null
    const ccCheck =
      cc === null || mineUsd === null
        ? null
        : Math.abs(cc - mineUsd) <= Math.max(0.05, cc * 0.03)
          ? '✓ matches Claude Code’s own total'
          : cc > mineUsd
            ? `Claude Code says ${fmtUsd(cc)} (collector catching up)`
            : `Claude Code says ${fmtUsd(cc)}`
    const w5 = v.windows.find(w => w.kind === 'five_hour')
    const scopeTitle = scope === 'session' ? 'this session' : scope === 'week' ? 'last 7 days' : '5h window'

    let body: JSX.Element
    if (tab === 'overview') {
      const machines = v.window.dims.machines ?? []
      const plan = v.config.plan
      const value = plan?.usdPerMonth
        ? `${plan.name ?? 'Plan'} · ${(v.monthUsd / plan.usdPerMonth).toFixed(1)}× its ${fmtUsd(plan.usdPerMonth)}/mo price`
        : (plan?.name ?? '')
      body = (
        <Box flexDirection="column">
          <Section title="Where the 5h window went" right={fmtUsd(v.window.usd)} />
          {machines.length === 0 && <Note text="Nothing in this window yet." />}
          {machines.map(row => (
            <Line left={row.label} right={`${fmtUsd(row.usd)}${row.p5 !== null ? ` · ${fmtShare(row.p5)}` : ''}`} rightDim={false} />
          ))}
          {w5?.outside === 'some' && w5.untrackedPct !== null && (
            <Line left="Outside Claude Code" right={fmtShare(w5.untrackedPct)} rightDim={false} />
          )}
          {w5 && <Note text={OUTSIDE[w5.outside]} wrap />}
          {w5?.rate ? <Note text={`1% of 5h ≈ ${fmtUsd(1 / w5.rate)} of Opus usage · ${CONFIDENCE[w5.confidence] ?? ''}`} /> : null}

          <Section title="This session" right={mineUsd !== null ? fmtUsd(mineUsd) : undefined} />
          {mine ? <Note text={`${mine.reqs} requests · ${tokText(mine.tok)}`} /> : <Note text="Appears after its first response." />}
          {ccCheck && <Note text={ccCheck} />}

          <Section title="Top tasks · 5h" />
          {v.window.tasks.length === 0 && <Note text="none yet" />}
          {v.window.tasks.slice(0, 4).map(row => (
            <Row row={row} />
          ))}

          <Section title="Last 30 days" right={fmtUsd(v.monthUsd)} />
          {value && <Note text={value} />}
          <Note text="value at API list prices" />
        </Box>
      )
    } else if (tab === 'sessions') {
      const groups: [FleetEntry['state'], string][] = [
        ['needs-you', 'Needs you'],
        ['working', 'Working'],
        ['your-turn', 'Your turn'],
      ]
      body = (
        <Box flexDirection="column">
          {fleet.length === 0 && <Note text="No live Claude sessions found." />}
          {groups.map(([state, title]) => {
            const rows = fleet.filter(f => f.state === state).sort((a, b) => b.since - a.since)
            if (rows.length === 0) return null
            return (
              <Box flexDirection="column">
                <Section title={`${title} · ${rows.length}`} />
                {rows.map(f => {
                  const usd = v.sessionUsd[f.sid]
                  const age =
                    state === 'working' ? `working ${fmtDur(now - f.since)}` : state === 'needs-you' ? `waiting ${fmtDur(now - f.since)}` : `idle ${fmtDur(now - f.since)}`
                  return (
                    <Box flexDirection="column" marginTop={1}>
                      <Line left={`${f.sid === sessionId ? '◉ ' : ''}${f.name || f.project}`} right={usd !== undefined ? fmtUsd(usd) : undefined} bold rightDim />
                      <Note text={f.detail} color={state === 'needs-you' ? 'yellow' : undefined} />
                      <Note text={[f.host, f.project, age].join(' · ')} />
                    </Box>
                  )
                })}
              </Box>
            )
          })}
          {codexRunning.length > 0 && (
            <Box flexDirection="column">
              <Section title={`Codex running · ${codexRunning.length}`} />
              {codexRunning.map(r => (
                <Box flexDirection="column" marginTop={1}>
                  <Line left={`◆ ${r.project}`} right={fmtDur(now - r.started)} bold />
                  <Note text={r.current ? `▶ ${r.current}` : r.progress || r.task} color="cyan" />
                  <Note text={`${originOf(r)} · ${r.host}`} />
                </Box>
              ))}
            </Box>
          )}
          <Note text="◉ is this chat. Your turn: finished and waiting for your next message." wrap />
        </Box>
      )
    } else if (tab === 'codex') {
      const expanded = await read($, expandedA)
      const isAll = await read($, allA)
      const toggle = (id: string) => () =>
        void update($, expandedA, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
      const runs = pl?.codex.runs ?? []
      const recent = runs.filter(r => r.status !== 'running')
      const shown = isAll ? recent : recent.slice(0, 10)
      const parentName = (sid: string) =>
        fleet.find(f => f.sid === sid)?.name || v.week.threads.find(t => t.id === sid)?.label || 'a Claude session'
      body = (
        <Box flexDirection="column">
          {!pl && <Note text="Waiting for the collector’s first Codex scan…" />}
          <Section title={`Running · ${codexRunning.length}`} />
          {codexRunning.length === 0 && <Note text="Nothing running right now." />}
          {codexRunning.map(r => (
            <Box flexDirection="column" marginTop={1}>
              <Line left={`● ${r.project}`} right={fmtDur(now - r.started)} bold color="cyan" />
              <Note text={[r.model, r.tier === 'priority' ? 'priority' : '', originOf(r), r.isSelf ? '' : `on ${r.host}`].filter(Boolean).join(' · ')} />
              <Para text={clip(r.task, 240)} />
              {r.parent && <Note text={`↳ from “${parentName(r.parent.sid)}”`} />}
              {r.current ? (
                <Line left={`▶ ${r.current}`} right={`${fmtDur(now - r.currentSince)}`} color="cyan" rightDim={false} />
              ) : r.progress ? (
                <Note text={`“${r.progress}”`} wrap />
              ) : null}
              {r.steps.slice(-5).map(st => (
                <Line left={`${stepIcon(st.k, st.ok)} ${st.t}`} right={`${fmtDur(now - st.ts)} ago`} dim />
              ))}
              <Note
                text={`${r.counts.cmds} commands · ${r.counts.edits} edits${r.counts.mcp ? ` · ${r.counts.mcp} tool calls` : ''} · ${fmtTok(r.tokens[0] + r.tokens[2])} tok`}
              />
              {r.isSelf && (
                <Box marginTop={1}>
                  <Button key={`stop-${r.id}`} label={r.stopAsked ? 'Stopping…' : 'Stop this run'} onPress={() => void stopCodex($, r)} />
                </Box>
              )}
            </Box>
          ))}
          <Section title={`Recent · last 2 days`} />
          {recent.length === 0 && <Note text="No finished runs yet." />}
          {shown.map(r => {
            const isOpen = expanded.includes(`cx-${r.id}`)
            const took = r.ended && r.started ? fmtDur(r.ended - r.started) : ''
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" width={W}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button
                      key={`cx-${r.id}`}
                      label={`${isOpen ? '▾' : '▸'} ${statusIcon[r.status]} ${clip(r.task || r.project, Math.max(10, W - took.length - 8))}`}
                      plain
                      onPress={toggle(`cx-${r.id}`)}
                    />
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text dimColor>{took}</Text>
                  </Box>
                </Box>
                <Note
                  text={[r.project, originOf(r), statusWord[r.status], `${fmtDur(now - (r.ended || r.updated))} ago`].join(' · ')}
                  indent={2}
                />
                {isOpen && (
                  <Box flexDirection="column" marginLeft={2}>
                    {r.parent && <Note text={`↳ from “${parentName(r.parent.sid)}”`} />}
                    {r.final ? <Para text={r.final} /> : <Note text={r.progress || 'No final message.'} wrap />}
                    {r.steps.slice(-8).map(st => (
                      <Line left={`${stepIcon(st.k, st.ok)} ${st.t}`} dim />
                    ))}
                    <Note text={`${r.counts.cmds} commands · ${r.counts.edits} edits · ${fmtTok(r.tokens[0] + r.tokens[2])} tok · ${r.model}`} />
                  </Box>
                )}
              </Box>
            )
          })}
          {recent.length > shown.length && (
            <Box marginTop={1}>
              <Button key="more" label={`Show ${recent.length - shown.length} more`} plain onPress={() => void update($, allA, () => true)} />
            </Box>
          )}
        </Box>
      )
    } else if (tab === 'threads') {
      const expanded = await read($, expandedA)
      const toggle = (id: string) => () =>
        void update($, expandedA, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
      const threads: ThreadRow[] = scoped?.threads ?? []
      body = (
        <Box flexDirection="column">
          <Section title={`Threads · ${scopeTitle}`} right={scoped ? fmtUsd(scoped.usd) : undefined} />
          {threads.length === 0 && <Note text="Nothing here yet." />}
          {threads.map(t => {
            const isOpen = expanded.includes(t.id)
            const right = fmtUsd(t.usd)
            return (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" width={W}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Button
                      key={`open-${t.id}`}
                      label={`${isOpen ? '▾' : '▸'} ${clip(t.label, Math.max(10, W - right.length - 4))}`}
                      plain
                      onPress={toggle(t.id)}
                    />
                  </Box>
                  <Box flexShrink={0} marginLeft={1}>
                    <Text bold>{right}</Text>
                  </Box>
                </Box>
                <Note text={`${meta(t)}${t.agents ? ` · ${t.agents} subagent${t.agents === 1 ? '' : 's'}` : ''}`} indent={2} />
                {isOpen && t.kids.length > 0 && <Note text="AGENTS" indent={2} />}
                {isOpen &&
                  t.kids.map(k => (
                    <Line
                      left={`${'  '.repeat(Math.max(0, (k.depth ?? 1) - 1))}↳ ${k.label}`}
                      right={`${fmtUsd(k.usd)}${share(k) ? ` · ${share(k)}` : ''}`}
                      indent={2}
                      dim
                    />
                  ))}
                {isOpen && t.tasks.length > 0 && <Note text="TASKS" indent={2} />}
                {isOpen &&
                  t.tasks.map(k => (
                    <Line left={`• ${k.label}`} right={fmtUsd(k.usd)} indent={2} dim />
                  ))}
                {isOpen && (pl?.codex.runs ?? []).some(r => r.parent?.sid === t.id) && <Note text="CODEX" indent={2} />}
                {isOpen &&
                  (pl?.codex.runs ?? [])
                    .filter(r => r.parent?.sid === t.id)
                    .slice(0, 8)
                    .map(r => (
                      <Line
                        left={`◆ ${statusIcon[r.status]} ${r.task || r.project}`}
                        right={r.status === 'running' ? 'running' : r.ended && r.started ? fmtDur(r.ended - r.started) : ''}
                        indent={2}
                        dim={r.status !== 'running'}
                      />
                    ))}
              </Box>
            )
          })}
        </Box>
      )
    } else if (tab === 'tasks') {
      const isAll = await read($, allA)
      const tasks = scoped?.tasks ?? []
      const shown = isAll ? tasks : tasks.slice(0, 12)
      body = (
        <Box flexDirection="column">
          <Section title={`Tasks · ${scopeTitle}`} right={scoped ? fmtUsd(scoped.usd) : undefined} />
          {tasks.length === 0 && <Note text="Nothing here yet." />}
          {shown.map(row => (
            <Box marginTop={1}>
              <Row row={row} />
            </Box>
          ))}
          {tasks.length > shown.length && (
            <Box marginTop={1}>
              <Button key="more" label={`Show ${tasks.length - shown.length} more`} plain onPress={() => void update($, allA, () => true)} />
            </Box>
          )}
        </Box>
      )
    } else if (tab === 'breakdown') {
      const dims = scoped?.dims ?? {}
      const total = scoped?.usd ?? 0
      const sections: [string, string][] = [
        ['projects', 'Projects'],
        ['models', 'Models'],
        ['effort', 'Effort level'],
        ['agents', 'Main thread vs subagents'],
        ['skills', 'Skills'],
        ['mcp', 'MCP servers'],
        ['machines', 'Machines'],
      ]
      const cache = scoped?.cache
      body = (
        <Box flexDirection="column">
          <Note text={`${fmtUsd(total)} in ${scopeTitle} · % is the share of that`} />
          {sections.map(([key, title]) => {
            const rows = dims[key] ?? []
            if (rows.length === 0) return null
            return (
              <Box flexDirection="column">
                <Section title={title} />
                {rows.map(row => (
                  <Compact row={row} total={total} />
                ))}
              </Box>
            )
          })}
          {cache && cache.read + cache.write > 0 && (
            <Box flexDirection="column">
              <Section title="Prompt cache" />
              <Line left="Read from cache (cheap)" right={`${fmtTok(cache.read)} tok`} />
              <Line left="Written to cache" right={`${fmtTok(cache.write)} tok`} />
              <Line left="Generated" right={`${fmtTok(cache.out)} tok`} />
              {cache.rebuilds > 0 && (
                <Note text={`${cache.rebuilds} requests re-sent a large context (cache expired, compaction or a model switch): ${fmtUsd(cache.rebuildUsd)}`} wrap />
              )}
            </Box>
          )}
        </Box>
      )
    } else if (tab === 'history') {
      const hostNames = [...new Set(v.history.flatMap(d => Object.keys(d.hosts)))].sort()
      const days = v.history.slice(-7).reverse()
      const max = Math.max(1, ...v.history.map(d => d.total))
      body = (
        <Box flexDirection="column">
          <Section title="Last 14 days" right={fmtUsd(v.history.reduce((n, d) => n + d.total, 0))} />
          {Svg ? (
            <Box flexDirection="column">
              <Box width={W} marginTop={1}>
                <Svg source={svgHistory(v.history, hostNames)} alt="Daily spend for the last 14 days, by machine" />
              </Box>
              <Box flexDirection="row" flexWrap="wrap">
                {hostNames.map((host, i) => (
                  <Box marginRight={2}>
                    <Text color={HOST_COLORS[i % HOST_COLORS.length]}>■ </Text>
                    <Text dimColor>{host}</Text>
                  </Box>
                ))}
              </Box>
            </Box>
          ) : (
            v.history.map(d => (
              <Line left={`${d.label.padEnd(7)} ${'█'.repeat(Math.max(0, Math.round((d.total / max) * Math.max(4, W - 20))))}`} right={fmtUsd(d.total)} />
            ))
          )}
          <Section title="By day" />
          {days.map(d => (
            <Box flexDirection="column">
              <Line left={d.label} right={fmtUsd(d.total)} />
              <Note
                text={[...Object.entries(d.hosts).map(([host, usd]) => `${host} ${fmtUsd(usd ?? 0)}`), ...d.top.slice(0, 2).map(([p]) => p)].join(' · ')}
                indent={2}
              />
            </Box>
          ))}
        </Box>
      )
    } else if (tab === 'accuracy') {
      body = (
        <Box flexDirection="column">
          <Section title="How sure is this" />
          <Line left="Tokens and $" right="exact" />
          <Note text={ccCheck ?? 'cross-check appears after this session’s first response'} indent={2} />
          <Line left="Limit %" right="whole points" />
          <Note text="Anthropic reports 2 for anything from 2% to just under 3%" indent={2} wrap />
          <Line left="Share of a limit" right="≈ estimate" />
          <Note text="learned per model from whole-point crossings; $ elsewhere stays at API prices" indent={2} wrap />
          {v.windows.map(w => (
            <Box flexDirection="column">
              <Section title={`${w.label} limit`} right={w.rate ? `1% ≈ ${fmtUsd(1 / w.rate)}` : undefined} />
              <Note text={CONFIDENCE[w.confidence] ?? w.confidence} />
              {(w.models ?? []).map(m => (
                <Line
                  left={`${m.label}: ${m.weight.toFixed(2)}× Opus per $`}
                  right={m.points >= 1 ? `from ${m.points} points` : 'assumed, no data yet'}
                  dim={m.points < 1}
                />
              ))}
              {w.rateFrom === 'estimate' && w.usdInWindow !== null && (
                <Note text={`from the window so far: ${fmtUsd(w.usdInWindow)} for ${w.pct}–${w.pct + 1}%`} wrap />
              )}
              {w.stretches.length === 0 && (
                <Note text="No whole point crossed while a session was watching yet. Each one adds a measured reading." wrap />
              )}
              {w.stretches.map(s => (
                <Line left={`${s.pctFrom}→${s.pctTo}% · mostly ${s.mostly ?? 'Opus'}`} right={`${fmtUsd(s.usdPerPoint)} per point`} dim />
              ))}
              {w.spread !== null && <Note text={`readings vary by ${Math.round(w.spread * 100)}%`} />}
              <Note text={OUTSIDE[w.outside]} wrap />
              {w.outside === 'unknown' && <Note text="Needs 3 watched readings that agree; outside usage then shows as points your spend doesn't explain." wrap />}
            </Box>
          ))}
          <Section title="Coverage" />
          {v.hosts.map(host => {
            const age = now - host.updatedAt
            const state = host.syncError ? 'offline' : age < 60_000 ? 'live' : `${fmtDur(age)} ago`
            const n = v.accuracy.requestsByHost[host.host] ?? 0
            return <Line left={`${host.host}${host.isSelf ? ' (here)' : ''}`} right={`${state} · ${fmtTok(n)} requests`} />
          })}
          <Note text="Not visible: claude.ai, the phone app, cloud sessions" wrap />
        </Box>
      )
    } else {
      const c = await read($, contextA)
      body = !c ? (
        <Note text="Measuring the context window…" />
      ) : (
        <Box flexDirection="column">
          <Section title={`Context · ${c.model}`} right={`${fmtTok(c.total)} / ${fmtTok(c.max)}`} />
          {c.resend !== null && c.readUsd !== null && c.writeUsd !== null && (
            <Note text={`Each request re-sends ~${fmtTok(c.resend)} tok: ${fmtUsd(c.readUsd)} from cache, ${fmtUsd(c.writeUsd)} if it expired`} wrap />
          )}
          {c.categories.map(cat => (
            <Line left={cat.name} right={fmtTok(cat.tokens)} />
          ))}
          {c.mcp.length > 0 && (
            <Box flexDirection="column">
              <Section title="MCP tool definitions" />
              {c.mcp.map(m => (
                <Line left={`${m.server} (${m.tools})`} right={fmtTok(m.tokens)} />
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const isStale = v.hosts.some(host => host.isSelf && now - host.updatedAt > 90_000)
    const footer = v.hosts
      .map(host => {
        const age = now - host.updatedAt
        const state = host.syncError ? 'offline' : age < 60_000 ? 'live' : `${fmtDur(age)} ago`
        return `${host.host} ${state}`
      })
      .join(' · ')

    return (
      <Box flexDirection="column" width={W}>
        {isStale && <Note text="⚠ The collector on this machine has stopped; numbers are stale." color="red" wrap />}
        {limits}
        {codexHeader}
        {fleetSummary}
        {nav}
        {body}
        <Box marginTop={1}>
          <Note text={footer} />
        </Box>
      </Box>
    )
  })
}
