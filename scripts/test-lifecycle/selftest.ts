/**
 * `pnpm lifecycle:selftest` — live proof of the lifecycle tool against a SYNTHETIC isolated stack
 * (P210). Needs Docker and the image `node:22-alpine`; touches nothing but what it creates.
 *
 * The synthetic stack is a handful of tiny containers that carry exactly the labels the Supabase CLI
 * puts on a real stack (`com.supabase.cli.project`, `com.supabase.cli.workdir`), so the real
 * `supabase stop --workdir` path runs against them. Bystanders — a container of another project, a
 * look-alike project id, an unlabelled container, and plain node processes — must survive every step.
 *
 * Exit 0 only if every assertion holds. Everything created here is removed by exact name/pid.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LABEL_PROJECT,
  LABEL_WORKDIR,
  LEDGER_VERSION,
  TOOL_ID,
  deriveConfigToml,
  type LedgerEntry,
} from './lifecycle-core'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const home = mkdtempSync(join(tmpdir(), 'pp-lifecycle-selftest-'))
process.env.PP_LIFECYCLE_HOME = home // read by lifecycle.ts at import time
const io = await import('./lifecycle')

const suffix = Math.random().toString(36).slice(2, 7)
const NAME = `st${suffix}`
const PROJECT = `pokeportfolio-${NAME}`
const workdir = join(home, 'stacks', NAME)
const createdContainers: string[] = []
const createdVolumes: string[] = []
const spawned: ChildProcess[] = []
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  (${detail})`}\n`)
}

async function docker(args: string[]): Promise<string> {
  const result = await io.exec('docker', args)
  if (result.code !== 0) throw new Error(`docker ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

async function runSynthetic(
  name: string,
  labels: Record<string, string>,
  hostConfig: string[] = [],
): Promise<string> {
  const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`])
  const id = await docker([
    'run',
    '-d',
    '--name',
    name,
    '--memory',
    '48m',
    ...labelArgs,
    ...hostConfig,
    'node:22-alpine',
    'node',
    '-e',
    'setInterval(()=>{},1e6)',
  ])
  createdContainers.push(name)
  return id
}

/** Every container on the host. Other workloads change state concurrently, so this is informational. */
async function snapshot(): Promise<Map<string, string>> {
  return new Map((await io.listContainers()).map((c) => [c.id, `${c.name}:${c.state}`]))
}

/**
 * Only the containers this test created (their names carry the random suffix): the strict
 * assertions run on these, because a busy host changes every other container concurrently.
 */
async function ownSnapshot(): Promise<string> {
  const mine = (await snapshot()).values()
  return JSON.stringify([...mine].filter((v) => v.includes(suffix)).sort())
}

function hostDiff(a: Map<string, string>, b: Map<string, string>, ignoreIds: string[]): string[] {
  return [...a.entries()]
    .filter(([id, v]) => !ignoreIds.includes(id) && !v.includes(suffix) && b.get(id) !== v)
    .map(([, v]) => v)
}

function lifecycleCli(args: string[]): Promise<{ code: number; out: string }> {
  return io
    .exec(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(repoRoot, 'scripts', 'test-lifecycle', 'lifecycle.ts'),
        ...args,
      ],
      {
        env: { ...process.env, PP_LIFECYCLE_HOME: home },
      },
    )
    .then((r) => ({ code: r.code, out: r.stdout + r.stderr }))
}

function spawnDummy(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  spawned.push(child)
  return child
}

async function alive(pid: number): Promise<boolean> {
  return (await io.probeProcess(pid)) !== null
}

try {
  process.stdout.write(`synthetic stack ${PROJECT}, ledger ${home}\n`)
  const baseline = await snapshot()

  // --- build a synthetic stack that looks like the CLI's -----------------------------------
  mkdirSync(join(workdir, 'supabase'), { recursive: true })
  writeFileSync(
    join(workdir, 'supabase', 'config.toml'),
    deriveConfigToml(
      readFileSync(join(repoRoot, 'supabase', 'config.toml'), 'utf8'),
      PROJECT,
      59800,
    ),
  )
  const stackLabels = { [LABEL_PROJECT]: PROJECT, [LABEL_WORKDIR]: workdir }
  const stackNames = ['supabase_db_', 'supabase_auth_', 'supabase_rest_'].map(
    (p) => `${p}${PROJECT}`,
  )
  const stackIds: string[] = []
  for (const name of stackNames) stackIds.push(await runSynthetic(name, stackLabels))
  const volume = `supabase_db_${PROJECT}`
  await docker(['volume', 'create', '--label', `${LABEL_PROJECT}=${PROJECT}`, volume])
  createdVolumes.push(volume)

  // bystanders: another project, a look-alike id, an unlabelled container
  await runSynthetic(`pp-bystander-other-${suffix}`, {
    [LABEL_PROJECT]: 'pokeportfolio-other',
    [LABEL_WORKDIR]: join(home, 'other'),
  })
  await runSynthetic(`pp-bystander-lookalike-${suffix}`, {
    [LABEL_PROJECT]: `${PROJECT}x`,
    [LABEL_WORKDIR]: workdir,
  })
  await runSynthetic(`pp-bystander-plain-${suffix}`, {})
  const bystanderNames = [`other`, `lookalike`, `plain`].map((p) => `pp-bystander-${p}-${suffix}`)

  const dummyOwned = spawnDummy()
  const dummyForeign = spawnDummy() // recorded with a wrong start time: must be refused
  const dummyBystander = spawnDummy() // not recorded at all
  await new Promise((r) => setTimeout(r, 1500))
  const liveOwned = await io.probeProcess(dummyOwned.pid ?? 0)
  const liveForeign = await io.probeProcess(dummyForeign.pid ?? 0)
  if (!liveOwned || !liveForeign) throw new Error('could not probe the dummy processes')

  const entry: LedgerEntry = {
    tool: TOOL_ID,
    version: LEDGER_VERSION,
    name: NAME,
    projectId: PROJECT,
    workdir,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    kind: 'detached',
    owner: { pid: process.pid, startTime: 'selftest', host: 'selftest' },
    state: 'running',
    containers: stackIds.map((id, i) => ({ id, name: stackNames[i] ?? '' })),
    processes: [
      {
        pid: dummyOwned.pid ?? 0,
        startTime: liveOwned.startTime,
        commandLine: liveOwned.commandLine,
        role: 'owned',
      },
      {
        pid: dummyForeign.pid ?? 0,
        startTime: 'not-the-real-start-time',
        commandLine: liveForeign.commandLine,
        role: 'recycled-pid',
      },
    ],
    counts: { runningBefore: baseline.size },
  }
  io.writeEntry(entry)
  const armedOwn = await ownSnapshot()

  // --- 1. inventory is read-only and classifies correctly ---------------------------------
  const inv = await lifecycleCli(['inventory', '--json'])
  const parsed = JSON.parse(inv.out.slice(inv.out.indexOf('{'))) as {
    groups: { project: string; classification: string }[]
  }
  const cls = (p: string): string | undefined =>
    parsed.groups.find((g) => g.project === p)?.classification
  check(
    'inventory: synthetic stack is task-detached',
    cls(PROJECT) === 'task-detached',
    String(cls(PROJECT)),
  )
  check('inventory: look-alike id is unowned', cls(`${PROJECT}x`) === 'unowned')
  check('inventory: other project is unowned', cls('pokeportfolio-other') === 'unowned')
  check('inventory changed nothing', (await ownSnapshot()) === armedOwn)

  // --- 2. bulk recover never touches a detached stack ---------------------------------------
  const bulk = await lifecycleCli(['recover', '--execute'])
  check(
    'bulk recover refuses a detached stack',
    /REFUSED|AMBIGUOUS/.test(bulk.out),
    bulk.out.slice(-200),
  )
  check('bulk recover changed nothing', (await ownSnapshot()) === armedOwn)

  // --- 3. an ambiguous container (same project label, other workdir) blocks the stop ------------
  await runSynthetic(`pp-ambiguous-${suffix}`, {
    [LABEL_PROJECT]: PROJECT,
    [LABEL_WORKDIR]: join(home, 'elsewhere'),
  })
  const refused = await lifecycleCli(['down', '--name', NAME])
  check(
    'down refuses when a same-label container has another workdir',
    refused.code === 1 && /REFUSED/.test(refused.out),
    refused.out.slice(-300),
  )
  const afterRefusal = JSON.parse(await ownSnapshot()) as string[]
  check(
    'refusal stopped nothing',
    (JSON.parse(armedOwn) as string[]).every((v) => afterRefusal.includes(v)),
  )
  await docker(['rm', '-f', `pp-ambiguous-${suffix}`]) // exact name, created by this test
  createdContainers.splice(createdContainers.indexOf(`pp-ambiguous-${suffix}`), 1)

  // --- 4. the real stop: only the stack, volumes kept, bystanders untouched ------------------
  const before = await snapshot()
  const down = await lifecycleCli(['down', '--name', NAME])
  check('down exits 0', down.code === 0, down.out.slice(-400))
  const after = await snapshot()
  check(
    'synthetic stack containers are gone',
    stackIds.every((id) => !after.has(id)),
  )
  const hostChanges = hostDiff(before, after, stackIds)
  process.stdout.write(
    `INFO  other workloads on this host changed during the stop: ${hostChanges.length === 0 ? 'none' : hostChanges.join(', ')}
`,
  )
  check(
    'bystander synthetic containers still running',
    bystanderNames.every((n) => [...after.values()].includes(`${n}:running`)),
  )
  const volumes = await docker(['volume', 'ls', '--format', '{{.Name}}'])
  check('project volume preserved', volumes.split(/\r?\n/).includes(volume))
  check('ledger marks the stack stopped', io.readEntry(NAME)?.state === 'stopped')

  // --- 5. processes: verified identity only --------------------------------------------------
  await new Promise((r) => setTimeout(r, 1500))
  check('verified task-owned process was stopped', !(await alive(dummyOwned.pid ?? 0)))
  check('process with a mismatching start time was NOT stopped', await alive(dummyForeign.pid ?? 0))
  check('unrecorded process was NOT stopped', await alive(dummyBystander.pid ?? 0))

  // --- 6. second down is a no-op ------------------------------------------------------------------
  const again = await lifecycleCli(['down', '--name', NAME])
  check('second down is a harmless no-op', again.code === 0)

  // --- 7. protected projects cannot be stopped even with a forged entry ---------------------------
  io.writeEntry({
    ...entry,
    name: 'p196c',
    projectId: 'pokeportfolio-p196c',
    state: 'running',
    kind: 'detached',
    processes: [],
  })
  const forged = await lifecycleCli(['down', '--name', 'p196c'])
  check(
    'forged ledger entry for the protected p196c stack is refused',
    forged.code === 1 && /protected/.test(forged.out),
    forged.out.slice(-200),
  )
  io.writeEntry({
    ...entry,
    name: 'pokeportfolio',
    projectId: 'pokeportfolio',
    state: 'running',
    kind: 'detached',
    processes: [],
  })
  const forgedDefault = await lifecycleCli(['down', '--name', 'pokeportfolio'])
  check(
    'forged ledger entry for the default stack is refused',
    forgedDefault.code === 1,
    forgedDefault.out.slice(-200),
  )
  const finalSnapshot = await snapshot()
  const gone = [...baseline.entries()].filter(([id]) => !finalSnapshot.has(id))
  process.stdout.write(
    `INFO  containers present at start and absent at the end: ${gone.length === 0 ? 'none' : gone.map(([, v]) => v).join(', ')}
`,
  )
} finally {
  for (const child of spawned) {
    if (child.pid !== undefined) child.kill() // our own children, by handle
  }
  for (const name of createdContainers) await io.exec('docker', ['rm', '-f', name]) // exact names
  for (const name of createdVolumes) await io.exec('docker', ['volume', 'rm', name]) // exact names
  rmSync(home, { recursive: true, force: true })
}

process.stdout.write(failures === 0 ? 'SELFTEST PASSED\n' : `SELFTEST FAILED (${failures})\n`)
process.exit(failures === 0 ? 0 : 1)
