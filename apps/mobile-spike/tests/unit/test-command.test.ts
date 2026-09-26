// The `pnpm test` command must run EVERY configured project that needs no backend (P169 F9).
//
// `jest --selectProjects unit shared` looked like it ran the unit tests and the web domain tests, but
// there is no project called "shared" (they are "shared-node" and "shared-rn"): Jest ignored the
// unknown name without a word and ran 25 of the 39 suites. This test reads the command that
// package.json actually declares, so a renamed, added or misspelled project cannot be dropped silently
// again.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const appRoot = path.resolve(__dirname, '..', '..')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../package.json') as { scripts: Record<string, string> }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jestConfig = require('../../jest.config.js') as { projects: { displayName: string }[] }

/** Needs the isolated local Supabase stack: run by `test:backend`, never by `test`. */
const STACK_ONLY = ['backend']

function selectedProjects(command: string): string[] {
  const match = /--selectProjects\s+([^-][^\n]*?)(?:\s+--|$)/.exec(command)
  return match?.[1] === undefined ? [] : match[1].trim().split(/\s+/)
}

describe('the test command', () => {
  const configured = jestConfig.projects.map((p) => p.displayName)
  const wanted = configured.filter((name) => !STACK_ONLY.includes(name))
  const selected = selectedProjects(pkg.scripts.test ?? '')

  it('names only projects that exist (Jest ignores an unknown name silently)', () => {
    for (const name of selected) expect(configured).toContain(name)
  })

  it('selects every configured project that does not need the backend stack', () => {
    expect([...selected].sort()).toEqual([...wanted].sort())
  })

  it('leaves the backend project to test:backend, which does run it', () => {
    expect(selected).not.toContain('backend')
    expect(pkg.scripts['test:backend']).toContain('run-backend-tests')
  })

  it('lists the web domain tests AND the app tests when run exactly as declared', () => {
    const args = (pkg.scripts.test ?? '').replace(/^jest\s+/, '').split(/\s+/)
    const jestBin = require.resolve('jest/bin/jest')
    const r = spawnSync(process.execPath, [jestBin, ...args, '--listTests'], {
      cwd: appRoot,
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const listed = r.stdout.split(path.sep).join('/')
    expect(listed).toContain('tests/financial/money.test.ts')
    expect(listed).toContain('tests/data/pricing.test.ts')
    expect(listed).toContain('tests/unit/format-money.test.ts')
    expect(listed).not.toContain('tests/backend/')
  }, 60000)
})
