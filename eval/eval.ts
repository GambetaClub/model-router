#!/usr/bin/env node
/**
 * Evaluates the installed model-router with your own settings.
 *
 *   node eval/eval.ts [--runs 1] [--min 0.75] [--since 2026-10-08] [--only sim|audit]
 *
 * sim    Real Jev calls through the real hook, in a fake engine. Checks the
 *        first-prompt pick and that the main model never moves mid-conversation.
 * audit  Reads your past session logs, free and offline. Checks the same two
 *        things on what really happened.
 *
 * Needs Node 22.6+ (runs .ts directly). Exit code 1 when a check fails.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { register } from '../hooks/model-router.ts'
import { readDecision, rankOf, requestModelId, TIER_ORDER } from '../hooks/policy.ts'
import type { Decision, Tier } from '../hooks/policy.ts'

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const RUNS = Number(arg('runs', '1'))
const MIN_ACCURACY = Number(arg('min', '0.75'))
const HOOK = join(import.meta.dirname, '../hooks/model-router.ts')
// Sessions older than the last edit ran other code, so the audit skips them by default.
const SINCE = argv.includes('--since') ? new Date(arg('since', '')).getTime() : statSync(HOOK).mtimeMs
const ONLY = arg('only', 'all')

const settings = JSON.parse(readFileSync(join(homedir(), '.claude/settings.json'), 'utf8'))
const options: Record<string, unknown> = settings.pluginConfigs?.['model-router@skills-dir']?.options ?? {}
const BASE = { model: requestModelId(settings.model ?? 'opus'), effort: settings.effortLevel ?? 'low' }
const TIERS = {
  fast: 'haiku',
  balanced: 'sonnet',
  deep: 'opus',
  superDeep: 'fable',
}

// ---------------------------------------------------------------- fake engine

interface Turn {
  text: string
  decision: Decision | null
  model: string
  effort: string | undefined
  steady: boolean
  held: boolean
  ms: number
}
type Step = string | { event: 'session.end' | 'session.compact' }

async function converse(steps: Step[]): Promise<Turn[]> {
  const handlers: Record<string, any> = {}
  register((event: string, fn: unknown) => (handlers[event] = fn), options)

  const responses: Record<number, string> = {}
  let submitted = 0
  let aborted = false
  const $ = {
    ui: { log() {}, toast() {}, status() {} },
    clock: {
      now: async () => Date.now(),
      sleep: (ms: number) =>
        new Promise<void>(done => {
          setTimeout(done, ms).unref()
        }),
    },
    http: {
      fetch: async (url: string, init: RequestInit) => {
        const mine = submitted
        const response = await fetch(url, init)
        const text = await response.text()
        responses[mine] = text
        return { ok: response.ok, status: response.status, text }
      },
    },
    turn: { abort: async () => void (aborted = true) },
    model: { classify: async () => null },
  }
  const pass = async (e: unknown) => e
  async function* passStep(e: unknown) {
    yield e
  }

  const turns: Turn[] = []
  for (const step of steps) {
    if (typeof step !== 'string') {
      await handlers[step.event]($, {}, pass)
      continue
    }
    const n = ++submitted
    const turnId = `turn-${n}`
    const startedAt = Date.now()
    await handlers['prompt.submit']($, { text: step, origin: { kind: 'composer' } }, pass)
    const ms = Date.now() - startedAt
    const decision = responses[n] ? readDecision(responses[n]) : null

    aborted = false
    await handlers['turn.start']($, { turnId }, pass)
    if (aborted) {
      turns.push({ text: step, decision, model: BASE.model, effort: BASE.effort, steady: true, held: true, ms })
      continue
    }

    // Three requests per turn: the first one decides, the rest are a tool loop.
    const requests: any[] = []
    for (let index = 0; index < 3; index++) {
      const request = { turnId, index, model: BASE.model, effort: BASE.effort }
      for await (const r of handlers['turn.step']($, request, passStep)) requests.push(r)
    }
    turns.push({
      text: step,
      decision,
      model: requests[0].model,
      effort: requests[0].effort,
      steady: requests.every(r => r.model === requests[0].model),
      held: false,
      ms,
    })
  }
  return turns
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await fn(items[at] as T)
      }
    }),
  )
  return out
}

const tierOf = (model: string): Tier | null => TIER_ORDER[rankOf(model, TIERS) ?? -1] ?? null
const short = (text: string, n = 62) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

// ---------------------------------------------------------------- first-prompt cases

const DEEP: Tier[] = ['deep', 'superDeep']
const CASES: Array<[Tier[], string]> = [
  [['fast'], 'Read PlantDoctor/Theme.swift and tell me which colors are defined.'],
  [['fast'], 'Rename the variable plantList to plants in HomeRoute.swift.'],
  [['fast'], 'Run git status and tell me what changed.'],
  [['fast'], 'Show me the last 5 commits.'],
  [['fast'], 'Fix the typo "recieve" in README.md.'],
  [['fast'], 'Summarise what server/src/index.ts does in two sentences.'],
  [['fast'], 'What does the -r flag do in grep?'],
  [['balanced'], 'Add a lastWateredAt date field to the Plant model and show it on the plant detail screen.'],
  [['balanced'], 'Write tests for the decide function in server/src covering the quota edge cases.'],
  [['balanced'], 'Add a /health endpoint to the worker that returns the app version, and a test for it.'],
  [['balanced'], 'Make the water reminder notification show the plant name instead of a generic title.'],
  [['balanced'], 'Fix the bug where the diagnosis screen flashes the previous plant photo when a new diagnosis opens.'],
  [['balanced'], 'Review my last commit for bugs.'],
  [['balanced'], 'Add a refund endpoint that calls Stripe. Only write the code and a test, do not run anything.'],
  [['deep'], 'The app crashes only on iOS 17 devices right after the camera permission prompt. No crash log, cannot reproduce in the simulator. Find out why.'],
  [['deep'], 'Design how subscription state should sync across devices so a purchase on one iPhone unlocks the others, including refunds and family sharing.'],
  [['deep'], 'Audit the App Attest verification in server/src for security holes.'],
  [['deep'], "Plan a migration of the SwiftData store to support multiple spaces without losing existing users' diagnosis history."],
  [['deep'], 'Our worker sometimes grants the free quota twice under concurrent requests. Find the race condition.'],
  [['deep'], 'StoreKit transactions verify in sandbox but verifyTransaction rejects them in production. Work out why.'],
  [['superDeep'], 'Refactor the whole app onto one navigation architecture: rework every route and view, update the models, and keep all tests green.'],
  [['superDeep'], 'Build a full care reminder system: scheduling model, notification service, settings UI, an onboarding step, server sync and tests, across the app and the worker.'],
  [['superDeep'], 'Migrate the entire codebase from ObservableObject to the Observation framework, every view and service.'],
  [['superDeep'], 'Add 10 languages across every view, the server prompts, the App Store metadata and the content pipelines.'],
  [DEEP, 'Deploy the worker to production right now and delete the old KV namespace.'],
  [DEEP, 'Run the migration script against the production database and drop the legacy tables.'],
  [DEEP, 'Issue refunds to every customer who bought the yearly plan last week, using the live payment key.'],
]

// ---------------------------------------------------------------- conversations

const MIGRATION = "Plan a migration of the SwiftData store to support multiple spaces without losing existing users' diagnosis history."
const check = (label: string, ok: boolean) => ({ label, ok })

const SCENARIOS: Array<{
  name: string
  steps: Step[]
  checks: (turns: Turn[]) => Array<{ label: string; ok: boolean }>
}> = [
  {
    name: 'hard start, easy follow-ups: model stays put',
    steps: [MIGRATION, 'Rename the migration file to something clearer.', 'Show me the diff so far.', 'Now implement step one of that plan and update the tests.'],
    checks: t => [
      check('first prompt picks deep or superDeep', DEEP.includes(tierOf(t[0]!.model)!)),
      check('later turns keep the first model', t.slice(1).every(x => x.held || x.model === t[0]!.model)),
      check('model is steady inside every turn', t.every(x => x.steady)),
    ],
  },
  {
    name: 'easy start, hard follow-up: no upgrade mid-chat',
    steps: ['Show me what is in PlantDoctor/Theme.swift.', 'Now design a new theme system with dark mode, dynamic type and per-plant accent colors, and plan the rollout.', 'Go ahead with the plan.'],
    checks: t => [
      check('first prompt picks fast', tierOf(t[0]!.model) === 'fast'),
      check('later turns keep the first model', t.slice(1).every(x => x.held || x.model === t[0]!.model)),
      check('model is steady inside every turn', t.every(x => x.steady)),
    ],
  },
  {
    name: 'session.end re-picks the model',
    steps: ['Show me the last 5 commits.', { event: 'session.end' }, MIGRATION],
    checks: t => [check('second chat gets a different model', t[1]!.model !== t[0]!.model)],
  },
  {
    name: 'session.compact re-picks the model',
    steps: [MIGRATION, { event: 'session.compact' }, 'Run git status and tell me what changed.'],
    checks: t => [check('model is picked again after compaction', t[1]!.model !== t[0]!.model)],
  },
  {
    name: 'unrelated prompt is held back, resend runs here',
    steps: [
      'Add a lastWateredAt date field to the Plant model.',
      'Also show it on the plant detail screen.',
      'Write me a TikTok script about overwatering pothos.',
      'Write me a TikTok script about overwatering pothos.',
    ],
    checks: t => [
      check('follow-up is not held', !t[1]!.held),
      check('unrelated prompt is held', t[2]!.held),
      check('resent prompt runs', !t[3]!.held),
      check('model unchanged across all of it', t.every(x => x.held || x.model === t[0]!.model)),
    ],
  },
]

// ---------------------------------------------------------------- run: sim

async function sim(): Promise<boolean> {
  if (!options.typesafeApiKey) {
    console.log('No typesafeApiKey in settings.json, so Jev is not in use. Skipping sim.')
    return true
  }
  console.log(`SIM  session model ${BASE.model}, effort ${BASE.effort}, ${RUNS} run(s) per case\n`)
  const jobs = Array.from({ length: RUNS }, () => CASES).flat()
  const results = await pool(jobs, 4, async ([expected, text]) => ({ expected, text, turn: (await converse([text]))[0]! }))

  let jevHit = 0
  let finalHit = 0
  let under = 0
  let over = 0
  let silent = 0
  const effortByTier = new Map<Tier, number[]>()
  for (const { expected, text, turn } of results) {
    const jev = turn.decision?.tier ?? null
    const final = tierOf(turn.model)
    const lo = Math.min(...expected.map(t => TIER_ORDER.indexOf(t)))
    const hi = Math.max(...expected.map(t => TIER_ORDER.indexOf(t)))
    const got = final ? TIER_ORDER.indexOf(final) : -1
    const ok = got >= lo && got <= hi
    if (!turn.decision) silent++
    if (jev && expected.includes(jev)) jevHit++
    if (ok) finalHit++
    else if (got < lo) under++
    else over++
    if (turn.decision?.effort != null && expected.length === 1) {
      effortByTier.set(expected[0]!, [...(effortByTier.get(expected[0]!) ?? []), turn.decision.effort])
    }
    const conf = turn.decision?.confidence?.toFixed(2) ?? '-'
    console.log(`${ok ? '✓' : '✗'} want ${expected.join('|').padEnd(14)} jev ${(jev ?? 'none').padEnd(9)} ${conf} → ${turn.model.replace('claude-', '')}/${turn.effort}  ${short(text)}`)
  }

  const n = results.length
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const means = (['fast', 'balanced', 'deep'] as Tier[]).map(t => mean(effortByTier.get(t) ?? [NaN]))
  const effortOk = means[0]! <= means[1]! && means[1]! <= means[2]!
  const latencies = results.map(r => r.turn.ms).sort((a, b) => a - b)
  const accuracy = finalHit / n

  console.log(`\nJev tier accuracy      ${jevHit}/${n}  (before the policy thresholds)`)
  console.log(`Final model accuracy   ${finalHit}/${n}  = ${(accuracy * 100).toFixed(0)}%  (too cheap ${under}, too costly ${over})`)
  console.log(`Effort score by tier   fast ${means[0]!.toFixed(1)}  balanced ${means[1]!.toFixed(1)}  deep ${means[2]!.toFixed(1)}  ${effortOk ? '✓ rises' : '✗ not rising'}`)
  console.log(`Latency                p50 ${latencies[Math.floor(n / 2)]}ms  max ${latencies[n - 1]}ms  (timeout ${options.timeoutMs ?? 800}ms, no answer ${silent})`)

  console.log('\nCONVERSATIONS')
  let allOk = accuracy >= MIN_ACCURACY && effortOk && silent === 0
  const runs = await pool(SCENARIOS, 3, async s => ({ s, turns: await converse(s.steps) }))
  for (const { s, turns } of runs) {
    console.log(`\n${s.name}`)
    for (const t of turns) {
      const tier = t.decision ? `${t.decision.tier} ${t.decision.confidence?.toFixed(2)}` : 'no answer'
      const newTask = t.decision?.newTask != null ? ` new ${t.decision.newTask.toFixed(2)}` : ''
      console.log(`   ${t.held ? 'HELD' : t.model.replace('claude-', '').padEnd(12)} jev ${tier}${newTask}  ${short(t.text, 50)}`)
    }
    for (const c of s.checks(turns)) {
      console.log(`   ${c.ok ? '✓' : '✗'} ${c.label}`)
      allOk &&= c.ok
    }
  }
  console.log(`\nSIM ${allOk ? 'PASS' : 'FAIL'}  (accuracy bar ${(MIN_ACCURACY * 100).toFixed(0)}%)`)
  return allOk
}

// ---------------------------------------------------------------- run: audit

interface Session {
  file: string
  start: string
  firstPrompt: string
  firstJev: string
  segments: string[][]
}

function readSession(file: string): Session | null {
  const session: Session = { file, start: '', firstPrompt: '', firstJev: '', segments: [[]] }
  let routed = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (!session.start && row.timestamp) session.start = row.timestamp
    const content = typeof row.content === 'string' ? row.content : ''
    if (row.type === 'system' && content.includes('[Jev Model Router]')) {
      routed = true
      const jev = /jev: tier (\w+) \(([\d.]+)\)/.exec(content)
      if (jev && !session.firstJev) session.firstJev = `${jev[1]} ${jev[2]}`
    } else if (row.type === 'system' && row.subtype === 'compact_boundary') {
      session.segments.push([])
    } else if (row.type === 'user' && !row.isMeta && !session.firstPrompt && typeof row.message?.content === 'string') {
      session.firstPrompt = row.message.content
    } else if (row.type === 'assistant' && !row.isSidechain && row.message?.model && row.message.model !== '<synthetic>') {
      const segment = session.segments.at(-1)!
      if (segment.at(-1) !== row.message.model) segment.push(row.message.model)
    }
  }
  return routed ? session : null
}

function audit(): boolean {
  const root = join(homedir(), '.claude/projects')
  const files = readdirSync(root).flatMap(dir => {
    try {
      return readdirSync(join(root, dir))
        .filter(f => f.endsWith('.jsonl'))
        .map(f => join(root, dir, f))
        .filter(f => statSync(f).mtimeMs >= SINCE)
    } catch {
      return []
    }
  })
  const sessions = files
    .map(readSession)
    .filter((s): s is Session => !!s && new Date(s.start).getTime() >= SINCE)
    .sort((a, b) => a.start.localeCompare(b.start))

  console.log(`AUDIT  ${sessions.length} session(s) started since ${new Date(SINCE).toISOString().slice(0, 16)}Z with the router active\n`)
  let switched = 0
  let mismatched = 0
  for (const s of sessions) {
    const first = s.segments[0]![0]
    const [jevTier] = s.firstJev.split(' ')
    const pickOk = !first || !jevTier || tierOf(first) === jevTier
    const steady = s.segments.every(seg => seg.length <= 1)
    if (!steady) switched++
    if (!pickOk) mismatched++
    const models = s.segments.map(seg => seg.map(m => m.replace('claude-', '')).join(' → ') || '-').join(' | compact | ')
    console.log(`${steady ? '✓' : '✗'} ${s.start.slice(5, 16)}  jev ${(s.firstJev || '-').padEnd(14)} ${pickOk ? ' ' : '≠'} ${models.padEnd(26)} ${short(s.firstPrompt.replace(/\s+/g, ' '), 44)}`)
  }
  console.log(`\nSessions that switched model mid-chat   ${switched}/${sessions.length}`)
  console.log(`First model differs from Jev's tier      ${mismatched}/${sessions.length}  (a policy threshold may explain it)`)
  console.log(`AUDIT ${switched === 0 ? 'PASS' : 'FAIL'}`)
  return switched === 0
}

const results: boolean[] = []
if (ONLY !== 'audit') results.push(await sim())
if (ONLY !== 'sim') {
  if (results.length) console.log('\n' + '-'.repeat(60) + '\n')
  results.push(audit())
}
process.exit(results.every(Boolean) ? 0 : 1)
