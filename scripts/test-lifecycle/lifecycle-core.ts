/**
 * Local test-infrastructure lifecycle (P210): the decision logic, with every side effect injected.
 *
 * Why this exists. Automated sessions start Docker-backed Supabase stacks (11 containers, several GB
 * of RAM) and then end, crash or hit a usage limit without stopping them. Cleaning up by pattern
 * ("stop everything named supabase", "kill all node") is what destroys other people's work. The rule
 * here is the opposite: nothing is stopped unless POSITIVE EVIDENCE says this tool started it and the
 * live resource still matches that record. Anything else is reported and left alone.
 *
 * The evidence, for a stack:
 *   1. a ledger entry this tool wrote (outside every git checkout) naming the Supabase project id and
 *      the working directory it was started from;
 *   2. every live container carrying that project id has the same working-directory label, and was
 *      either recorded at start or created after the ledger entry (the CLI recreates containers);
 *   3. the project id is not on the protected list and is not the default stack;
 *   4. for recovery after a crash, the process that owned the entry is verifiably gone.
 * A container that carries the project id but fails (2) makes the whole stack AMBIGUOUS: the Supabase
 * CLI removes every container with the project label, so partial ownership is refusal, not a partial stop.
 *
 * For a child process the evidence is pid + process start time + command line, all recorded at spawn
 * and all re-checked before a kill (a recycled pid has a different start time).
 *
 * This module never imports docker, fs or child_process; lifecycle.ts supplies the adapters.
 */

export const TOOL_ID = 'pokeportfolio-test-lifecycle'
export const LEDGER_VERSION = 1
export const PROJECT_PREFIX = 'pokeportfolio-'

/** Stacks that must never be stopped by this tool, whatever the ledger says. */
export const DEFAULT_PROTECTED_PROJECTS: readonly string[] = [
  'pokeportfolio', // the default `supabase start` stack of the main checkout
  'pokeportfolio-p196c', // owner-designated: only the owner stops it
]

export const LABEL_PROJECT = 'com.supabase.cli.project'
export const LABEL_WORKDIR = 'com.supabase.cli.workdir'

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,23}$/

export interface ContainerInfo {
  id: string
  name: string
  image: string
  /** Docker state: running, exited, restarting, created, paused, dead. */
  state: string
  createdAt: string
  labels: Record<string, string>
}

export interface ProcessRecord {
  pid: number
  /** Opaque, platform-specific start-time token; equality is what matters. */
  startTime: string
  commandLine: string
  role: string
}

export interface LedgerEntry {
  tool: typeof TOOL_ID
  version: typeof LEDGER_VERSION
  name: string
  projectId: string
  workdir: string
  createdAt: string
  /**
   * attached: started by `run`, whose process owns it; when that process is gone the entry is abandoned.
   * detached: started by `up`, which exits; no process owns it, so only an explicit `down --name` or
   * `recover --name` (an operator naming the stack) may stop it. A bulk recover never will.
   */
  kind: 'attached' | 'detached'
  owner: { pid: number; startTime: string; host: string }
  state: 'starting' | 'running' | 'stopped' | 'failed'
  /** Container ids that existed with this project label after start. */
  containers: { id: string; name: string }[]
  processes: ProcessRecord[]
  /** The erasure-registry chain file this stack's test sink writes (removed when the stack stops). */
  registryChainFile?: string
  /** Counts for the audit trail the final report quotes. */
  counts: { runningBefore: number; runningAfterStart?: number; runningAfterStop?: number }
  stoppedAt?: string
}

export function projectIdFor(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`stack name must match ${String(NAME_PATTERN)} (got "${name}")`)
  }
  return `${PROJECT_PREFIX}${name}`
}

export function protectedProjects(extra: string | undefined): Set<string> {
  const set = new Set(DEFAULT_PROTECTED_PROJECTS)
  for (const item of (extra ?? '').split(',')) {
    const trimmed = item.trim()
    if (trimmed) set.add(trimmed)
  }
  return set
}

/** Compare working directories the way the CLI labels them, tolerating Windows spelling. */
export function sameDirectory(a: string, b: string): boolean {
  const norm = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function projectOf(container: ContainerInfo): string | undefined {
  return container.labels[LABEL_PROJECT] ?? container.labels['com.docker.compose.project']
}

// ---------------------------------------------------------------------------------------------
// Stack stop decision
// ---------------------------------------------------------------------------------------------

export type StopMode = 'own' | 'recover'

export type StopPlan =
  | { action: 'stop'; projectId: string; workdir: string; containerIds: string[] }
  | { action: 'noop'; reason: string }
  | { action: 'refuse'; reasons: string[] }

export interface StopContext {
  entry: LedgerEntry
  containers: readonly ContainerInfo[]
  protectedIds: ReadonlySet<string>
  mode: StopMode
  /** Whether the process that created the entry is still verifiably the same running process. */
  ownerAlive: boolean
  /** True when this very process is the owner (normal completion or a signal in `run`). */
  callerIsOwner: boolean
  /** True when an operator named this stack on the command line (down/recover --name). */
  explicit?: boolean
}

export function planStackStop(ctx: StopContext): StopPlan {
  const { entry } = ctx
  const refusals: string[] = []

  if ((entry.tool as string) !== TOOL_ID || (entry.version as number) !== LEDGER_VERSION) {
    return { action: 'refuse', reasons: ['ledger entry was not written by this tool/version'] }
  }
  if (!entry.projectId.startsWith(PROJECT_PREFIX)) {
    refusals.push(`project "${entry.projectId}" is outside the ${PROJECT_PREFIX}* namespace`)
  }
  if (entry.projectId !== `${PROJECT_PREFIX}${entry.name}`) {
    refusals.push('ledger project id does not match the ledger entry name')
  }
  if (ctx.protectedIds.has(entry.projectId)) {
    refusals.push(`project "${entry.projectId}" is protected and is never stopped by this tool`)
  }
  if (refusals.length > 0) return { action: 'refuse', reasons: refusals }

  if (entry.state === 'stopped') return { action: 'noop', reason: 'ledger says already stopped' }

  if (ctx.mode === 'own' && !ctx.callerIsOwner && !ctx.explicit) {
    refusals.push('this process is not the entry owner; use recover for abandoned entries')
  }
  if (ctx.mode === 'recover' && entry.kind === 'attached' && ctx.ownerAlive) {
    refusals.push(`owner process ${entry.owner.pid} is still running; not abandoned`)
  }
  if (ctx.mode === 'recover' && entry.kind === 'detached' && !ctx.explicit) {
    refusals.push('detached stack: no owner process to judge; name it with --name to stop it')
  }

  const recorded = new Set(entry.containers.map((c) => c.id))
  const created = Date.parse(entry.createdAt)
  const mine = ctx.containers.filter((c) => c.labels[LABEL_PROJECT] === entry.projectId)
  const ids: string[] = []
  for (const container of mine) {
    const workdir = container.labels[LABEL_WORKDIR]
    if (workdir === undefined || !sameDirectory(workdir, entry.workdir)) {
      refusals.push(
        `container ${container.name} carries project ${entry.projectId} but another working directory`,
      )
      continue
    }
    const knownId = recorded.has(container.id)
    // `docker ps` timestamps have one-second resolution; allow that much slack.
    const bornAfter = Date.parse(container.createdAt) + 1000 >= created
    if (!knownId && !bornAfter) {
      refusals.push(`container ${container.name} pre-dates the ledger entry and was never recorded`)
      continue
    }
    ids.push(container.id)
  }
  if (refusals.length > 0) return { action: 'refuse', reasons: refusals }
  if (ids.length === 0)
    return { action: 'noop', reason: 'no live container carries the project id' }
  return { action: 'stop', projectId: entry.projectId, workdir: entry.workdir, containerIds: ids }
}

// ---------------------------------------------------------------------------------------------
// Process stop decision
// ---------------------------------------------------------------------------------------------

export type ProcessVerdict =
  | { action: 'kill'; pid: number }
  | { action: 'gone'; pid: number }
  | { action: 'refuse'; pid: number; reason: string }

export interface LiveProcess {
  startTime: string
  commandLine: string
}

/**
 * `live` is what the OS reports for the pid right now (null = no such process). A pid that exists
 * with a different start time or command line is somebody else's process that inherited the number.
 */
export function judgeProcess(record: ProcessRecord, live: LiveProcess | null): ProcessVerdict {
  if (live === null) return { action: 'gone', pid: record.pid }
  if (live.startTime !== record.startTime) {
    return { action: 'refuse', pid: record.pid, reason: 'pid reused: start time differs' }
  }
  if (live.commandLine !== record.commandLine) {
    return { action: 'refuse', pid: record.pid, reason: 'command line differs from the record' }
  }
  return { action: 'kill', pid: record.pid }
}

export function ownerIsAlive(owner: LedgerEntry['owner'], live: LiveProcess | null): boolean {
  return live !== null && live.startTime === owner.startTime
}

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

export type Classification =
  | 'task-owned' // a ledger entry whose owning `run` process is alive
  | 'task-detached' // started by `up`; stopped only by an explicit `down --name`
  | 'abandoned' // attached entry whose owner is gone: recover would stop it
  | 'protected' // never touched
  | 'unowned' // no ledger evidence: some other workload; reported only

export interface InventoryGroup {
  project: string
  classification: Classification
  total: number
  running: number
  note?: string
}

export function buildInventory(args: {
  containers: readonly ContainerInfo[]
  entries: readonly LedgerEntry[]
  ownerAliveByName: ReadonlyMap<string, boolean>
  protectedIds: ReadonlySet<string>
}): InventoryGroup[] {
  const groups = new Map<string, ContainerInfo[]>()
  for (const container of args.containers) {
    const key = projectOf(container) ?? '(standalone)'
    const list = groups.get(key) ?? []
    list.push(container)
    groups.set(key, list)
  }
  const result: InventoryGroup[] = []
  for (const [project, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = args.entries.find((e) => e.projectId === project && e.state !== 'stopped')
    let classification: Classification = 'unowned'
    let note: string | undefined
    if (args.protectedIds.has(project)) {
      classification = 'protected'
    } else if (entry) {
      const plan = planStackStop({
        entry,
        containers: list,
        protectedIds: args.protectedIds,
        mode: 'recover',
        ownerAlive: false,
        callerIsOwner: false,
        explicit: true,
      })
      if (plan.action === 'refuse') {
        note = `ledger entry present but ambiguous: ${plan.reasons.join('; ')}`
      } else if (entry.kind === 'detached') {
        classification = 'task-detached'
      } else {
        classification = args.ownerAliveByName.get(entry.name) ? 'task-owned' : 'abandoned'
      }
    }
    result.push({
      project,
      classification,
      total: list.length,
      running: list.filter((c) => c.state === 'running').length,
      ...(note ? { note } : {}),
    })
  }
  return result
}

export function runningCount(containers: readonly ContainerInfo[]): number {
  return containers.filter((c) => c.state === 'running').length
}

/** A container that restarts in a loop flips between these on its own; that is not collateral. */
function isRestartFlap(from: string, to: string): boolean {
  const flap = new Set(['running', 'restarting'])
  return flap.has(from) && flap.has(to)
}

/**
 * After a stop: containers outside the stopped project must be exactly as before, apart from a
 * restart loop's own running/restarting flips (seen on other stacks' log-shipper containers). Returns the
 * differences, empty when nothing unrelated changed.
 */
export function unrelatedChanges(
  before: readonly ContainerInfo[],
  after: readonly ContainerInfo[],
  projectId: string,
): string[] {
  const afterById = new Map(after.map((c) => [c.id, c]))
  const problems: string[] = []
  for (const container of before) {
    if (container.labels[LABEL_PROJECT] === projectId) continue
    const now = afterById.get(container.id)
    if (now === undefined) problems.push(`${container.name} disappeared`)
    else if (now.state !== container.state && !isRestartFlap(container.state, now.state)) {
      problems.push(`${container.name} changed state ${container.state} -> ${now.state}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------
// Stack configuration derived from the repository's own supabase/config.toml
// ---------------------------------------------------------------------------------------------

/** Offsets from a base port, copied from the layout every earlier isolated stack used. */
export const PORT_OFFSETS = {
  api: 0,
  db: 1,
  studio: 2,
  inbucket: 3,
  analytics: 7,
  pooler: 8,
  shadow: 9,
  inspector: 73,
} as const

export function stackPorts(basePort: number): number[] {
  return Object.values(PORT_OFFSETS).map((offset) => basePort + offset)
}

/**
 * Rewrites project_id and the host ports of the repository config. Every replacement must hit
 * exactly one line; otherwise the config drifted and the tool refuses instead of guessing.
 */
export function deriveConfigToml(base: string, projectId: string, basePort: number): string {
  // A port line belongs to the nearest preceding [section]; the lazy match stops at the first one.
  const inSection = (section: string): RegExp =>
    new RegExp(String.raw`^(\[${section}\][^\[]*?\nport = )\d+$`, 'm')
  const port = (offset: number): string => `$1${String(basePort + offset)}`
  const replacements: [RegExp, string][] = [
    [/^project_id = ".*"$/m, `project_id = "${projectId}"`],
    [inSection('api'), port(PORT_OFFSETS.api)],
    [inSection('db'), port(PORT_OFFSETS.db)],
    [/^shadow_port = \d+$/m, `shadow_port = ${String(basePort + PORT_OFFSETS.shadow)}`],
    [inSection(String.raw`db\.pooler`), port(PORT_OFFSETS.pooler)],
    [inSection('studio'), port(PORT_OFFSETS.studio)],
    // The CLI renamed [inbucket] to [local_smtp]; accept either.
    [inSection('(?:inbucket|local_smtp)'), port(PORT_OFFSETS.inbucket)],
    [inSection('analytics'), port(PORT_OFFSETS.analytics)],
    [/^inspector_port = \d+$/m, `inspector_port = ${String(basePort + PORT_OFFSETS.inspector)}`],
  ]
  let out = base
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(out)) throw new Error(`config.toml drifted: no match for ${String(pattern)}`)
    out = out.replace(pattern, replacement)
  }
  return out
}

/** Parse `supabase status -o env` output without echoing anything. */
export function parseStatusEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) result[match[1]] = match[2]
  }
  return result
}
