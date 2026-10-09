import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REQUIRED_CHECKS } from '../../scripts/lib/release-verify.mjs'

/**
 * P203: structural invariants of .github/workflows/ci.yml that the other workflow tests do not pin.
 * They judge the file text (there is no YAML parser in the repository, and the other workflow tests
 * use the same approach), splitting it into top-level jobs.
 *
 * Why these are worth a test: a job without `timeout-minutes` can hold a runner for the 6-hour
 * platform default when a step hangs; a renamed job silently orphans a required status check; a
 * failure that tears the Supabase stack down before logs are read leaves nothing to diagnose.
 */

const ci = readFileSync(
  join(fileURLToPath(new URL('../../', import.meta.url)), '.github/workflows/ci.yml'),
  'utf8',
)

/** Maps job id -> the text of its block. */
function jobs(source: string): Map<string, string> {
  const start = source.indexOf('\njobs:\n')
  const body = source.slice(start + '\njobs:\n'.length)
  const result = new Map<string, string>()
  let current: string | undefined
  let buffer: string[] = []
  const flush = () => {
    if (current) result.set(current, buffer.join('\n'))
  }
  for (const line of body.split('\n')) {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line)
    if (header) {
      flush()
      current = header[1]
      buffer = []
    } else buffer.push(line)
  }
  flush()
  return result
}

const parsed = jobs(ci)

describe('ci.yml structure', () => {
  it('has exactly the required status-check jobs, under their exact names', () => {
    expect([...parsed.keys()].sort()).toEqual([...REQUIRED_CHECKS].sort())
  })

  it.each(REQUIRED_CHECKS)('%s has no custom display name that would rename its check', (job) => {
    expect(parsed.get(job)).not.toMatch(/^ {4}name:/m)
  })

  it.each(REQUIRED_CHECKS)('%s bounds its runtime with timeout-minutes', (job) => {
    const match = /^ {4}timeout-minutes:\s*(\d+)\s*$/m.exec(parsed.get(job) ?? '')
    expect(match, `${job} needs a job-level timeout-minutes`).not.toBeNull()
    const minutes = Number(match?.[1])
    expect(minutes).toBeGreaterThanOrEqual(10)
    expect(minutes).toBeLessThanOrEqual(60)
  })

  it('keeps the workflow-wide default permission read-only', () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m)
    expect(ci).not.toMatch(/^ {2,}permissions:/m)
  })

  it('every artifact upload states a retention period', () => {
    const uploads = [
      ...ci.matchAll(/uses: actions\/upload-artifact@[^\n]*\n((?: {8,}[^\n]*\n?)+)/g),
    ]
    expect(uploads.length).toBeGreaterThan(0)
    for (const upload of uploads) expect(upload[1]).toMatch(/retention-days: \d+/)
  })
})

describe('db-tests diagnostics', () => {
  const dbTests = parsed.get('db-tests') ?? ''

  it('collects container logs on failure BEFORE the stack is stopped', () => {
    const collect = dbTests.indexOf('scripts/ci/collect-diagnostics.mjs')
    const stop = dbTests.indexOf('pnpm exec supabase stop')
    expect(collect).toBeGreaterThan(-1)
    expect(collect).toBeLessThan(stop)
    const stepStart = dbTests.lastIndexOf('- name:', collect)
    expect(dbTests.slice(stepStart, collect)).toMatch(/if: failure\(\)/)
  })

  it('masks the generated registry credentials before they reach later steps', () => {
    expect(dbTests).toMatch(/::add-mask::\$ERASURE_TOKEN/)
    expect(dbTests).toMatch(/::add-mask::\$ERASURE_KEY/)
  })

  it('waits for the API gateway to serve REST instead of sleeping a fixed time after a restart', () => {
    const step = dbTests.slice(dbTests.indexOf('Raise the PostgREST-routed'))
    const block = step.slice(0, step.indexOf('# What the catalog'))
    expect(block).toContain('docker restart')
    expect(block).not.toMatch(/\bsleep 3\b/)
    expect(block).toMatch(/\/rest\/v1\//)
  })
})

describe('test reporting', () => {
  it.each(['build-and-test', 'db-tests'])(
    '%s writes a duration and flaky-test summary even when a step fails',
    (job) => {
      const text = parsed.get(job) ?? ''
      const at = text.indexOf('scripts/ci/test-summary.mjs')
      expect(at).toBeGreaterThan(-1)
      const stepStart = text.lastIndexOf('- name:', at)
      expect(text.slice(stepStart, at)).toMatch(/if: always\(\)/)
      expect(text).toContain('GITHUB_STEP_SUMMARY')
    },
  )

  it('records JUnit for the Vitest gates in both jobs', () => {
    expect(parsed.get('build-and-test')).toMatch(/pnpm test .*--reporter=junit/)
    expect(parsed.get('db-tests')).toMatch(/pnpm test:db .*--reporter=junit/)
  })
})
