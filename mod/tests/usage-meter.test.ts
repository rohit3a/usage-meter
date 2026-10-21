import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-08T15:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const ROOT = '/home/t/.claude/usage-meter'

const row = (label: string, usd: number, extra: Record<string, unknown> = {}) => ({
  label,
  sub: '',
  usd,
  tok: [100, 2000, 100_000, 5000],
  reqs: 3,
  ms: 20 * MIN,
  p5: usd * 0.13,
  p7: usd * 0.036,
  ...extra,
})

function scope(usd: number) {
  return {
    usd,
    tok: [3000, 6000, 300_000, 15_000],
    reqs: 4,
    sessions: 2,
    threads: [
      row('Usage meter work', usd - 1, {
        id: 'sess-1',
        sub: 'Desktop · usage-meter',
        agents: 1,
        kids: [row('main thread', usd - 1.5, { depth: 1 }), row('Explore: find callers', 0.5, { depth: 1 })],
        tasks: [row('Refactor the auth module', usd - 1)],
      }),
      row('Laptop chat', 1, { id: 'mac-1', sub: 'Laptop · site', agents: 0, kids: [], tasks: [row('Fix the landing page', 1)] }),
    ],
    tasks: Array.from({ length: 15 }, (_, i) =>
      row(i === 0 ? 'Refactor the auth module' : `Task number ${i}`, 1 / (i + 1), { sub: 'Usage meter work' }),
    ),
    dims: {
      projects: [row('usage-meter', usd - 1), row('site', 1)],
      models: [row('Opus 5.5', usd - 0.5), row('Haiku 4.5', 0.5)],
      effort: [row('xhigh', usd - 2), row('high', 2)],
      agents: [row('main thread', usd - 0.5), row('Explore', 0.5)],
      skills: [row('claude-api', 0.4)],
      mcp: [row('acme', 0.2)],
      machines: [row('Desktop', usd - 1), row('Laptop', 1)],
    },
    cache: { read: 300_000, write: 15_000, fresh: 3000, out: 6000, rebuilds: 2, rebuildUsd: 1.2 },
  }
}

function view(selfAge: number) {
  return {
    v: 1,
    builtAt: T0 - 1000,
    host: 'Desktop',
    windows: [
      {
        kind: 'five_hour', label: '5h', pct: 2, resetsAt: T0 + 3 * HOUR, isReset: false,
        rate: 1 / 9.20, rateFrom: 'learned', confidence: 'low',
        rates: { opus: 1 / 9.20, sonnet: 0.70 / 9.20, haiku: 1 / 9.20, 'haiku-long': 1 / 9.20, fable: 1 / 9.20, other: 1 / 9.20 },
        models: [
          { family: 'opus', label: 'Opus', weight: 1, points: 18.6 },
          { family: 'sonnet', label: 'Sonnet', weight: 0.70, points: 3.1 },
          { family: 'haiku-long', label: 'Haiku, prompts over 100k', weight: 1, points: 0 },
          { family: 'fable', label: 'Fable', weight: 1, points: 0 },
        ],
        stretches: [{ from: T0 - HOUR, to: T0 - 10 * MIN, pctFrom: 1, pctTo: 2, usd: 9.20, usdPerPoint: 9.20, opusShare: 0.92, mostly: 'Opus' }],
        spread: null, readings: 9, usdInWindow: 19.1, untrackedPct: null, outside: 'unknown', burnPerHour: 1.9, atReset: 8.4,
        fullAt: T0 + 50 * HOUR, usdLeft: 745.6, typicalSessions: 42.7,
      },
      {
        kind: 'seven_day', label: '7d', pct: 64, resetsAt: T0 + 28 * HOUR, isReset: false,
        rate: 1 / 27.9, rateFrom: 'estimate', confidence: 'rough', stretches: [], spread: null, readings: 4,
        usdInWindow: 1480.2, untrackedPct: null, outside: 'unknown', burnPerHour: 0.33, atReset: 71.3, fullAt: T0 + 63 * HOUR,
        usdLeft: 812.4, typicalSessions: 32.6,
      },
    ],
    window: scope(19.12),
    week: scope(1480),
    history: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-09-${25 + i}`,
      label: `Day ${25 + i}`,
      hosts: { Desktop: 300 + i * 10, Laptop: i % 3 === 0 ? 20 : 0 },
      total: 300 + i * 10 + (i % 3 === 0 ? 20 : 0),
      top: [['my-app', 200], ['website', 80]],
    })),
    monthUsd: 5120,
    typicalSessionUsd: 17.46,
    biggestSessionUsd: 450,
    sessionUsd: { 'sess-1': 18.12 },
    accuracy: { requestsByHost: { Desktop: 12_400, Laptop: 900 } },
    hosts: [
      { host: 'Desktop', isSelf: true, updatedAt: T0 - selfAge, syncError: null, subscription: 'max' },
      { host: 'Laptop', isSelf: false, updatedAt: T0 - 15_000, syncError: null, subscription: 'max' },
    ],
    config: { plan: { name: 'Max 5x', usdPerMonth: 100 } },
  }
}

function pulse() {
  const run = (over: Record<string, unknown>) => ({
    id: 'run-x', host: 'Desktop', started: T0 - 12 * MIN, updated: T0 - 5000, ended: 0, status: 'running', origin: 'exec',
    cwd: '/home/t/acme', project: 'acme-api', model: 'gpt-6.1-sol', tier: 'priority', task: '', progress: '',
    current: null, currentSince: 0, steps: [], counts: { cmds: 0, edits: 0, mcp: 0, agents: 0 }, tokens: [0, 0, 0, 0],
    final: '', reason: '', parent: null, pid: null, isSelf: true, ...over,
  })
  const session = (over: Record<string, unknown>) => ({
    sid: 's', host: 'Desktop', pid: 1, name: '', cwd: '/home/t/proj', project: 'proj', entry: 'claude-desktop', kind: 'interactive',
    startedAt: T0 - HOUR, since: T0 - 2 * MIN, state: 'working', detail: '', lastAt: T0 - 5000, isSelf: true, ...over,
  })
  return {
    at: T0 - 1000,
    codex: {
      limits: {
        at: T0 - 5000, plan_type: 'plus', secondary: null,
        primary: { used_percent: 26, window_minutes: 10080, resets_at: (T0 + 5 * 24 * HOUR) / 1000 },
        credits: { has_credits: true, unlimited: false, balance: '18250.00' },
      },
      runs: [
        run({
          id: 'run-1', task: 'Build the search API step by step', progress: 'Working on step 4',
          current: 'pnpm test', currentSince: T0 - 70_000, pid: 4242, parent: { sid: 'sess-1', prompt: 'p1', host: 'Desktop' },
          steps: [
            { k: 'cmd', t: 'git commit -m "step 3"', ts: T0 - 3 * MIN, ok: true },
            { k: 'edit', t: 'edited search.ts', ts: T0 - 2 * MIN, ok: true },
          ],
          counts: { cmds: 91, edits: 6, mcp: 0, agents: 0 }, tokens: [1_000_000, 800_000, 200_000, 0],
        }),
        run({
          id: 'run-2', status: 'done', origin: 'app', project: 'acme', task: 'Review the PR for acme',
          started: T0 - 2 * HOUR, ended: T0 - HOUR, updated: T0 - HOUR, final: 'Merged after fixing two tests.',
        }),
      ],
    },
    fleet: [
      session({ sid: 'sess-1', name: 'Usage meter work', state: 'working', detail: 'edit register.tsx' }),
      session({ sid: 'sess-2', name: 'PR review', state: 'needs-you', detail: 'Which branch should I merge into?', since: T0 - 4 * MIN }),
      session({ sid: 'sess-3', name: 'Client site', state: 'your-turn', detail: 'The redesign is on main.', since: T0 - 3 * HOUR }),
    ],
  }
}

type Files = Map<string, { text: string; mtime: number }>

function files(selfAge = 2000): Files {
  const f: Files = new Map()
  f.set(`${ROOT}/local/view.json`, { text: JSON.stringify(view(selfAge)), mtime: T0 - 1000 })
  f.set(`${ROOT}/local/sessions/sess-1.json`, { text: JSON.stringify({ ...scope(18.12), sessions: 1 }), mtime: T0 - 1000 })
  f.set(`${ROOT}/local/live.json`, { text: JSON.stringify(pulse()), mtime: T0 - 1000 })
  return f
}

function world(on: On, f: Files, reads: string[] = []) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: T0 - HOUR,
      context: {
        window: 1_000_000,
        tokens: 150_000,
        percent: 15,
        breakdown: e.breakdown
          ? {
              categories: [
                { name: 'System prompt', tokens: 12_000, color: 'x', isDeferred: false, kind: 'used' },
                { name: 'Messages', tokens: 130_000, color: 'x', isDeferred: false, kind: 'used' },
              ],
              totalTokens: 142_000,
              rawMaxTokens: 1_000_000,
              mcpTools: [{ name: 'mcp__supabase__sql', serverName: 'supabase', tokens: 3_000, isLoaded: true }],
            }
          : undefined,
      },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 2, resetsAt: new Date(T0 + 3 * HOUR).toISOString() },
        { kind: 'seven_day', percentUsed: 64, resetsAt: new Date(T0 + 28 * HOUR).toISOString() },
      ],
      cost: { usd: 18.2 },
    },
  }) as never)
  on('fs.stat', ($, e) => {
    const x = f.get(e.path)
    if (!x) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file', size: x.text.length, mtimeMs: x.mtime, isLink: false } }
  })
  on('fs.read', ($, e) => {
    reads.push(e.path)
    const x = f.get(e.path)
    if (!x) throw new Error(`ENOENT ${e.path}`)
    return { value: x.text }
  })
  on('fs.write', ($, e) => {
    f.set(e.path, { text: e.text, mtime: T0 })
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'usage-meter', title: 'Usage', isShown: true, isFocused: false, isPlaced: true }] }) as never)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'live-agent' }))
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 5000 },
    }
  })
  return clock
}

/** Reads a stream to its end, as the engine does; `.result` alone leaves the hooks undriven. */
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of stream) {
    // chunks are not under test
  }
}

const PANE = {
  plugin: 'usage-meter',
  component: 'Pane' as const,
  requestId: 'usage-meter',
  props: { title: 'Usage', isFocused: true, bodyColumns: 44, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 120 }, view: {} },
}

async function open($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/home/t/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await $.command.run({ command: 'burn', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as never)
}

type Finder = { findAll: (q: { type?: string }) => Promise<readonly { text?: string }[]> }
async function texts(ui: Finder): Promise<string[]> {
  return (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '')
}
function missing(have: string[], want: (string | RegExp)[]): string[] {
  return want.filter(w => !have.some(t => (typeof w === 'string' ? t === w : w.test(t)))).map(String)
}

test('overview: whole-point limits, budget left, machines, session check, value', async ($, on) => {
  const clock = world(on, files())
  await open($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(
      missing(await texts(ui), [
        '5h limit', '2%', '7d limit', '64%',
        '3h 00m left · ≈$746 to go · ~8% at reset',
        '28h 00m left · ≈$812 to go · ~71% at reset',
        'WHERE THE 5H WINDOW WENT', '$19.12', 'Desktop', '$18.12 · ≈2.4%', 'Laptop', '$1.00 · ≈0.1%',
        'Usage outside Claude Code (claude.ai, phone): too early to tell',
        '1% of 5h ≈ $9.20 of Opus usage · low confidence',
        'THIS SESSION', '$18.12', '✓ matches Claude Code’s own total',
        'TOP TASKS · 5H', 'Refactor the auth module',
        'LAST 30 DAYS', '$5,120', 'Max 5x · 51.2× its $100/mo price',
        'Desktop live · Laptop live',
      ]),
    ).toEqual([])
    await ui.unmount()
  }
})

test('every view draws on terminal and desktop, through the dropdowns', async ($, on) => {
  const clock = world(on, files())
  await open($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const gaps: string[] = []
    const check = async (label: string, want: (string | RegExp)[]) =>
      gaps.push(...missing(await texts(ui), want).map(m => `${surface} ${label}: ${m}`))

    await ui.select({ key: 'tab', value: 'threads' })
    await ui.select({ key: 'scope', value: 'window' })
    await check('threads', ['THREADS · 5H WINDOW', '$18.12', /≈2\.4% · 107k tok \(93% cached\) · 20m · Desktop · usage-meter · 1 subagent/])
    await ui.press({ key: 'open-sess-1' })
    await check('threads open', ['AGENTS', '↳ Explore: find callers', 'TASKS', '• Refactor the auth module'])
    await ui.press({ key: 'open-sess-1' })
    await ui.select({ key: 'scope', value: 'week' })
    await check('threads week', ['THREADS · LAST 7 DAYS', '$1,480'])

    await ui.select({ key: 'tab', value: 'tasks' })
    await check('tasks', ['Task number 11'])
    await ui.press({ key: 'more' })
    await check('tasks all', ['Task number 14'])

    await ui.select({ key: 'scope', value: 'session' })
    await ui.select({ key: 'tab', value: 'breakdown' })
    await check('breakdown', [
      'PROJECTS', 'usage-meter', 'EFFORT LEVEL', 'xhigh', 'SKILLS', 'claude-api', 'MCP SERVERS', 'acme', 'MACHINES',
      'PROMPT CACHE', /2 requests re-sent a large context/,
    ])

    await ui.select({ key: 'tab', value: 'history' })
    await check('history', ['LAST 14 DAYS', 'BY DAY', 'Day 38', /Desktop \$430 · Laptop \$0\.00 · my-app/])

    await ui.select({ key: 'tab', value: 'accuracy' })
    await check('accuracy', [
      'HOW SURE IS THIS', 'Tokens and $', 'exact', 'whole points', '≈ estimate', '1→2% · mostly Opus', '$9.20 per point', 'Sonnet: 0.70× Opus per $', 'from 3.1 points', 'Fable: 1.00× Opus per $', 'Haiku, prompts over 100k: 1.00× Opus per $', 'assumed, no data yet',
      'rough estimate', 'COVERAGE', 'Desktop (here)', 'live · 12k requests',
    ])

    await ui.select({ key: 'tab', value: 'context' })
    await check('context', ['CONTEXT · OPUS 5.5', 'Messages', 'supabase (1)'])
    await ui.select({ key: 'tab', value: 'overview' })
    expect(gaps).toEqual([])
    await ui.unmount()
  }
})

test('mobile has no dropdowns: the views are buttons instead', async ($, on) => {
  const clock = world(on, files())
  await open($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'tab-history' })
  expect(missing(await texts(ui), ['LAST 14 DAYS'])).toEqual([])
  await ui.unmount()
})

test('reads the summary only when the collector rewrote it', async ($, on) => {
  const reads: string[] = []
  const f = files()
  const clock = world(on, f, reads)
  await open($, clock)
  await clock.advance(10_000)
  const count = () => reads.filter(p => p.endsWith('view.json')).length
  const before = count()
  await clock.advance(20_000)
  expect(count()).toBe(before)
  const cur = f.get(`${ROOT}/local/view.json`)
  if (cur) f.set(`${ROOT}/local/view.json`, { ...cur, mtime: T0 + 30_000 })
  await clock.advance(4000)
  expect(count()).toBe(before + 1)
})

test('warns when this machine’s collector has stopped', async ($, on) => {
  const clock = world(on, files(10 * MIN))
  await open($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(missing(await texts(ui), [/collector on this machine has stopped/])).toEqual([])
  await ui.unmount()
})

test('band shows the live turn, then the last turn, and readings reach the collector', async ($, on) => {
  const f = files()
  const clock = world(on, f)
  await $.session.start({ cwd: '/home/t/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await $.turn.start({ text: 'Do the thing', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'look', description: 'look around', subagentType: 'Explore',
    parentModel: 'claude-opus-5-5', background: false, fork: false,
  } as never)
  await drain($.turn.step({ turnId: 'run-a', index: 0, model: 'claude-haiku-4-5', messageCount: 2, agentId: 'live-agent' }))
  const BAND = {
    plugin: 'usage-meter',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 90, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(missing(await texts(band), [/^● this turn · \$0\.14 · 2 requests · 216k tok \(93% cached\) · <0\.1% of 5h · 1 subagent \(1 running\)$/])).toEqual([])
    await band.unmount()
  }
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)
  await clock.advance(4000)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(missing(await texts(band), [/^last turn · \$0\.14/])).toEqual([])
  await band.unmount()
  expect(f.has(`${ROOT}/local/limits/sess-1.json`)).toBe(true)
})

test('header: Codex limit next to Claude’s, and the sessions at a glance', async ($, on) => {
  const clock = world(on, files())
  await open($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = (await ui.findAll({})).map(x => x.text ?? '')
    expect(missing(await texts(ui), ['Codex week', '26%', '5d 0h left · Plus plan · 18,250 credits'])).toEqual([])
    expect(missing(all, ['Sessions: 1 need you · 1 working · 1 your turn · 1 Codex', '↻ Refresh'])).toEqual([])
    await ui.unmount()
  }
})

test('sessions and Codex views, Stop, and Codex under its parent thread', async ($, on) => {
  const f = files()
  const clock = world(on, f)
  await open($, clock)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const gaps: string[] = []
    const check = async (label: string, want: (string | RegExp)[]) => {
      const all = (await ui.findAll({})).map(x => x.text ?? '')
      gaps.push(...missing(all, want).map(m => `${surface} ${label}: ${m}`))
    }
    await ui.press({ key: 'fleet-summary' })
    await check('sessions', [
      'NEEDS YOU · 1', 'PR review', 'Which branch should I merge into?', 'WORKING · 1', '◉ Usage meter work',
      'YOUR TURN · 1', 'Client site', /Desktop · proj · idle 3h 00m/, 'CODEX RUNNING · 1', '▶ pnpm test',
    ])

    await ui.select({ key: 'tab', value: 'codex' })
    await check('codex', [
      'RUNNING · 1', '● acme-api', '12m', 'gpt-6.1-sol · priority · started by Claude',
      'Build the search API step by step', '↳ from “Usage meter work”', '▶ pnpm test',
      '$ git commit -m "step 3"', '✎ edited search.ts', '91 commands · 6 edits · 1.2M tok', 'Stop this run',
      'RECENT · LAST 2 DAYS', /▸ ✓ Review the PR for acme/, 'acme · Codex app · finished · 1h 00m ago',
    ])
    await ui.press({ key: 'cx-run-2' })
    await check('codex open', ['Merged after fixing two tests.'])
    await ui.press({ key: 'cx-run-2' })
    await ui.press({ key: 'stop-run-1' })
    expect(f.has(`${ROOT}/local/stop/run-1.json`)).toBe(true)
    f.delete(`${ROOT}/local/stop/run-1.json`)

    await ui.select({ key: 'tab', value: 'threads' })
    await ui.select({ key: 'scope', value: 'window' })
    await ui.press({ key: 'open-sess-1' })
    await check('threads codex', ['CODEX', /◆ ● Build the search API/])
    await ui.press({ key: 'open-sess-1' })

    await ui.press({ key: 'refresh' })
    expect(f.has(`${ROOT}/local/refresh`)).toBe(true)
    await ui.select({ key: 'tab', value: 'overview' })
    expect(gaps).toEqual([])
    await ui.unmount()
  }
})

test('band follows the Codex run this chat started, with stop and watch', async ($, on) => {
  const f = files()
  const clock = world(on, f)
  await $.session.start({ cwd: '/home/t/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  const BAND = {
    plugin: 'usage-meter',
    component: 'AbovePrompt' as const,
    props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    const all = (await band.findAll({})).map(x => x.text ?? '')
    expect(missing(all, [/^◆ Codex · ▶ pnpm test · 12m · 1\.2M tok$/, 'watch', 'stop', '5h 2% · 7d 64% · Codex 26% · $18.20 session', 'open usage'])).toEqual([])
    await band.press({ key: 'codex-stop' })
    expect(f.has(`${ROOT}/local/stop/run-1.json`)).toBe(true)
    f.delete(`${ROOT}/local/stop/run-1.json`)
    await band.unmount()
  }
})

const IDLE_BAND = {
  plugin: 'usage-meter',
  component: 'AbovePrompt' as const,
  surface: 'terminal' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

async function idleTurn($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/home/t/proj', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await $.turn.start({ text: 'Do the thing', turnId: 't1' })
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 }))
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'completed' } as never)
}

async function bandTexts($: Engine): Promise<string[]> {
  const band = await $.ui.mount(IDLE_BAND)
  const have = await texts(band)
  await band.unmount()
  return have
}

// 2.1.280's kit ignores a test's `options`, so idleCompact can't be switched on
// there; that kit has no mock.session either, which is how this file tells them apart
const hasTestOptions = 'session' in mock

if (hasTestOptions) test('idle: counts down to the cache expiring, then compacts 5 minutes before', { options: { idleCompact: true, idleCompactMinTokens: 100_000 } }, async ($, on) => {
  const clock = world(on, files())
  const compacts: unknown[] = []
  on('session.compact', ($, e) => {
    compacts.push(e)
    return { messages: [{ role: 'user' as const, text: 'Summary of the work so far', toolUses: [] }], tokensBefore: 106_000, tokensAfter: 9_000 }
  })
  await idleTurn($, clock)
  await clock.advance(9 * MIN)
  expect((await bandTexts($)).some(t => t.startsWith('◷'))).toBe(false)
  await clock.advance(2 * MIN)
  expect(missing(await bandTexts($), ['◷ cache expires in 49m · 106k context · auto-compacts in 44m'])).toEqual([])
  await clock.advance(43 * MIN)
  expect(compacts.length).toBe(0)
  await clock.advance(2 * MIN)
  expect(compacts.length).toBe(1)
  expect(missing(await bandTexts($), [/^◷ compacted while idle · 106k → 9\.0k context/])).toEqual([])
  await clock.advance(10 * MIN)
  expect(compacts.length).toBe(1)
})

test('idle: with compaction off, says when the cache expired; small contexts are left alone', { options: { idleCompactMinTokens: 100_000 } }, async ($, on) => {
  const clock = world(on, files())
  const compacts: unknown[] = []
  on('session.compact', ($, e) => {
    compacts.push(e)
    return { messages: [{ role: 'user' as const, text: 'Summary of the work so far', toolUses: [] }], tokensBefore: 106_000, tokensAfter: 9_000 }
  })
  await idleTurn($, clock)
  await clock.advance(52 * MIN)
  expect(missing(await bandTexts($), [/^◷ cache expires in 8m · 106k context$/])).toEqual([])
  await clock.advance(10 * MIN)
  expect(missing(await bandTexts($), ['◷ cache expired 2m ago · your next message re-caches 106k context'])).toEqual([])
  expect(compacts.length).toBe(0)
})
