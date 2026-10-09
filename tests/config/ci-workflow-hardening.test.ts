import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REQUIRED_CHECKS } from '../../scripts/lib/release-verify.mjs'

/**
 * P203/P210: structural invariants of .github/workflows/ci.yml that the other workflow tests do not
 * pin. They judge the file text (there is no YAML parser in the repository, and the other workflow
 * tests use the same approach), splitting it into top-level jobs.
 *
 * Why these are worth a test: a job without `timeout-minutes` can hold a runner for the 6-hour
 * platform default when a step hangs; a renamed job silently orphans a required status check; a
 * failure that tears the Supabase stack down before logs are read leaves nothing to diagnose; and
 * since P210 two of the required checks are aggregators, so a job that is not listed in an
 * aggregator's `needs` could fail without failing any required check.
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

/** Required checks that only aggregate parallel jobs (P210), and what each must wait for. */
const AGGREGATORS: Record<string, string[]> = {
  'build-and-test': ['static-checks', 'browser-e2e'],
  'db-tests': ['db-suites', 'authenticated-e2e'],
}

describe('ci.yml structure', () => {
  it('has every required status-check job under its exact name, plus only the known parallel jobs', () => {
    for (const job of REQUIRED_CHECKS) expect([...parsed.keys()]).toContain(job)
    // A new job is a deliberate change: it must be listed in AGGREGATORS above AND in the
    // aggregator's `needs`, otherwise it could fail without failing a required check.
    expect([...parsed.keys()].sort()).toEqual(
      [...REQUIRED_CHECKS, ...Object.values(AGGREGATORS).flat()].sort(),
    )
  })

  it.each(REQUIRED_CHECKS)('%s has no custom display name that would rename its check', (job) => {
    expect(parsed.get(job)).not.toMatch(/^ {4}name:/m)
  })

  it.each([...parsed.keys()])('%s bounds its runtime with timeout-minutes', (job) => {
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

describe('required checks are aggregators over the parallel jobs (P210)', () => {
  it.each(Object.entries(AGGREGATORS))('%s needs exactly %j', (job, needs) => {
    const block = parsed.get(job) ?? ''
    const match = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(block)
    expect(match, `${job} needs a needs: list`).not.toBeNull()
    const listed = (match?.[1] ?? '').split(',').map((n) => n.trim())
    expect(listed.sort()).toEqual([...needs].sort())
    // always(): the aggregator must report even when a needed job failed or was cancelled.
    expect(block).toMatch(/^ {4}if: always\(\)\s*$/m)
    expect(block).toContain(`node scripts/ci/require-jobs.mjs --needs ${needs.join(',')}`)
    expect(block).toContain('NEEDS_JSON: ${{ toJSON(needs) }}')
  })

  it('no job can fail without failing a required check', () => {
    const code = ci
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(code).not.toMatch(/continue-on-error/)
    const covered = new Set([...Object.values(AGGREGATORS).flat(), ...REQUIRED_CHECKS])
    for (const job of parsed.keys()) expect(covered.has(job), `${job} is unreachable`).toBe(true)
  })

  it('the Browser E2E matrix is not fail-fast, so every shard reports, and covers 3 of 3 shards', () => {
    const block = parsed.get('browser-e2e') ?? ''
    expect(block).toMatch(/fail-fast: false/)
    expect(block).toMatch(/shard: \[1, 2, 3\]/)
    expect(block).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/3/)
  })

  it('the secret scan keeps full history and stays in static-checks', () => {
    const block = parsed.get('static-checks') ?? ''
    expect(block).toMatch(/fetch-depth: 0/)
    expect(block).toContain('zricethezav/gitleaks')
  })

  it('the full Browser E2E is not run twice and not left out', () => {
    const runs = [...ci.matchAll(/playwright test[^\n]*/g)].map((m) => m[0])
    expect(runs.filter((r) => r.includes('--shard='))).toHaveLength(1)
    expect(runs.filter((r) => r.includes('desktop-chromium-authenticated'))).toHaveLength(1)
    expect(ci).not.toMatch(/pnpm test:e2e/)
  })
})

describe.each(['db-suites', 'authenticated-e2e'])('%s diagnostics', (job) => {
  const block = parsed.get(job) ?? ''

  it('collects container logs on failure BEFORE the stack is stopped', () => {
    const collect = block.indexOf('scripts/ci/collect-diagnostics.mjs')
    const stop = block.lastIndexOf('pnpm exec supabase stop')
    expect(collect).toBeGreaterThan(-1)
    expect(collect).toBeLessThan(stop)
    const stepStart = block.lastIndexOf('- name:', collect)
    expect(block.slice(stepStart, collect)).toMatch(/if: failure\(\)/)
  })

  it('masks the generated registry credentials before they reach later steps', () => {
    expect(block).toMatch(/::add-mask::\$ERASURE_TOKEN/)
    expect(block).toMatch(/::add-mask::\$ERASURE_KEY/)
  })

  it('waits for the API gateway to serve REST instead of sleeping a fixed time after a restart', () => {
    const step = block.slice(block.indexOf('Raise the PostgREST-routed'))
    const part = step.slice(0, step.indexOf('# What the catalog'))
    expect(part).toContain('docker restart')
    expect(part).not.toMatch(/\bsleep 3\b/)
    expect(part).toMatch(/\/rest\/v1\//)
  })

  it('retries the stack start a bounded number of times, and only the start', () => {
    const at = block.indexOf('Start local Supabase stack')
    expect(at).toBeGreaterThan(-1)
    const step = block.slice(at, block.indexOf('- name:', at + 10))
    expect(step).toMatch(/for attempt in 1 2 3/)
    expect(step).toContain('pnpm exec supabase start')
    expect(step).toMatch(/exit 1/)
  })

  it('deactivates the recurring cron jobs so the stack never calls Production', () => {
    expect(block).toContain('select cron.alter_job(jobid, active := false) from cron.job;')
  })

  it('stops its own stack even when a step failed', () => {
    const at = block.lastIndexOf('pnpm exec supabase stop')
    expect(at).toBeGreaterThan(-1)
    const stepStart = block.lastIndexOf('- name:', at)
    expect(block.slice(stepStart, at)).toMatch(/if: always\(\)/)
  })
})

describe('test reporting', () => {
  it.each(['static-checks', 'browser-e2e', 'db-suites', 'authenticated-e2e'])(
    '%s writes a duration summary even when a step fails',
    (job) => {
      const text = parsed.get(job) ?? ''
      const at = text.indexOf('scripts/ci/test-summary.mjs')
      expect(at).toBeGreaterThan(-1)
      const stepStart = text.lastIndexOf('- name:', at)
      expect(text.slice(stepStart, at)).toMatch(/if: always\(\)/)
      expect(text).toContain('GITHUB_STEP_SUMMARY')
    },
  )

  it('records JUnit for the Vitest gates', () => {
    expect(parsed.get('static-checks')).toMatch(/pnpm test .*--reporter=junit/)
    expect(parsed.get('db-suites')).toMatch(/pnpm test:db .*--reporter=junit/)
  })

  it('every Playwright run reports JSON for the flaky-test summary', () => {
    expect(parsed.get('browser-e2e')).toContain('ci-results/playwright.json')
    expect(parsed.get('authenticated-e2e')).toContain('ci-results/playwright.json')
  })
})
