/**
 * Decision logic of the CI aggregator gate (P210); scripts/ci/require-jobs.mjs is the thin CLI.
 *
 * `build-and-test` and `db-tests` are required status checks whose work now runs in several jobs
 * (and, for Browser E2E, in several shards of one matrix job). The aggregator job `needs` all of
 * them with `if: always()`, so it runs even when one failed, and this makes it fail unless every
 * needed job SUCCEEDED. `skipped` and `cancelled` are failures: a shard that never ran is not a
 * pass, and a required check must not go green because its work disappeared.
 *
 * `needs.<job>.result` for a matrix job is the combined result of every shard (any failed shard
 * makes it `failure`), so listing the matrix job once is enough.
 */

/**
 * @param {unknown} needs parsed `toJSON(needs)`: { [job]: { result: string } }
 * @param {readonly string[]} expected the job ids the aggregator must have seen
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function judgeNeeds(needs, expected) {
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
    return { ok: false, problems: ['NEEDS_JSON is not an object'] }
  }
  if (expected.length === 0) return { ok: false, problems: ['no expected jobs were given'] }
  const problems = []
  const table = /** @type {Record<string, unknown>} */ (needs)
  for (const job of expected) {
    const entry = table[job]
    if (entry === undefined || entry === null || typeof entry !== 'object') {
      problems.push(`${job}: absent from needs`)
      continue
    }
    const result = /** @type {{ result?: unknown }} */ (entry).result
    if (result !== 'success') problems.push(`${job}: ${String(result)}`)
  }
  for (const job of Object.keys(table)) {
    if (!expected.includes(job))
      problems.push(`${job}: needed by the workflow but not expected here`)
  }
  return { ok: problems.length === 0, problems }
}
