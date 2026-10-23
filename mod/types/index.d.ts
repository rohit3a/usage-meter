/** Token counts: uncached input, output, cache read, cache write. */
export type Tokens = [number, number, number, number]

/** One line of a breakdown, as the collector's view.json writes it. */
export type ViewRow = {
  label: string
  sub: string
  usd: number
  tok: Tokens
  reqs: number
  ms: number
  /** Share of the 5-hour / 7-day limit, from the %-per-$ rate. */
  p5: number | null
  p7: number | null
  depth?: number
}

export type ThreadRow = ViewRow & {
  id: string
  agents: number
  kids: ViewRow[]
  tasks: ViewRow[]
}

export type ScopeView = {
  usd: number
  tok: Tokens
  reqs: number
  sessions: number
  threads: ThreadRow[]
  tasks: ViewRow[]
  dims: Record<string, ViewRow[] | undefined>
  cache: { read: number; write: number; fresh: number; out: number; rebuilds: number; rebuildUsd: number }
}

export type Stretch = {
  from: number
  to: number
  pctFrom: number
  pctTo: number
  usd: number
  usdPerPoint: number
  opusShare: number
  /** the model family that made up most of the stretch */
  mostly?: string
}

/** How much of a limit a plan-reference dollar of each model family uses, learned from crossings. */
export type ModelWeight = { family: string; label: string; weight: number; points: number }

export type WindowView = {
  kind: string
  label: string
  pct: number
  resetsAt: number | null
  isReset: boolean
  rate: number | null
  /** points per plan-reference $ by model family (opus, sonnet, haiku, haiku-long, fable, other); Haiku 5.5 prompts over 100k are haiku-long */
  rates?: Record<string, number | undefined> | null
  models?: ModelWeight[]
  rateFrom: 'learned' | 'estimate' | 'none'
  confidence: 'none' | 'rough' | 'low' | 'medium' | 'high'
  stretches: Stretch[]
  spread: number | null
  readings: number
  usdInWindow: number | null
  untrackedPct: number | null
  /** Whether anything outside Claude Code used this limit: not measurable yet, none, or some. */
  outside: 'unknown' | 'none' | 'some'
  burnPerHour: number | null
  atReset: number | null
  fullAt: number | null
  usdLeft: number | null
  typicalSessions: number | null
}

export type HistoryDay = {
  date: string
  label: string
  hosts: Record<string, number | undefined>
  total: number
  top: [string, number][]
}

export type HostInfo = {
  host: string
  isSelf: boolean
  updatedAt: number
  syncError: string | null
  subscription: string
}

/** What the collector writes to ~/.claude/usage-meter/local/view.json. */
export type View = {
  v: number
  builtAt: number
  host: string
  windows: WindowView[]
  window: ScopeView
  week: ScopeView
  history: HistoryDay[]
  monthUsd: number
  typicalSessionUsd: number
  biggestSessionUsd: number
  sessionUsd: Record<string, number | undefined>
  accuracy: { requestsByHost: Record<string, number | undefined> }
  hosts: HostInfo[]
  config: { plan?: { name?: string; usdPerMonth?: number } }
}

export type CodexStep = { k: 'cmd' | 'edit' | 'mcp' | 'agent' | 'note'; t: string; ts: number; ok: boolean | null }

/** One Codex run, as the collector reads it from ~/.codex/sessions. */
export type CodexRun = {
  id: string
  host: string
  started: number
  updated: number
  ended: number
  status: 'running' | 'done' | 'aborted' | 'stopped' | 'stale' | 'idle'
  origin: string
  cwd: string
  project: string
  model: string
  tier: string
  task: string
  progress: string
  current: string | null
  currentSince: number
  steps: CodexStep[]
  counts: { cmds: number; edits: number; mcp: number; agents: number }
  tokens: [number, number, number, number]
  final: string
  reason: string
  parent: { sid: string; prompt: string; host: string } | null
  pid?: number | null
  stopAsked?: number
  isSelf: boolean
}

export type CodexWindow = { used_percent: number; window_minutes: number; resets_at: number }
export type CodexLimits = {
  at: number
  plan_type?: string | null
  primary?: CodexWindow | null
  secondary?: CodexWindow | null
  credits?: { has_credits: boolean; unlimited: boolean; balance: string | null } | null
}

/** One live Claude session, from Claude Code's own status file and its transcript. */
export type FleetEntry = {
  sid: string
  host: string
  pid: number
  name: string
  cwd: string
  project: string
  entry: string
  kind: string
  startedAt: number
  since: number
  state: 'working' | 'needs-you' | 'your-turn' | 'idle'
  detail: string
  lastAt: number
  isSelf: boolean
}

/** What the collector writes to ~/.claude/usage-meter/local/live.json, every few seconds. */
export type Pulse = {
  at: number
  codex: { limits: CodexLimits | null; runs: CodexRun[] }
  fleet: FleetEntry[]
}

export type ContextView = {
  model: string
  total: number
  max: number
  categories: { name: string; tokens: number }[]
  mcp: { server: string; tokens: number; tools: number }[]
  resend: number | null
  readUsd: number | null
  writeUsd: number | null
}

export type LiveAgent = { label: string; usd: number; isRunning: boolean }

/** The main thread's current (or last) turn, for the band above the prompt. */
export type Live = {
  /** estimated points of the 5h limit this turn used, by learned model weights */
  pts?: number
  turnId: string
  startedAt: number
  endedAt: number | null
  usd: number
  tok: Tokens
  reqs: number
  agents: LiveAgent[]
}

/** The main thread's prompt cache: when its last request ran and how much it holds. */
export type Idle = {
  /** when the main thread's last request finished (ms) */
  at: number
  /** context that request sent: what the cache holds */
  ctx: number
  /** set once an idle compaction replaced the context */
  compacted?: { before: number; after: number; at: number }
  /** an idle compaction was declined or failed: not retried until the next request */
  isSkipped?: boolean
}

/** What `umeter.py install` answered at session start (or /burn setup). */
export type Setup = {
  action: 'ok' | 'installed' | 'updated' | 'started' | 'disabled' | 'uninstalled' | 'failed'
  service?: 'systemd' | 'launchd' | 'process'
  message?: string
}

export type Tab = 'overview' | 'sessions' | 'codex' | 'threads' | 'tasks' | 'breakdown' | 'history' | 'accuracy' | 'context'
export type Scope = 'session' | 'window' | 'week'

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      view: View | null
      pulse: Pulse | null
      mine: ScopeView | null
      context: ContextView | null
      cc: number | null
      live: Live | null
      tab: Tab
      scope: Scope
      expanded: string[]
      isAllShown: boolean
      isBandHidden: boolean
      idle: Idle | null
      setup: Setup | null
    }
  }
}
