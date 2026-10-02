/**
 * Every environment variable an authenticated E2E spec reads must be provided by the CI job that
 * runs it (P188). The P161/P164 ledger spec reads `P153_DB_URL` and refuses to run without it, but the
 * workflow only exported `DB_URL`: the first real CI run would have failed `price-check-ledger.spec.ts`
 * in its `beforeAll` and left six dependent tests unrun. That was found only because the suite was run
 * by hand against a local stack with the CI's own variable names.
 *
 * Static and deliberately narrow: it reads the spec sources and `ci.yml` as text.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SPEC_DIR = join('tests', 'e2e', 'authenticated')
const workflow = readFileSync(join('.github', 'workflows', 'ci.yml'), 'utf-8')

/** Variables the Playwright runner, the harness or a default supplies; not the workflow's job. */
const NOT_FROM_THE_WORKFLOW_ENV = new Set([
  'CI', // set by GitHub Actions itself
  'PLAYWRIGHT_AUTHENTICATED_E2E', // the step's own `env:` block
  'PLAYWRIGHT_PREVIEW_PORT', // optional, has a default in playwright.config.ts
  'VITE_SUPABASE_URL', // the preview build's placeholder is set by playwright.config.ts
  'VITE_SUPABASE_PUBLISHABLE_KEY',
])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.ts$/.test(entry.name) ? [path] : []
  })
}

const readNames = new Set<string>()
for (const file of sources(SPEC_DIR)) {
  for (const m of readFileSync(file, 'utf-8').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) {
    readNames.add(m[1]!)
  }
}

describe('the authenticated E2E job provides every variable the specs read (P188)', () => {
  it('finds the variables the specs read (guards against a vacuous check)', () => {
    expect(readNames.has('SUPABASE_URL')).toBe(true)
    expect(readNames.has('P153_DB_URL')).toBe(true)
  })

  it.each([...readNames].filter((n) => !NOT_FROM_THE_WORKFLOW_ENV.has(n)).sort())(
    '%s is exported by the workflow',
    (name) => {
      expect(workflow).toContain(`${name}=`)
    },
  )

  it('exports P153_DB_URL from the local stack status, never a hosted URL', () => {
    const line = workflow.split('\n').find((l) => l.includes('echo "P153_DB_URL='))
    expect(line).toBeDefined()
    expect(line).toContain("grep '^DB_URL=' /tmp/supabase-status.env")
  })
})
