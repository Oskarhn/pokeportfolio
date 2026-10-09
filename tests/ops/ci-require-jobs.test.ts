import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { judgeNeeds } from '../../scripts/lib/ci-require-jobs.mjs'

/**
 * P210: the gate behind the aggregated required checks. A required check that goes green because a
 * shard was skipped, cancelled or never reported would be worse than no check, so every non-success
 * is a failure and malformed input is a failure too.
 */

const cli = fileURLToPath(new URL('../../scripts/ci/require-jobs.mjs', import.meta.url))

const job = (result = 'success') => ({ result, outputs: {} })

describe('judgeNeeds', () => {
  it('passes when every expected job succeeded', () => {
    expect(judgeNeeds({ a: job(), b: job() }, ['a', 'b'])).toEqual({ ok: true, problems: [] })
  })

  it.each(['failure', 'cancelled', 'skipped'])('fails on a %s job and names it', (result) => {
    const verdict = judgeNeeds({ a: job(), b: job(result) }, ['a', 'b'])
    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toEqual([`b: ${result}`])
  })

  it('fails on an expected job that is absent from needs', () => {
    expect(judgeNeeds({ a: job() }, ['a', 'b'])).toEqual({
      ok: false,
      problems: ['b: absent from needs'],
    })
  })

  it('fails on a job in needs that the aggregator did not expect (a forgotten list entry)', () => {
    const verdict = judgeNeeds({ a: job(), extra: job() }, ['a'])
    expect(verdict.ok).toBe(false)
    expect(verdict.problems[0]).toContain('extra')
  })

  it('fails on malformed input and on an empty expectation', () => {
    expect(judgeNeeds(null, ['a']).ok).toBe(false)
    expect(judgeNeeds([], ['a']).ok).toBe(false)
    expect(judgeNeeds({ a: job() }, []).ok).toBe(false)
    expect(judgeNeeds({ a: { outputs: {} } }, ['a']).ok).toBe(false)
  })
})

describe('require-jobs CLI', () => {
  const run = (needs: string | undefined, args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, NEEDS_JSON: needs ?? '' },
      encoding: 'utf8',
    })

  it('exits 0 for all-success and 1 for any failed shard', () => {
    expect(run(JSON.stringify({ a: job(), b: job() }), ['--needs', 'a,b']).status).toBe(0)
    const failed = run(JSON.stringify({ a: job(), b: job('failure') }), ['--needs', 'a,b'])
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('b: failure')
  })

  it('exits 2 (still a failure) when the invocation is wrong', () => {
    expect(run(undefined, ['--needs', 'a']).status).toBe(2)
    expect(run('not json', ['--needs', 'a']).status).toBe(2)
    expect(run(JSON.stringify({ a: job() }), []).status).toBe(2)
  })
})
