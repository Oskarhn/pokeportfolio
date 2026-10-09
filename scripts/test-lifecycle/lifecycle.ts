/**
 * `pnpm lifecycle <command>` — start, use and safely stop a task-owned local Supabase stack (P210).
 * The ownership rules live in lifecycle-core.ts; docs/DEVELOPMENT.md §4.1 is the operator guide.
 *
 *   pnpm lifecycle inventory [--json]                 read-only: every container group and who owns it
 *   pnpm lifecycle up --name p210 [--base-port N]     start a new isolated stack and record it
 *   pnpm lifecycle env --name p210 [--format sh|ps1]  print the connection variables of that stack
 *   pnpm lifecycle run --name p210 [--keep-stack] -- <command...>
 *                                                     up (if needed) + run + always down on exit/signal
 *   pnpm lifecycle down --name p210                   stop that stack only (volumes preserved)
 *   pnpm lifecycle recover [--name p210] [--execute]  dry-run by default: abandoned task-owned stacks
 *
 * Never used: `supabase stop --all`, `--no-backup`, docker prune/rm by pattern, wsl --shutdown,
 * stopping Docker Desktop, killing processes by executable name.
 *
 * Signals: SIGINT/SIGTERM/SIGHUP (and SIGBREAK on Windows) trigger cleanup in `run`. A hard kill
 * (taskkill /F, SIGKILL, power loss, a usage-limit termination) cannot be caught: `recover` exists
 * for exactly that case.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LABEL_PROJECT,
  LABEL_WORKDIR,
  LEDGER_VERSION,
  PORT_OFFSETS,
  TOOL_ID,
  buildInventory,
  deriveConfigToml,
  judgeProcess,
  ownerIsAlive,
  parseStatusEnv,
  planStackStop,
  projectIdFor,
  protectedProjects,
  runningCount,
  stackPorts,
  unrelatedChanges,
  type ContainerInfo,
  type LedgerEntry,
  type LiveProcess,
  type ProcessRecord,
} from './lifecycle-core'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ledgerDir = process.env.PP_LIFECYCLE_HOME ?? join(homedir(), '.pokeportfolio-test-lifecycle')
const isWindows = process.platform === 'win32'

// ---------------------------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------------------------

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export function exec(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      args,
      {
        env: opts.env ?? process.env,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolvePromise({ code, stdout, stderr })
      },
    )
  })
}

/** Docker prints "2026-10-09 19:12:33 +0200 CEST"; keep the first three tokens as an ISO instant. */
export function parsePsCreatedAt(value: string): string {
  const [date, time, offset] = value.split(' ')
  if (date === undefined || time === undefined || offset === undefined) return value
  return `${date}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`
}

const PS_FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.Image}}',
  '{{.State}}',
  '{{.CreatedAt}}',
  `{{.Label "${LABEL_PROJECT}"}}`,
  `{{.Label "${LABEL_WORKDIR}"}}`,
  '{{.Label "com.docker.compose.project"}}',
].join('\t')

/**
 * One `docker ps` call. (`docker inspect` over ~100 containers took 21 s on a loaded Docker Desktop;
 * this takes about 3 s.) Timestamps have one-second resolution, which planStackStop tolerates.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const result = await exec('docker', ['ps', '-a', '--no-trunc', '--format', PS_FORMAT])
  if (result.code !== 0)
    throw new Error(`docker ps failed: ${result.stderr.trim() || 'is Docker running?'}`)
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const [
        id = '',
        name = '',
        image = '',
        state = '',
        createdAt = '',
        project,
        workdir,
        compose,
      ] = line.split('\t')
      const labels: Record<string, string> = {}
      if (project) labels[LABEL_PROJECT] = project
      if (workdir) labels[LABEL_WORKDIR] = workdir
      if (compose) labels['com.docker.compose.project'] = compose
      return { id, name, image, state, createdAt: parsePsCreatedAt(createdAt), labels }
    })
}

async function listProjectVolumes(projectId: string): Promise<string[]> {
  const result = await exec('docker', ['volume', 'ls', '--format', '{{.Name}}'])
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .filter((name) => name.startsWith('supabase_') && name.endsWith(`_${projectId}`))
    .sort()
}

/** What the OS says about a pid: start-time token + command line, or null when it does not exist. */
export async function probeProcess(pid: number): Promise<LiveProcess | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (isWindows) {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
      `if ($null -eq $p) { exit 3 }; ` +
      `[Console]::Out.Write(($p.CreationDate.ToUniversalTime().ToString('o')) + "|" + $p.CommandLine)`
    const result = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        timeoutMs: 30_000,
      },
    )
    if (result.code !== 0) return null
    const split = result.stdout.indexOf('|')
    return { startTime: result.stdout.slice(0, split), commandLine: result.stdout.slice(split + 1) }
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const afterName = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    return { startTime: afterName[19] ?? '', commandLine }
  } catch {
    return null
  }
}

/** Kill exactly this pid and its descendants. The caller has already judged the pid verified. */
async function killVerifiedTree(pid: number): Promise<void> {
  if (isWindows) {
    await exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 30_000 })
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
}

function supabaseCli(): { file: string; prefix: string[] } {
  const override = process.env.PP_SUPABASE_CLI
  if (override) return { file: override, prefix: [] }
  const script = join(repoRoot, 'node_modules', 'supabase', 'dist', 'supabase.js')
  if (!existsSync(script))
    throw new Error(`supabase CLI not installed at ${script}; run pnpm install`)
  return { file: process.execPath, prefix: [script] }
}

function runSupabase(args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const cli = supabaseCli()
  return exec(cli.file, [...cli.prefix, ...args], opts)
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

export function ledgerPath(name: string): string {
  return join(ledgerDir, `${name}.json`)
}

export function readEntry(name: string): LedgerEntry | null {
  try {
    return JSON.parse(readFileSync(ledgerPath(name), 'utf8')) as LedgerEntry
  } catch {
    return null
  }
}

export function writeEntry(entry: LedgerEntry): void {
  mkdirSync(ledgerDir, { recursive: true })
  writeFileSync(ledgerPath(entry.name), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
}

function readAllEntries(): LedgerEntry[] {
  if (!existsSync(ledgerDir)) return []
  const entries: LedgerEntry[] = []
  for (const file of readdirSync(ledgerDir)) {
    if (!file.endsWith('.json')) continue
    const entry = readEntry(file.slice(0, -5))
    if (entry?.tool === TOOL_ID) entries.push(entry)
  }
  return entries
}

async function selfRecord(): Promise<LedgerEntry['owner']> {
  const live = await probeProcess(process.pid)
  return { pid: process.pid, startTime: live?.startTime ?? '', host: hostname() }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => {
      resolvePromise(false)
    })
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolvePromise(true)
      })
    })
  })
}

function defaultWorkdir(name: string): string {
  return join(ledgerDir, 'stacks', name)
}

async function cmdInventory(json: boolean): Promise<number> {
  const containers = await listContainers()
  const entries = readAllEntries()
  const alive = new Map<string, boolean>()
  for (const entry of entries) {
    alive.set(entry.name, ownerIsAlive(entry.owner, await probeProcess(entry.owner.pid)))
  }
  const groups = buildInventory({
    containers,
    entries,
    ownerAliveByName: alive,
    protectedIds: protectedProjects(process.env.PP_LIFECYCLE_PROTECTED),
  })
  if (json) {
    log(
      JSON.stringify(
        { running: runningCount(containers), total: containers.length, groups },
        null,
        2,
      ),
    )
    return 0
  }
  log(
    `containers: ${runningCount(containers)} running / ${containers.length} total (read-only listing)`,
  )
  for (const g of groups) {
    log(
      `  ${g.classification.padEnd(10)} ${g.project.padEnd(44)} running ${g.running}/${g.total}` +
        (g.note ? `  [${g.note}]` : ''),
    )
  }
  log(
    'only "task-owned", "task-detached" and "abandoned" groups can ever be stopped by this tool; the rest are never touched.',
  )
  return 0
}

interface UpOptions {
  name: string
  basePort: number
  workdir: string
  registryUrl: string
}

async function cmdUp(
  opts: UpOptions,
): Promise<{ entry: LedgerEntry; env: Record<string, string> }> {
  const projectId = projectIdFor(opts.name)
  if (protectedProjects(process.env.PP_LIFECYCLE_PROTECTED).has(projectId)) {
    throw new Error(`${projectId} is protected; choose another --name`)
  }
  const existing = readEntry(opts.name)
  if (existing && existing.state !== 'stopped') {
    throw new Error(
      `ledger entry "${opts.name}" is ${existing.state}; run "pnpm lifecycle down --name ${opts.name}" or recover first`,
    )
  }
  const before = await listContainers()
  if (before.some((c) => c.labels[LABEL_PROJECT] === projectId)) {
    throw new Error(
      `containers labelled ${projectId} already exist and are not in the ledger; refusing to adopt them`,
    )
  }
  for (const port of stackPorts(opts.basePort)) {
    if (!(await portIsFree(port)))
      throw new Error(`port ${port} is in use; pick another --base-port`)
  }
  if (!existsSync(join(repoRoot, 'node_modules', 'supabase')))
    throw new Error('run pnpm install first')

  // Workdir: a snapshot of supabase/ with a unique project id and port block.
  const source = join(repoRoot, 'supabase')
  const target = join(opts.workdir, 'supabase')
  rmSync(target, { recursive: true, force: true })
  mkdirSync(opts.workdir, { recursive: true })
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !/[\\/](\.temp|\.branches|snippets)([\\/]|$)/.test(path),
  })
  const baseConfig = readFileSync(join(source, 'config.toml'), 'utf8')
  writeFileSync(
    join(target, 'config.toml'),
    deriveConfigToml(baseConfig, projectId, opts.basePort),
    'utf8',
  )

  const entry: LedgerEntry = {
    tool: TOOL_ID,
    version: LEDGER_VERSION,
    name: opts.name,
    projectId,
    workdir: opts.workdir,
    createdAt: new Date().toISOString(),
    kind: 'detached',
    owner: await selfRecord(),
    state: 'starting',
    containers: [],
    processes: [],
    counts: { runningBefore: runningCount(before) },
  }
  writeEntry(entry)
  log(`ledger: ${ledgerPath(opts.name)}`)
  log(`containers running before start: ${entry.counts.runningBefore}`)

  const registryToken = randomBytes(24).toString('hex')
  const registryKey = randomBytes(32).toString('hex')
  const startEnv = {
    ...process.env,
    ERASURE_REGISTRY_URL: opts.registryUrl,
    ERASURE_REGISTRY_TOKEN: registryToken,
    ERASURE_REGISTRY_KEY: registryKey,
  }
  log(`starting ${projectId} (api port ${opts.basePort + PORT_OFFSETS.api}) ...`)
  const started = await runSupabase(['start', '--workdir', opts.workdir], { env: startEnv })
  const afterStart = await listContainers()
  const mine = afterStart.filter((c) => c.labels[LABEL_PROJECT] === projectId)
  entry.containers = mine.map((c) => ({ id: c.id, name: c.name }))
  writeEntry(entry)

  if (started.code !== 0) {
    log(`supabase start failed (exit ${started.code}); cleaning up what this attempt created`)
    log(started.stderr.split(/\r?\n/).slice(-8).join('\n'))
    entry.state = 'failed'
    writeEntry(entry)
    await stopStack(entry, 'own', true)
    throw new Error('stack start failed; partial containers were stopped (volumes kept)')
  }

  entry.state = 'running'
  entry.counts.runningAfterStart = runningCount(afterStart)
  writeEntry(entry)

  const status = await runSupabase(['status', '-o', 'env', '--workdir', opts.workdir])
  const parsed = parseStatusEnv(status.stdout)
  const dbContainer = mine.find((c) => c.name.startsWith('supabase_db_'))?.name ?? ''
  const env: Record<string, string> = {
    SUPABASE_URL: parsed.API_URL ?? '',
    SUPABASE_ANON_KEY: parsed.ANON_KEY ?? '',
    SUPABASE_SERVICE_ROLE_KEY: parsed.SERVICE_ROLE_KEY ?? '',
    DB_URL: parsed.DB_URL ?? '',
    P153_DB_URL: parsed.DB_URL ?? '',
    P156_DB_CONTAINER: dbContainer,
    ERASURE_REGISTRY_URL: opts.registryUrl,
    ERASURE_REGISTRY_TOKEN: registryToken,
    ERASURE_REGISTRY_KEY: registryKey,
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !dbContainer) {
    await stopStack(entry, 'own', true)
    throw new Error('stack started but connection details could not be read; stack was stopped')
  }
  writeFileSync(join(opts.workdir, 'env.json'), `${JSON.stringify(env, null, 2)}\n`, 'utf8')

  // P130-12: every migrated database schedules POSTs to the hosted edge functions. Deactivate them
  // immediately; a stack that stays up must never call Production.
  const cron = await exec('docker', [
    'exec',
    dbContainer,
    'psql',
    '-U',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    'select count(*) from (select cron.alter_job(jobid, active := false) from cron.job) j;',
  ])
  log(
    `recurring cron jobs deactivated: ${cron.code === 0 ? cron.stdout.trim() : `FAILED (${cron.stderr.trim()})`}`,
  )
  if (cron.code !== 0) {
    await stopStack(entry, 'own', true)
    throw new Error(
      'could not deactivate cron jobs; stack was stopped rather than left calling Production',
    )
  }
  log(
    `containers running after start: ${entry.counts.runningAfterStart} (this stack: ${mine.length})`,
  )
  return { entry, env }
}

/** Stop one stack, only on positive ownership evidence. Returns true when nothing of it remains. */
async function stopStack(
  entry: LedgerEntry,
  mode: 'own' | 'recover',
  callerIsOwner: boolean,
  explicit = false,
): Promise<boolean> {
  const before = await listContainers()
  const ownerLive = await probeProcess(entry.owner.pid)
  const plan = planStackStop({
    entry,
    containers: before,
    protectedIds: protectedProjects(process.env.PP_LIFECYCLE_PROTECTED),
    mode,
    ownerAlive: ownerIsAlive(entry.owner, ownerLive),
    callerIsOwner,
    explicit,
  })
  if (plan.action === 'refuse') {
    log(`REFUSED to stop ${entry.projectId}:`)
    for (const reason of plan.reasons) log(`  - ${reason}`)
    return false
  }
  if (plan.action === 'noop') {
    log(`${entry.projectId}: nothing to stop (${plan.reason})`)
    entry.state = 'stopped'
    entry.stoppedAt = new Date().toISOString()
    writeEntry(entry)
    return true
  }

  const volumesBefore = await listProjectVolumes(entry.projectId)
  log(
    `stopping ${plan.projectId} (${plan.containerIds.length} containers; volumes are preserved) ...`,
  )
  // Exactly one stack, by working directory. No --all, no --no-backup.
  const stopped = await runSupabase(['stop', '--workdir', plan.workdir])
  if (stopped.code !== 0)
    log(`supabase stop exit ${stopped.code}: ${stopped.stderr.trim().split(/\r?\n/).pop()}`)

  const after = await listContainers()
  const leftovers = after.filter((c) => c.labels[LABEL_PROJECT] === entry.projectId)
  const volumesAfter = await listProjectVolumes(entry.projectId)
  const collateral = unrelatedChanges(before, after, entry.projectId)
  entry.counts.runningAfterStop = runningCount(after)
  if (leftovers.length === 0) {
    entry.state = 'stopped'
    entry.stoppedAt = new Date().toISOString()
  }
  writeEntry(entry)
  log(
    `containers running before/after stop: ${runningCount(before)} -> ${runningCount(after)}; ` +
      `volumes before/after: ${volumesBefore.length}/${volumesAfter.length}`,
  )
  if (volumesAfter.length < volumesBefore.length) log('WARNING: project volumes disappeared')
  if (collateral.length > 0) log(`WARNING: unrelated containers changed: ${collateral.join('; ')}`)
  if (leftovers.length > 0)
    log(`WARNING: ${leftovers.length} container(s) of ${entry.projectId} remain`)
  return (
    leftovers.length === 0 && collateral.length === 0 && volumesAfter.length >= volumesBefore.length
  )
}

async function stopRecordedProcesses(entry: LedgerEntry): Promise<void> {
  for (const record of entry.processes) {
    const verdict = judgeProcess(record, await probeProcess(record.pid))
    if (verdict.action === 'kill') {
      log(`stopping task-owned process ${record.pid} (${record.role}) and its children`)
      await killVerifiedTree(record.pid)
    } else if (verdict.action === 'refuse') {
      log(`NOT stopping pid ${record.pid}: ${verdict.reason}`)
    }
  }
  entry.processes = []
  writeEntry(entry)
}

async function cmdDown(name: string): Promise<number> {
  const entry = readEntry(name)
  if (!entry) {
    log(`no ledger entry "${name}"; nothing is stopped (this tool only stops what it started)`)
    return 0
  }
  const ownerLive = ownerIsAlive(entry.owner, await probeProcess(entry.owner.pid))
  if (entry.kind === 'attached' && ownerLive) {
    log(
      `REFUSED: ${entry.projectId} is owned by the running process ${entry.owner.pid}; stop that process (Ctrl+C) instead`,
    )
    return 1
  }
  await stopRecordedProcesses(entry)
  // A detached entry is stopped by the operator who names it; an attached one whose owner died is recovery.
  const detached = entry.kind === 'detached'
  return (await stopStack(entry, detached ? 'own' : 'recover', detached, true)) ? 0 : 1
}

async function cmdRecover(name: string | undefined, execute: boolean): Promise<number> {
  const containers = await listContainers()
  const entries = readAllEntries().filter((e) => (name ? e.name === name : true))
  const protectedIds = protectedProjects(process.env.PP_LIFECYCLE_PROTECTED)
  let failed = false
  log(
    execute
      ? 'RECOVER (executing)'
      : 'RECOVER (dry run; pass --execute to stop abandoned task-owned stacks)',
  )
  for (const entry of entries) {
    if (entry.state === 'stopped') continue
    const ownerLive = await probeProcess(entry.owner.pid)
    const plan = planStackStop({
      entry,
      containers,
      protectedIds,
      mode: 'recover',
      ownerAlive: ownerIsAlive(entry.owner, ownerLive),
      callerIsOwner: false,
      explicit: name !== undefined,
    })
    if (plan.action === 'stop') {
      log(
        `  would stop ${plan.projectId}: ${plan.containerIds.length} containers, workdir ${plan.workdir}`,
      )
      if (execute) {
        await stopRecordedProcesses(entry)
        if (!(await stopStack(entry, 'recover', false, name !== undefined))) failed = true
      }
    } else if (plan.action === 'noop') {
      log(`  ${entry.projectId}: ${plan.reason}`)
      if (execute) await stopStack(entry, 'recover', false, name !== undefined)
    } else {
      failed = true
      log(`  AMBIGUOUS/REFUSED ${entry.projectId}: ${plan.reasons.join('; ')}`)
    }
  }
  const known = new Set(entries.map((e) => e.projectId))
  const unowned = new Set(
    containers
      .map((c) => c.labels[LABEL_PROJECT])
      .filter((p): p is string => p !== undefined && !known.has(p)),
  )
  for (const project of unowned) log(`  not mine, left alone: ${project}`)
  return failed ? 1 : 0
}

function formatEnv(env: Record<string, string>, format: string): string {
  const lines = Object.entries(env).map(([k, v]) =>
    format === 'ps1'
      ? `$env:${k} = '${v.replace(/'/g, "''")}'`
      : `export ${k}='${v.replace(/'/g, `'\\''`)}'`,
  )
  return lines.join('\n')
}

function readStackEnv(name: string): Record<string, string> {
  const entry = readEntry(name)
  if (!entry) throw new Error(`no ledger entry "${name}"`)
  return JSON.parse(readFileSync(join(entry.workdir, 'env.json'), 'utf8')) as Record<string, string>
}

async function cmdRun(base: UpOptions, keepStack: boolean, command: string[]): Promise<number> {
  const [file, ...args] = command
  if (file === undefined) throw new Error('run needs a command after --')
  let startedHere = false
  const entry0 = readEntry(base.name)
  let env: Record<string, string>
  if (entry0 && entry0.state === 'running') {
    log(`reusing running stack ${entry0.projectId}`)
    env = readStackEnv(base.name)
  } else {
    env = (await cmdUp(base)).env
    startedHere = true
  }
  const entry = readEntry(base.name)
  if (!entry) throw new Error('ledger entry vanished')
  // From here this process owns the stack: if it dies without cleaning up, `recover` may stop it.
  if (startedHere) {
    entry.kind = 'attached'
    entry.owner = await selfRecord()
    writeEntry(entry)
  }

  let child: ChildProcess | undefined
  let cleaned = false
  const cleanup = async (reason: string): Promise<void> => {
    if (cleaned) return
    cleaned = true
    log(`lifecycle: cleaning up (${reason})`)
    const fresh = readEntry(base.name) ?? entry
    await stopRecordedProcesses(fresh)
    if (startedHere && !keepStack) await stopStack(fresh, 'own', true)
    else if (!keepStack) log('stack was not started by this invocation; leaving it (use down)')
  }
  const signals: NodeJS.Signals[] = [
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
    ...(isWindows ? (['SIGBREAK'] as NodeJS.Signals[]) : []),
  ]
  for (const signal of signals) {
    process.on(signal, () => {
      void cleanup(`signal ${signal}`).then(() => process.exit(130))
    })
  }
  process.on('uncaughtException', (error) => {
    log(`lifecycle: uncaught ${error.message}`)
    void cleanup('uncaught exception').then(() => process.exit(1))
  })

  const code = await new Promise<number>((resolvePromise) => {
    child = spawn(file, args, {
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: isWindows && /\.(cmd|bat)$/i.test(file),
      detached: !isWindows,
    })
    child.once('error', (error) => {
      log(`lifecycle: could not start command: ${error.message}`)
      resolvePromise(127)
    })
    child.once('spawn', () => {
      void (async () => {
        const pid = child?.pid
        if (pid === undefined) return
        const live = await probeProcess(pid)
        if (live) {
          const record: ProcessRecord = {
            pid,
            startTime: live.startTime,
            commandLine: live.commandLine,
            role: 'run-command',
          }
          const fresh = readEntry(base.name) ?? entry
          fresh.processes.push(record)
          writeEntry(fresh)
        }
      })()
    })
    child.once('close', (exitCode) => {
      resolvePromise(exitCode ?? 1)
    })
  })
  await cleanup('command finished')
  return code
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

interface Parsed {
  command: string
  flags: Map<string, string | true>
  rest: string[]
}

function parseArgs(argv: string[]): Parsed {
  const [command = 'help', ...tail] = argv
  const flags = new Map<string, string | true>()
  let rest: string[] = []
  for (let i = 0; i < tail.length; i += 1) {
    const item = tail[i] as string
    if (item === '--') {
      rest = tail.slice(i + 1)
      break
    }
    if (!item.startsWith('--')) throw new Error(`unexpected argument "${item}"`)
    const key = item.slice(2)
    const next = tail[i + 1]
    if (['json', 'execute', 'keep-stack'].includes(key)) flags.set(key, true)
    else if (next === undefined || next.startsWith('--')) throw new Error(`--${key} needs a value`)
    else {
      flags.set(key, next)
      i += 1
    }
  }
  return { command, flags, rest }
}

function upOptions(flags: Map<string, string | true>): UpOptions {
  const name = flags.get('name')
  if (typeof name !== 'string') throw new Error('--name is required')
  const basePort = Number(flags.get('base-port') ?? 57010)
  if (!Number.isInteger(basePort) || basePort < 1024 || basePort + 80 > 65535) {
    throw new Error('--base-port must be an integer in 1024..65455')
  }
  const workdir =
    typeof flags.get('workdir') === 'string'
      ? resolve(flags.get('workdir') as string)
      : defaultWorkdir(name)
  const registryUrl =
    typeof flags.get('registry-url') === 'string' ? (flags.get('registry-url') as string) : ''
  return { name, basePort, workdir, registryUrl }
}

async function main(): Promise<number> {
  const { command, flags, rest } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'inventory':
      return cmdInventory(flags.get('json') === true)
    case 'up': {
      const { entry } = await cmdUp(upOptions(flags))
      log(
        `stack ${entry.projectId} is running. Connection variables: pnpm lifecycle env --name ${entry.name}`,
      )
      log(`Stop it with: pnpm lifecycle down --name ${entry.name}`)
      return 0
    }
    case 'env': {
      const name = flags.get('name')
      if (typeof name !== 'string') throw new Error('--name is required')
      log(
        formatEnv(
          readStackEnv(name),
          typeof flags.get('format') === 'string' ? (flags.get('format') as string) : 'sh',
        ),
      )
      return 0
    }
    case 'run':
      return cmdRun(upOptions(flags), flags.get('keep-stack') === true, rest)
    case 'down': {
      const name = flags.get('name')
      if (typeof name !== 'string') throw new Error('--name is required')
      return cmdDown(name)
    }
    case 'recover':
      return cmdRecover(
        typeof flags.get('name') === 'string' ? (flags.get('name') as string) : undefined,
        flags.get('execute') === true,
      )
    default:
      log(
        'commands: inventory | up | env | run | down | recover   (see the header of scripts/test-lifecycle/lifecycle.ts)',
      )
      return command === 'help' ? 0 : 2
  }
}

// Importable by selftest.ts; runs as a CLI only when executed directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`lifecycle: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
