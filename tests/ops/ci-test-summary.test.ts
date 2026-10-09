import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseJUnitSuites,
  parsePlaywrightReport,
  renderSummary,
} from '../../scripts/lib/ci-test-summary.mjs'

/**
 * P203: the job-summary generator. Fixtures mirror the shapes the real reporters emit (checked against
 * Vitest's JUnit output and Playwright's JSON reporter in this repository); the flaky case is built by
 * hand because a real flaky run cannot be summoned on demand.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

const JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="7" failures="1" errors="0" time="3.5">
    <testsuite name="tests/financial/a.test.ts" timestamp="t" hostname="h" tests="4" failures="0" errors="0" skipped="1" time="0.5">
        <testcase classname="tests/financial/a.test.ts" name="x &gt; y" time="0.1">
        </testcase>
    </testsuite>
    <testsuite name="tests/db/b &amp; c.test.ts" timestamp="t" hostname="h" tests="3" failures="1" errors="1" skipped="0" time="3">
    </testsuite>
</testsuites>`

describe('parseJUnitSuites', () => {
  it('reads one entry per file, never the wrapping <testsuites>', () => {
    const suites = parseJUnitSuites(JUNIT)
    expect(suites).toHaveLength(2)
    expect(suites[0]).toEqual({
      file: 'tests/financial/a.test.ts',
      seconds: 0.5,
      tests: 4,
      failures: 0,
      skipped: 1,
    })
  })

  it('decodes entities in names and counts errors as failures', () => {
    const second = parseJUnitSuites(JUNIT)[1]
    expect(second?.file).toBe('tests/db/b & c.test.ts')
    expect(second?.failures).toBe(2)
  })

  it('returns nothing for empty or non-XML input', () => {
    expect(parseJUnitSuites('')).toEqual([])
    expect(parseJUnitSuites('not xml')).toEqual([])
  })
})

const result = (duration: number, retry = 0) => ({ duration, retry, status: 'passed' })

const PLAYWRIGHT = {
  suites: [
    {
      title: 'auth.spec.ts',
      file: 'auth.spec.ts',
      specs: [
        {
          title: 'top level ok',
          file: 'auth.spec.ts',
          tests: [{ projectName: 'desktop-chromium', status: 'expected', results: [result(2000)] }],
        },
      ],
      suites: [
        {
          title: 'sign-in form',
          file: 'auth.spec.ts',
          specs: [
            {
              title: 'reports a failed sign-in',
              file: 'auth.spec.ts',
              tests: [
                {
                  projectName: 'mobile-iphone',
                  status: 'flaky',
                  results: [{ duration: 1000, retry: 0, status: 'failed' }, result(3000, 1)],
                },
                { projectName: 'desktop-chromium', status: 'unexpected', results: [result(500)] },
                { projectName: 'desktop-chromium', status: 'skipped', results: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe('parsePlaywrightReport', () => {
  const summary = parsePlaywrightReport(PLAYWRIGHT)

  it('counts each status and lists every test that needed a retry', () => {
    expect(summary).toMatchObject({ passed: 1, flakyCount: 1, failed: 1, skipped: 1 })
    expect(summary.flaky).toEqual([
      {
        title: 'sign-in form › reports a failed sign-in',
        file: 'auth.spec.ts',
        project: 'mobile-iphone',
        retries: 1,
      },
    ])
  })

  it('does not repeat the file name as a title segment', () => {
    expect(summary.flaky[0]?.title.startsWith('auth.spec.ts')).toBe(false)
  })

  it('sums time across every attempt, per file, slowest first', () => {
    expect(summary.files).toEqual([{ file: 'auth.spec.ts', seconds: 2 + 1 + 3 + 0.5 }])
  })

  it.each([null, undefined, {}, { suites: 'nope' }, { suites: [null, 3] }])(
    'tolerates a malformed report (%j)',
    (bad) => {
      const out = parsePlaywrightReport(bad)
      expect(out).toMatchObject({ passed: 0, flakyCount: 0, failed: 0 })
    },
  )
})

describe('renderSummary', () => {
  it('says so, rather than printing an empty table, when nothing was found', () => {
    expect(renderSummary({ title: 'T' })).toContain('No machine-readable test results')
  })

  it('names flaky tests and the slowest files', () => {
    const md = renderSummary({
      title: 'build-and-test',
      vitest: [{ label: 'Unit', suites: parseJUnitSuites(JUNIT) }],
      playwright: [{ label: 'Browser E2E', report: parsePlaywrightReport(PLAYWRIGHT) }],
    })
    expect(md).toContain('## build-and-test')
    expect(md).toContain('| `tests/db/b & c.test.ts` | 3.0 |')
    expect(md).toContain('**1 flaky (passed only on retry)**')
    expect(md).toContain('sign-in form › reports a failed sign-in')
    expect(md.indexOf('b & c.test.ts')).toBeLessThan(md.indexOf('a.test.ts'))
  })

  it('escapes a pipe in a test title so the table survives', () => {
    const report = parsePlaywrightReport({
      suites: [
        {
          title: 'x.spec.ts',
          file: 'x.spec.ts',
          specs: [
            {
              title: 'a | b',
              file: 'x.spec.ts',
              tests: [
                {
                  projectName: 'p',
                  status: 'flaky',
                  results: [result(1), result(1, 1)],
                },
              ],
            },
          ],
        },
      ],
    })
    expect(renderSummary({ title: 'T', playwright: [{ label: 'E2E', report }] })).toContain(
      'a \\| b',
    )
  })
})

describe('scripts/ci/test-summary.mjs', () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, ['scripts/ci/test-summary.mjs', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
    })
  }

  it('summarises real files and reports a missing one without failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p203-summary-'))
    try {
      writeFileSync(join(dir, 'unit.xml'), JUNIT)
      writeFileSync(join(dir, 'pw.json'), JSON.stringify(PLAYWRIGHT))
      const out = run([
        '--title',
        'Job',
        '--junit',
        `Unit=${join(dir, 'unit.xml')}`,
        '--playwright',
        `E2E=${join(dir, 'pw.json')}`,
        '--junit',
        `Missing=${join(dir, 'absent.xml')}`,
      ])
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('## Job')
      expect(out.stdout).toContain('1 flaky')
      expect(out.stdout).toContain('`Missing`: no results file')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not fail on an unreadable Playwright file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p203-summary-'))
    try {
      writeFileSync(join(dir, 'pw.json'), '{ not json')
      const out = run(['--playwright', `E2E=${join(dir, 'pw.json')}`])
      expect(out.status).toBe(0)
      expect(out.stdout).toContain('`E2E`: unreadable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
