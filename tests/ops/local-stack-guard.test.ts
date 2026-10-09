import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLoopbackSupabaseUrl, isLoopbackUrl } from '../../scripts/lib/local-stack-guard.mjs'

/**
 * P200: every tool that writes with the service-role key refuses a non-loopback target.
 */

describe('local stack guard', () => {
  it('accepts the addresses a local Supabase stack uses', () => {
    for (const url of [
      'http://127.0.0.1:54321',
      'http://localhost:54321',
      'http://[::1]:54321',
      'http://127.0.0.1:55330/',
      'http://api.localhost:54321',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
  })

  it('refuses hosted projects, look-alike hosts and URL tricks', () => {
    for (const url of [
      'https://nopmkroeygmlvndzjjqs.supabase.co',
      'https://abcdefghijklmnopqrst.supabase.co/rest/v1',
      'http://localhost.evil.example',
      'http://127.0.0.1.nip.io:54321',
      'http://127.0.0.1@evil.example',
      'http://localhost:pw@evil.example',
      'http://evil.example/localhost',
      'http://0.0.0.0:54321',
      'http://192.168.1.10:54321',
      'ftp://127.0.0.1',
      'not a url',
      '',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })

  it('assertLoopbackSupabaseUrl throws without ever echoing more than the host', () => {
    const hosted = 'https://nopmkroeygmlvndzjjqs.supabase.co/functions/v1?apikey=sb_secret_abc'
    expect(() => assertLoopbackSupabaseUrl(hosted)).toThrow(/nopmkroeygmlvndzjjqs\.supabase\.co/)
    try {
      assertLoopbackSupabaseUrl(hosted)
    } catch (e) {
      expect((e as Error).message).not.toContain('sb_secret')
      expect((e as Error).message).not.toContain('apikey')
    }
    expect(() => assertLoopbackSupabaseUrl(undefined)).toThrow(/local Supabase stack/)
    expect(assertLoopbackSupabaseUrl('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321')
  })
})

describe('service-role entry points call the guard', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dirname, '../..', rel), 'utf8')
  const WRITERS = [
    'tests/db/setup.ts',
    'scripts/p132b/deadlock-campaign.ts',
    'scripts/portfolio-perf-benchmark.mjs',
    'scripts/portfolio-snapshots-benchmark.mjs',
  ]
  // These two reach the service role only through tests/db/setup.ts, which is guarded above.
  for (const file of [
    'scripts/p117-inventory-race.ts',
    'scripts/p117-purchase-idempotency-stress.ts',
  ]) {
    it(`${file} gets its service client from the guarded harness`, () => {
      expect(read(file)).toContain('createServiceClient')
      expect(read(file)).toContain('tests/db/setup')
    })
  }
  for (const file of WRITERS) {
    it(`${file} refuses a hosted SUPABASE_URL`, () => {
      expect(read(file)).toContain('assertLoopbackSupabaseUrl')
    })
  }
})
