/**
 * Pure parsing and rendering behind scripts/ci/test-summary.mjs (P203): turns the machine-readable
 * results CI already produces (Vitest JUnit XML, Playwright JSON) into a Markdown block for the job
 * summary. It exists to make two things visible that a green job otherwise hides:
 *
 *  - where the time goes (slowest files), so a regression in duration is noticed before it becomes a
 *    timeout; and
 *  - which Playwright tests only passed on a retry. CI allows two retries (playwright.config.ts), so
 *    a flaky test is green and invisible unless something reports it. This module lists them; it does
 *    not decide whether they fail the job.
 *
 * No XML or YAML library: Vitest's JUnit output is flat (`<testsuite name=... time=...>` per file), and
 * an attribute scan is enough and keeps the repository free of a new dependency.
 */

/** @param {string} tag the text of one opening tag @param {string} name @returns {string|undefined} */
function attr(tag, name) {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match ? match[1] : undefined
}

const decodeEntities = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/**
 * @param {string} xml Vitest JUnit output
 * @returns {Array<{file: string, seconds: number, tests: number, failures: number, skipped: number}>}
 */
export function parseJUnitSuites(xml) {
  const suites = []
  for (const match of String(xml).matchAll(/<testsuite\b[^>]*>/g)) {
    const tag = match[0]
    const name = attr(tag, 'name')
    if (!name) continue
    suites.push({
      file: decodeEntities(name),
      seconds: Number(attr(tag, 'time') ?? 0),
      tests: Number(attr(tag, 'tests') ?? 0),
      failures: Number(attr(tag, 'failures') ?? 0) + Number(attr(tag, 'errors') ?? 0),
      skipped: Number(attr(tag, 'skipped') ?? 0),
    })
  }
  return suites
}

/**
 * @param {unknown} report Playwright JSON reporter output
 * @returns {{
 *   files: Array<{file: string, seconds: number}>,
 *   flaky: Array<{title: string, file: string, project: string, retries: number}>,
 *   failed: number, passed: number, skipped: number, flakyCount: number,
 * }}
 */
export function parsePlaywrightReport(report) {
  const perFile = new Map()
  const flaky = []
  let failed = 0
  let passed = 0
  let skipped = 0

  const visit = (suite, titles) => {
    if (!suite || typeof suite !== 'object') return
    const here = suite.title && suite.file !== suite.title ? [...titles, suite.title] : titles
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? []
        const seconds = results.reduce((sum, r) => sum + (r.duration ?? 0), 0) / 1000
        const file = spec.file ?? suite.file ?? 'unknown'
        perFile.set(file, (perFile.get(file) ?? 0) + seconds)
        // `expected` = passed first try, `flaky` = failed then passed on a retry, `unexpected` = failed.
        if (test.status === 'flaky') {
          flaky.push({
            title: [...here, spec.title].filter(Boolean).join(' › '),
            file,
            project: test.projectName ?? 'unknown',
            retries: Math.max(0, results.length - 1),
          })
        } else if (test.status === 'unexpected') failed += 1
        else if (test.status === 'skipped') skipped += 1
        else passed += 1
      }
    }
    for (const child of suite.suites ?? []) visit(child, here)
  }
  for (const suite of report?.suites ?? []) visit(suite, [])

  const files = [...perFile.entries()]
    .map(([file, seconds]) => ({ file, seconds }))
    .sort((a, b) => b.seconds - a.seconds)
  return { files, flaky, failed, passed, skipped, flakyCount: flaky.length }
}

const fmt = (seconds) => seconds.toFixed(1)

/**
 * @param {{title: string, vitest?: Array<{label: string, suites: ReturnType<typeof parseJUnitSuites>}>,
 *   playwright?: Array<{label: string, report: ReturnType<typeof parsePlaywrightReport>}>}} input
 * @param {number} top how many slowest files to list per source
 * @returns {string} Markdown for $GITHUB_STEP_SUMMARY
 */
export function renderSummary({ title, vitest = [], playwright = [] }, top = 8) {
  const lines = [`## ${title}`, '']
  if (vitest.length === 0 && playwright.length === 0) {
    lines.push('_No machine-readable test results were found for this job._', '')
    return lines.join('\n')
  }
  for (const { label, suites } of vitest) {
    const total = suites.reduce((sum, s) => sum + s.seconds, 0)
    const failures = suites.reduce((sum, s) => sum + s.failures, 0)
    const skipped = suites.reduce((sum, s) => sum + s.skipped, 0)
    const tests = suites.reduce((sum, s) => sum + s.tests, 0)
    lines.push(
      `### ${label}`,
      '',
      `${String(suites.length)} files, ${String(tests)} tests, ${String(failures)} failed, ${String(skipped)} skipped; summed test time ${fmt(total)} s (files run in parallel workers, so this exceeds wall time).`,
      '',
      '| Slowest file | Seconds |',
      '|---|---|',
    )
    for (const s of [...suites].sort((a, b) => b.seconds - a.seconds).slice(0, top)) {
      lines.push(`| \`${s.file}\` | ${fmt(s.seconds)} |`)
    }
    lines.push('')
  }
  for (const { label, report } of playwright) {
    lines.push(
      `### ${label}`,
      '',
      `${String(report.passed)} passed first try, **${String(report.flakyCount)} flaky (passed only on retry)**, ${String(report.failed)} failed, ${String(report.skipped)} skipped.`,
      '',
    )
    if (report.flaky.length > 0) {
      lines.push('| Flaky test | Project | Retries |', '|---|---|---|')
      for (const f of report.flaky) {
        lines.push(
          `| ${f.title.replace(/\|/g, '\\|')} (\`${f.file}\`) | ${f.project} | ${String(f.retries)} |`,
        )
      }
      lines.push('')
    }
    lines.push('| Slowest spec file | Seconds |', '|---|---|')
    for (const f of report.files.slice(0, top)) lines.push(`| \`${f.file}\` | ${fmt(f.seconds)} |`)
    lines.push('')
  }
  return lines.join('\n')
}
