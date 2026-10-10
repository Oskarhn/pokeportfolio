import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * P206 — the public, unauthenticated redeem-invitation Edge Function bounds and validates its body.
 *
 * Anyone on the internet can POST to it. Before P200 it called `request.json()` on whatever was
 * streamed (unbounded buffering) and a JSON body of `null` reached `body.token` and raised a
 * TypeError (a 500 from the runtime instead of a 400). This runs the function's REAL code under Deno
 * (scripts/p206/redeem-invitation-harness.mjs) with no database: every probe is refused or rejected
 * on shape before a Supabase client is built. The database-backed half (a valid invitation still
 * redeems; a refused oversize body does not burn it) is tests/authorization/
 * p200_redeem_invitation_hardening.test.ts against the local stack. Skipped, loudly, without `deno`.
 */

const HARNESS = resolve(__dirname, '../../scripts/p206/redeem-invitation-harness.mjs')
const FUNCTIONS_DIR = resolve(__dirname, '../../supabase/functions')
const ORIGIN = 'https://app.example.test'
const OTHER_ORIGIN = 'https://evil.example.test'
const GENERIC_INVALID = 'invitation_invalid'

const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const withDeno = hasDeno ? describe : describe.skip
if (!hasDeno) {
  console.warn('P206: `deno` is not installed — the redeem-invitation body tests are SKIPPED.')
}

interface Answer {
  status: number
  allowOrigin: string | null
  vary: string | null
  body: string
}
interface Probe {
  max: number
  atLimit: Answer
  overByOne: Answer
  multibyteAtLimit: Answer
  multibyteOver: Answer
  declaredHuge: Answer
  endlessStream: Answer & { pulledBytes: number; cancelled: boolean }
  shapes: Record<string, Answer>
  cors: Record<
    'oversizeAllowed' | 'oversizeDisallowed' | 'malformedAllowed' | 'malformedDisallowed',
    Answer
  >
  secretsOversize: Answer
  logged: string[]
  leaks: string[]
}

const errorOf = (answer: Answer): unknown => (JSON.parse(answer.body) as { error: unknown }).error

withDeno('redeem-invitation request body (P206, real function under Deno)', () => {
  let probe: Probe
  beforeAll(() => {
    const run = spawnSync(
      'deno',
      [
        'run',
        '--no-lock',
        '--allow-read',
        '--allow-env',
        HARNESS,
        FUNCTIONS_DIR,
        ORIGIN,
        OTHER_ORIGIN,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    )
    if (run.status !== 0) throw new Error(`the deno harness failed:\n${run.stderr}`)
    probe = JSON.parse(run.stdout) as Probe
  }, 120_000)

  it('judges a body of exactly the limit on its content (400), not on its size', () => {
    expect(probe.max).toBe(4096)
    expect(probe.atLimit.status).toBe(400)
    expect(errorOf(probe.atLimit)).toBe(GENERIC_INVALID)
  })

  it('refuses one byte over the limit with 413 and a generic body', () => {
    expect(probe.overByOne.status).toBe(413)
    expect(probe.overByOne.body).toBe('{"error":"bad_request"}')
  })

  it('counts bytes, not characters', () => {
    expect(probe.multibyteAtLimit.status).toBe(400)
    expect(probe.multibyteOver.status).toBe(413)
  })

  it('refuses a huge declared Content-Length without reading the body', () => {
    expect(probe.declaredHuge.status).toBe(413)
  })

  it('stops reading an endless chunked body at the limit and cancels the stream', () => {
    expect(probe.endlessStream.status).toBe(413)
    expect(probe.endlessStream.cancelled).toBe(true)
    // The limit plus at most a couple of 1 KiB chunks read ahead — never "everything the client sends".
    expect(probe.endlessStream.pulledBytes).toBeLessThanOrEqual(probe.max + 3 * 1024)
  })

  it.each([
    ['null', 'bad_request'],
    ['number', 'bad_request'],
    ['array', 'bad_request'],
    ['nestedArray', 'bad_request'],
    ['string', 'bad_request'],
    ['boolean', 'bad_request'],
    ['malformed', 'bad_request'],
    ['truncated', 'bad_request'],
    ['empty', 'bad_request'],
    // Objects with unusable fields reach the shape check and get the one generic invitation answer.
    ['nullFields', GENERIC_INVALID],
    ['wrongTypes', GENERIC_INVALID],
  ])('a %s body is a 400 (%s), never a 500', (name, error) => {
    const answer = probe.shapes[name]
    expect(answer?.status).toBe(400)
    expect(errorOf(answer as Answer)).toBe(error)
  })

  it('sends CORS headers on refusals for the app origin and none for another origin', () => {
    for (const key of ['oversizeAllowed', 'malformedAllowed'] as const) {
      expect(probe.cors[key].allowOrigin).toBe(ORIGIN)
      expect(probe.cors[key].vary).toBe('Origin')
    }
    for (const key of ['oversizeDisallowed', 'malformedDisallowed'] as const) {
      expect(probe.cors[key].allowOrigin).toBeNull()
      expect(probe.cors[key].vary).toBe('Origin')
    }
    expect(probe.cors.oversizeAllowed.status).toBe(413)
    expect(probe.cors.malformedAllowed.status).toBe(400)
  })

  it('never writes a request token or password to a log line', () => {
    expect(probe.secretsOversize.status).toBe(413)
    expect(probe.leaks).toEqual([])
    expect(probe.logged.join('\n')).not.toMatch(/SECRET-(TOKEN|PASSWORD)-MARKER/)
  })
})
