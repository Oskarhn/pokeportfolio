import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROTECTED_PROJECTS,
  LABEL_PROJECT,
  LABEL_WORKDIR,
  LEDGER_VERSION,
  TOOL_ID,
  buildInventory,
  deriveConfigToml,
  judgeProcess,
  ownerIsAlive,
  parseStatusEnv,
  planStackStop,
  projectIdFor,
  protectedProjects,
  sameDirectory,
  stackPorts,
  unrelatedChanges,
  type ContainerInfo,
  type LedgerEntry,
  type StopContext,
} from '../../scripts/test-lifecycle/lifecycle-core'

/**
 * P210: the ownership rules of the local test-infrastructure lifecycle tool. No Docker, no process
 * table: every side effect is a value here. The live proof against real containers is
 * `pnpm lifecycle:selftest` (scripts/test-lifecycle/selftest.ts, needs Docker).
 */

const WORKDIR = 'C:\\Users\\Oskar\\Documents\\Pokemonapp-worktrees\\p999-stack'
const CREATED = '2026-10-09T10:00:00.000Z'

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    tool: TOOL_ID,
    version: LEDGER_VERSION,
    name: 'p999',
    projectId: 'pokeportfolio-p999',
    workdir: WORKDIR,
    createdAt: CREATED,
    kind: 'detached',
    owner: { pid: 4242, startTime: 'T1', host: 'h' },
    state: 'running',
    containers: [
      { id: 'a1', name: 'supabase_db_pokeportfolio-p999' },
      { id: 'a2', name: 'supabase_auth_pokeportfolio-p999' },
    ],
    processes: [],
    counts: { runningBefore: 3 },
    ...overrides,
  }
}

function container(
  id: string,
  project: string | undefined,
  overrides: Partial<ContainerInfo> = {},
): ContainerInfo {
  const labels: Record<string, string> = {}
  if (project !== undefined) {
    labels[LABEL_PROJECT] = project
    labels[LABEL_WORKDIR] = WORKDIR
  }
  return {
    id,
    name: `c_${id}`,
    image: 'img',
    state: 'running',
    createdAt: '2026-10-09T10:01:00.000Z',
    labels,
    ...overrides,
  }
}

function ctx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    entry: entry(),
    containers: [container('a1', 'pokeportfolio-p999'), container('a2', 'pokeportfolio-p999')],
    protectedIds: protectedProjects(undefined),
    mode: 'own',
    ownerAlive: false,
    callerIsOwner: true,
    ...overrides,
  }
}

describe('stack names and protection', () => {
  it('derives the project id and rejects names that could widen the match', () => {
    expect(projectIdFor('p210')).toBe('pokeportfolio-p210')
    for (const bad of ['', 'P210', '../x', 'p 210', 'a', 'p210;rm', '-x', 'x'.repeat(40)]) {
      expect(() => projectIdFor(bad)).toThrow()
    }
  })

  it('protects the default stack and p196c, and accepts extra protected ids from the environment', () => {
    expect(DEFAULT_PROTECTED_PROJECTS).toContain('pokeportfolio')
    expect(DEFAULT_PROTECTED_PROJECTS).toContain('pokeportfolio-p196c')
    const set = protectedProjects(' pokeportfolio-p500 ,, pokeportfolio-p501')
    expect(set.has('pokeportfolio-p500')).toBe(true)
    expect(set.has('pokeportfolio-p501')).toBe(true)
    expect(set.has('pokeportfolio-p196c')).toBe(true)
  })

  it('compares working directories regardless of slash style, case and trailing separator', () => {
    expect(sameDirectory('C:\\A\\B\\', 'c:/a/b')).toBe(true)
    expect(sameDirectory('C:\\A\\B', 'C:\\A\\C')).toBe(false)
  })
})

describe('planStackStop: positive ownership evidence', () => {
  it('stops exactly the recorded containers of a matching, owned stack', () => {
    const plan = planStackStop(ctx())
    expect(plan).toEqual({
      action: 'stop',
      projectId: 'pokeportfolio-p999',
      workdir: WORKDIR,
      containerIds: ['a1', 'a2'],
    })
  })

  it('never selects containers of other projects, unlabelled containers or look-alike project ids', () => {
    const plan = planStackStop(
      ctx({
        containers: [
          container('a1', 'pokeportfolio-p999'),
          container('x1', 'pokeportfolio-p9990'),
          container('x2', 'pokeportfolio-p99'),
          container('x3', undefined),
          container('x4', 'pokeportfolio-p196c'),
        ],
      }),
    )
    expect(plan).toMatchObject({ action: 'stop', containerIds: ['a1'] })
  })

  it('accepts a container the CLI created after the entry (recreated on db reset)', () => {
    const plan = planStackStop(ctx({ containers: [container('n1', 'pokeportfolio-p999')] }))
    expect(plan).toMatchObject({ action: 'stop', containerIds: ['n1'] })
  })

  it('refuses the whole stack when one container pre-dates the entry and was never recorded', () => {
    const plan = planStackStop(
      ctx({
        containers: [
          container('a1', 'pokeportfolio-p999'),
          container('old', 'pokeportfolio-p999', { createdAt: '2026-10-01T00:00:00.000Z' }),
        ],
      }),
    )
    expect(plan.action).toBe('refuse')
  })

  it('refuses the whole stack when a container with the project id has another working directory', () => {
    const foreign = container('f1', 'pokeportfolio-p999')
    foreign.labels[LABEL_WORKDIR] = 'D:\\elsewhere'
    const plan = planStackStop(
      ctx({ containers: [container('a1', 'pokeportfolio-p999'), foreign] }),
    )
    expect(plan.action).toBe('refuse')
  })

  it.each(['pokeportfolio-p196c', 'pokeportfolio'])(
    'refuses protected project %s even with a forged ledger entry',
    (id) => {
      const forged = entry({ name: id.replace('pokeportfolio-', '') || 'x', projectId: id })
      const plan = planStackStop(ctx({ entry: forged, containers: [container('a1', id)] }))
      expect(plan.action).toBe('refuse')
    },
  )

  it('refuses a ledger entry outside the pokeportfolio- namespace or whose name disagrees', () => {
    expect(planStackStop(ctx({ entry: entry({ projectId: 'infra', name: 'infra' }) })).action).toBe(
      'refuse',
    )
    expect(planStackStop(ctx({ entry: entry({ name: 'other' }) })).action).toBe('refuse')
  })

  it('refuses an entry that this tool did not write', () => {
    const forged = { ...entry(), tool: 'something-else' } as unknown as LedgerEntry
    expect(planStackStop(ctx({ entry: forged })).action).toBe('refuse')
    const future = { ...entry(), version: 99 } as unknown as LedgerEntry
    expect(planStackStop(ctx({ entry: future })).action).toBe('refuse')
  })

  it('does nothing for an already stopped entry or when no container carries the project id', () => {
    expect(planStackStop(ctx({ entry: entry({ state: 'stopped' }) })).action).toBe('noop')
    expect(planStackStop(ctx({ containers: [container('z', 'infra')] })).action).toBe('noop')
  })

  it('own mode needs the owner or an operator naming the stack', () => {
    expect(planStackStop(ctx({ callerIsOwner: false })).action).toBe('refuse')
    expect(planStackStop(ctx({ callerIsOwner: false, explicit: true })).action).toBe('stop')
  })
})

describe('planStackStop: recovery after a crash', () => {
  const attached = entry({ kind: 'attached' })

  it('stops an attached stack whose owner process is gone', () => {
    const plan = planStackStop(ctx({ entry: attached, mode: 'recover', callerIsOwner: false }))
    expect(plan.action).toBe('stop')
  })

  it('refuses while the owner process is still running', () => {
    const plan = planStackStop(
      ctx({ entry: attached, mode: 'recover', callerIsOwner: false, ownerAlive: true }),
    )
    expect(plan).toMatchObject({ action: 'refuse' })
  })

  it('never stops a detached stack in bulk, only when the operator names it', () => {
    const bulk = planStackStop(ctx({ mode: 'recover', callerIsOwner: false }))
    expect(bulk.action).toBe('refuse')
    const named = planStackStop(ctx({ mode: 'recover', callerIsOwner: false, explicit: true }))
    expect(named.action).toBe('stop')
  })

  it('recognises a live owner only when the start time still matches (pid reuse)', () => {
    const owner = { pid: 1, startTime: 'T1', host: 'h' }
    expect(ownerIsAlive(owner, { startTime: 'T1', commandLine: 'x' })).toBe(true)
    expect(ownerIsAlive(owner, { startTime: 'T2', commandLine: 'x' })).toBe(false)
    expect(ownerIsAlive(owner, null)).toBe(false)
  })
})

describe('judgeProcess: child processes are killed by verified identity only', () => {
  const record = {
    pid: 77,
    startTime: 'S1',
    commandLine: 'node vite preview --port 4173',
    role: 'server',
  }

  it('kills only when pid, start time and command line all match', () => {
    expect(judgeProcess(record, { startTime: 'S1', commandLine: record.commandLine })).toEqual({
      action: 'kill',
      pid: 77,
    })
  })

  it('reports a vanished process as gone', () => {
    expect(judgeProcess(record, null)).toEqual({ action: 'gone', pid: 77 })
  })

  it('refuses a recycled pid (different start time)', () => {
    expect(judgeProcess(record, { startTime: 'S2', commandLine: record.commandLine }).action).toBe(
      'refuse',
    )
  })

  it('refuses a same-start-time process with a different command line', () => {
    expect(judgeProcess(record, { startTime: 'S1', commandLine: 'node other.js' }).action).toBe(
      'refuse',
    )
  })
})

describe('buildInventory', () => {
  const containers = [
    container('a1', 'pokeportfolio-p999'),
    container('p1', 'pokeportfolio-p196c'),
    container('u1', 'pokeportfolio-p500'),
    container('u2', 'pentagi'),
    container('u3', undefined),
  ]

  it('classifies owned, protected and unowned groups and counts running containers', () => {
    const groups = buildInventory({
      containers,
      entries: [entry({ kind: 'attached' })],
      ownerAliveByName: new Map([['p999', true]]),
      protectedIds: protectedProjects(undefined),
    })
    const byProject = Object.fromEntries(groups.map((g) => [g.project, g.classification]))
    expect(byProject).toMatchObject({
      'pokeportfolio-p999': 'task-owned',
      'pokeportfolio-p196c': 'protected',
      'pokeportfolio-p500': 'unowned',
      pentagi: 'unowned',
      '(standalone)': 'unowned',
    })
  })

  it('marks an attached entry with a dead owner abandoned and an up-started one detached', () => {
    const base = {
      containers,
      ownerAliveByName: new Map<string, boolean>(),
      protectedIds: protectedProjects(undefined),
    }
    const abandoned = buildInventory({ ...base, entries: [entry({ kind: 'attached' })] })
    expect(abandoned.find((g) => g.project === 'pokeportfolio-p999')?.classification).toBe(
      'abandoned',
    )
    const detached = buildInventory({ ...base, entries: [entry({ kind: 'detached' })] })
    expect(detached.find((g) => g.project === 'pokeportfolio-p999')?.classification).toBe(
      'task-detached',
    )
  })

  it('reports an ambiguous ledger match as unowned with a note instead of claiming it', () => {
    const foreign = container('f1', 'pokeportfolio-p999')
    foreign.labels[LABEL_WORKDIR] = 'D:\\elsewhere'
    const groups = buildInventory({
      containers: [foreign],
      entries: [entry()],
      ownerAliveByName: new Map(),
      protectedIds: protectedProjects(undefined),
    })
    expect(groups[0]).toMatchObject({ classification: 'unowned' })
    expect(groups[0]?.note).toContain('ambiguous')
  })
})

describe('unrelatedChanges', () => {
  it('is empty when only the stopped project changed', () => {
    const before = [container('a1', 'pokeportfolio-p999'), container('u1', 'pokeportfolio-p500')]
    const after = [container('u1', 'pokeportfolio-p500')]
    expect(unrelatedChanges(before, after, 'pokeportfolio-p999')).toEqual([])
  })

  it('ignores a restart loop flipping between running and restarting', () => {
    const before = [container('u1', 'pokeportfolio-p500', { state: 'restarting' })]
    const after = [container('u1', 'pokeportfolio-p500', { state: 'running' })]
    expect(unrelatedChanges(before, after, 'pokeportfolio-p999')).toEqual([])
  })

  it('names an unrelated container that vanished or stopped', () => {
    const before = [container('u1', 'pokeportfolio-p500'), container('u2', 'infra')]
    const after = [container('u2', 'infra', { state: 'exited' })]
    const problems = unrelatedChanges(before, after, 'pokeportfolio-p999')
    expect(problems).toHaveLength(2)
  })
})

describe('stack configuration', () => {
  const base = readFileSync('supabase/config.toml', 'utf8')

  it('rewrites the project id and moves every host port into the private block', () => {
    const derived = deriveConfigToml(base, 'pokeportfolio-p999', 58000)
    expect(derived).toMatch(/^project_id = "pokeportfolio-p999"$/m)
    for (const port of stackPorts(58000)) expect(derived).toContain(String(port))
    for (const original of [
      '54321',
      '54322',
      '54320',
      '54329',
      '54323',
      '54324',
      '54327',
      '8083',
    ]) {
      expect(derived).not.toMatch(
        new RegExp(`^(port|shadow_port|inspector_port) = ${original}$`, 'm'),
      )
    }
  })

  it('refuses a config it cannot rewrite exactly instead of guessing', () => {
    expect(() => deriveConfigToml('project_id = "x"\n', 'pokeportfolio-p1', 58000)).toThrow(
      /drifted/,
    )
  })

  it('parses supabase status env output', () => {
    const parsed = parseStatusEnv(
      'API_URL="http://127.0.0.1:1"\nANON_KEY="k"\n\nnoise\nDB_URL="postgresql://u:p@h:1/d"',
    )
    expect(parsed).toMatchObject({
      API_URL: 'http://127.0.0.1:1',
      ANON_KEY: 'k',
      DB_URL: 'postgresql://u:p@h:1/d',
    })
  })
})

describe('policy: the CLI source cannot reach the forbidden operations', () => {
  const code = readFileSync('scripts/test-lifecycle/lifecycle.ts', 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n')

  it.each([
    ['supabase stop --all', /['"]--all['"]/],
    ['supabase stop --no-backup', /no-backup/],
    ['docker prune', /prune/],
    ['docker rm / volume rm by pattern', /['"](rm|rmi)['"]/],
    ['wsl --shutdown', /shutdown/i],
    ['stopping Docker Desktop', /Docker Desktop/i],
    [
      'killing by executable name (taskkill /IM, Stop-Process -Name, pkill, killall)',
      /\/IM\b|Stop-Process|pkill|killall/,
    ],
    ['a shell string', /shell:\s*true/],
  ])('does not contain %s', (_label, pattern) => {
    expect(code).not.toMatch(pattern)
  })
})
