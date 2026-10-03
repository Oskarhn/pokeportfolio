import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hashAccountId,
  parseRegistry,
  parseRegistryKey,
  readRegistryFile,
  RegistryError,
} from '../../scripts/restore-gate/erasure-registry'
import { exportRegistry } from '../../scripts/restore-gate/registry-export'
import { ErasureLedger } from '../../scripts/erasure-registry-worker/worker'
import worker, { type Env } from '../../scripts/erasure-registry-worker/worker'
import { appendErasure, SinkError } from '../../supabase/functions/_shared/erasure-sink'

/**
 * P195: the production erasure registry Worker and its ledger, run against node:sqlite standing in
 * for the Durable Object's SQLite storage. Synthetic ids only. The same code is exercised against a
 * real workerd Durable Object in the rehearsal (docs/release/P195_BACKEND_RELEASE_REHEARSAL.md).
 */

const KEY_HEX = '0123456789abcdef'.repeat(4)
const KEY = parseRegistryKey(KEY_HEX)
const APPEND = 'append-token-aaaaaaaaaaaaaaaaaaaaaa'
const OPERATOR = 'operator-token-bbbbbbbbbbbbbbbbbbbb'
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOW = '2026-10-03T10:00:00Z'

interface Harness {
  env: Env
  db: DatabaseSync
  call: (path: string, init?: RequestInit & { token?: string | null }) => Promise<Response>
}

function harness(overrides: Partial<Env> = {}): Harness {
  const db = new DatabaseSync(':memory:')
  const base = {
    ERASURE_REGISTRY_KEY: KEY_HEX,
    ERASURE_APPEND_TOKEN: APPEND,
    ERASURE_OPERATOR_TOKEN: OPERATOR,
    ...overrides,
  }
  const state = {
    storage: {
      sql: {
        // Like the Durable Object's exec(), the statement runs immediately, not when read.
        exec: (query: string, ...b: unknown[]) => {
          const rows = db.prepare(query).all(...(b as (string | number)[])) as Record<
            string,
            unknown
          >[]
          return { toArray: () => rows }
        },
      },
      transactionSync: <T>(fn: () => T): T => {
        db.exec('BEGIN IMMEDIATE')
        try {
          const r = fn()
          db.exec('COMMIT')
          return r
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      },
    },
  }
  const ledger = new ErasureLedger(state, base)
  const env: Env = {
    ...base,
    LEDGER: { idFromName: (n) => n, get: () => ({ fetch: (r: Request) => ledger.fetch(r) }) },
  }
  const call: Harness['call'] = (path, init = {}) => {
    const { token = APPEND, ...rest } = init
    const headers = new Headers(rest.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return worker.fetch(new Request(`https://registry.invalid${path}`, { ...rest, headers }), env)
  }
  return { env, db, call }
}

const post = (h: Harness, deletion_id: string, subject: string, extra: object = {}) =>
  h.call('/v1/erasures', {
    method: 'POST',
    body: JSON.stringify({ deletion_id, subject, deleted_at: NOW, scope: 1, ...extra }),
  })

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p195-reg-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('append', () => {
  it('records, is idempotent on the deletion id and on the subject, and chains', async () => {
    const h = harness()
    const first = await post(h, D1, hashAccountId(U1))
    expect(first.status).toBe(201)
    expect(await first.json()).toMatchObject({ status: 'recorded', seq: 1, deletion_id: D1 })
    const again = await post(h, D1, hashAccountId(U1))
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ seq: 1 })
    // Same subject under another deletion id: the existing record (and its id) wins.
    const other = await post(h, D2, hashAccountId(U1))
    expect(other.status).toBe(200)
    expect(await other.json()).toMatchObject({ seq: 1, deletion_id: D1 })
    const second = await post(h, D2, hashAccountId(U2))
    expect(await second.json()).toMatchObject({ seq: 2 })
    const head = await h.call('/v1/head', { token: OPERATOR })
    expect(await head.json()).toMatchObject({ seq: 2, records: 2 })
  })

  it('refuses a deletion id reused for another subject (409) without writing', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    const conflict = await post(h, D1, hashAccountId(U2))
    expect(conflict.status).toBe(409)
    const head = (await (await h.call('/v1/head', { token: OPERATOR })).json()) as unknown
    expect(head).toMatchObject({ records: 1 })
  })

  it('serialises concurrent appends into a gap-free chain', async () => {
    const h = harness()
    const ids = Array.from({ length: 25 }, (_, i) => {
      const n = String(i).padStart(2, '0')
      return {
        deletion: `cccccccc-cccc-4ccc-8ccc-0000000000${n}`,
        user: `dddddddd-dddd-4ddd-8ddd-0000000000${n}`,
      }
    })
    const results = await Promise.all(ids.map((x) => post(h, x.deletion, hashAccountId(x.user))))
    expect(results.every((r) => r.status === 201)).toBe(true)
    const text = await (await h.call('/v1/export', { token: OPERATOR })).text()
    expect(parseRegistry(text, KEY).head.records).toBe(25)
  })

  it('stores nothing but the minimum record: no extra field survives, an email is refused', async () => {
    const h = harness()
    const res = await post(h, D1, hashAccountId(U1), {
      email: 'someone@example.invalid',
      name: 'X',
    })
    expect(res.status).toBe(201)
    const row = h.db.prepare('SELECT * FROM erasures').all()[0] as Record<string, unknown>
    expect(Object.keys(row).sort()).toEqual([
      'deleted_at',
      'deletion_id',
      'mac',
      'prev',
      'seq',
      'subject',
    ])
    expect((await post(h, D2, 'someone@example.invalid')).status).toBe(400)
    expect(JSON.stringify(h.db.prepare('SELECT * FROM erasures').all())).not.toContain(
      'example.invalid',
    )
  })

  it('rejects malformed, oversize and wrong-scope requests', async () => {
    const h = harness()
    expect((await h.call('/v1/erasures', { method: 'POST', body: '{not json' })).status).toBe(400)
    expect((await h.call('/v1/erasures', { method: 'POST', body: '[]' })).status).toBe(400)
    expect((await post(h, D1, hashAccountId(U1), { scope: 2 })).status).toBe(400)
    expect((await post(h, 'not-a-uuid', hashAccountId(U1))).status).toBe(400)
    expect((await post(h, D1, hashAccountId(U1), { deleted_at: 'yesterday' })).status).toBe(400)
    const big = await h.call('/v1/erasures', { method: 'POST', body: 'x'.repeat(5000) })
    expect(big.status).toBe(413)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM erasures').get()).toMatchObject({ n: 0 })
  })

  it('is confirmed by the real Edge Function client', async () => {
    const h = harness()
    const fetchImpl: typeof fetch = (input, init) => worker.fetch(new Request(input, init), h.env)
    const receipt = await appendErasure(
      { url: 'https://registry.invalid', token: APPEND },
      { deletionId: D1, subject: hashAccountId(U1), deletedAt: NOW },
      fetchImpl,
    )
    expect(receipt).toEqual({ seq: 1, deletionId: D1 })
    await expect(
      appendErasure(
        { url: 'https://registry.invalid', token: 'wrong-token-wrong-token-wrong' },
        { deletionId: D2, subject: hashAccountId(U2), deletedAt: NOW },
        fetchImpl,
      ),
    ).rejects.toBeInstanceOf(SinkError)
  })
})

describe('authentication and surface', () => {
  it('answers 401 to everything without a valid token, on every route and method', async () => {
    const h = harness()
    for (const [path, method] of [
      ['/v1/erasures', 'POST'],
      ['/v1/head', 'GET'],
      ['/v1/export', 'GET'],
      ['/', 'GET'],
      ['/v1/erasures', 'DELETE'],
    ] as const) {
      expect((await h.call(path, { method, token: null })).status).toBe(401)
      expect((await h.call(path, { method, token: 'x'.repeat(30) })).status).toBe(401)
    }
  })

  it('keeps the append credential away from every read, and the operator away from appends', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    expect((await h.call('/v1/head', { token: APPEND })).status).toBe(403)
    expect((await h.call('/v1/export', { token: APPEND })).status).toBe(403)
    const viaOperator = await h.call('/v1/erasures', {
      method: 'POST',
      token: OPERATOR,
      body: JSON.stringify({
        deletion_id: D2,
        subject: hashAccountId(U2),
        deleted_at: NOW,
        scope: 1,
      }),
    })
    expect(viaOperator.status).toBe(403)
  })

  it('exposes no listing, update or delete route', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    for (const [path, method] of [
      ['/v1/erasures', 'GET'],
      [`/v1/erasures/${D1}`, 'GET'],
      [`/v1/erasures/${D1}`, 'DELETE'],
      [`/v1/erasures/${D1}`, 'PUT'],
      ['/v1/export', 'POST'],
      ['/v1/head', 'DELETE'],
    ] as const) {
      expect([404, 403]).toContain((await h.call(path, { method, token: OPERATOR })).status)
    }
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM erasures').get()).toMatchObject({ n: 1 })
  })

  it('refuses to run with a missing/short key, short tokens or identical tokens (503, no write)', async () => {
    for (const bad of [
      { ERASURE_REGISTRY_KEY: undefined },
      { ERASURE_REGISTRY_KEY: 'abcd' },
      { ERASURE_APPEND_TOKEN: 'short' },
      { ERASURE_OPERATOR_TOKEN: APPEND },
    ]) {
      const h = harness(bad)
      expect((await post(h, D1, hashAccountId(U1))).status).toBe(503)
    }
  })
})

describe('integrity, export and backup', () => {
  it('aborts UPDATE and DELETE in SQL (append-only at the storage layer)', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    expect(() => {
      h.db.exec("UPDATE erasures SET subject = 'x'")
    }).toThrow(/append-only/)
    expect(() => {
      h.db.exec('DELETE FROM erasures')
    }).toThrow(/append-only/)
  })

  it('exports exactly the registry file format; the canonical parser and gate reader accept it', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    await post(h, D2, hashAccountId(U2))
    const text = await (await h.call('/v1/export', { token: OPERATOR })).text()
    expect(text.endsWith('\n')).toBe(true)
    const parsed = parseRegistry(text, KEY)
    expect(parsed.records.map((r) => r.subject)).toEqual([hashAccountId(U1), hashAccountId(U2)])
    const file = join(dir, 'registry.ndjson')
    writeFileSync(file, text)
    expect(readRegistryFile(file, KEY).head.seq).toBe(2)
    // The wrong key (an attacker who forged a ledger) is refused by the gate's parser.
    expect(() => parseRegistry(text, parseRegistryKey('fedcba9876543210'.repeat(4)))).toThrow(
      RegistryError,
    )
  })

  it('fails closed when stored data is tampered with behind the triggers: no export, no append', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    await post(h, D2, hashAccountId(U2))
    h.db.exec('DROP TRIGGER erasures_no_update')
    h.db.exec("UPDATE erasures SET subject = '" + 'f'.repeat(64) + "' WHERE seq = 1")
    expect((await h.call('/v1/export', { token: OPERATOR })).status).toBe(500)
    h.db.exec("UPDATE erasures SET deleted_at = '2030-01-01T00:00:00Z' WHERE seq = 2")
    expect(
      (
        await post(
          h,
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          hashAccountId('33333333-3333-4333-8333-333333333333'),
        )
      ).status,
    ).toBe(500)
  })

  it('detects a record removed from the middle of the chain', async () => {
    const h = harness()
    for (const [d, u] of [
      [D1, U1],
      [D2, U2],
      ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333'],
    ] as const) {
      await post(h, d, hashAccountId(u))
    }
    h.db.exec('DROP TRIGGER erasures_no_delete')
    h.db.exec('DELETE FROM erasures WHERE seq = 2')
    expect((await h.call('/v1/export', { token: OPERATOR })).status).toBe(500)
  })

  it('registry-export writes a verified file atomically and refuses a corrupt download', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    await post(h, D2, hashAccountId(U2))
    const fetchImpl: typeof fetch = (input, init) => worker.fetch(new Request(input, init), h.env)
    const out = join(dir, 'backup.ndjson')
    const done = await exportRegistry({
      url: 'https://registry.invalid',
      token: OPERATOR,
      key: KEY,
      out,
      fetchImpl,
    })
    expect(done).toEqual({ records: 2, seq: 2 })
    expect(readRegistryFile(out, KEY).head.records).toBe(2)

    const corrupt: typeof fetch = () =>
      Promise.resolve(
        new Response(readFileSync(out, 'utf8').replace(/"seq":2/, '"seq":3'), { status: 200 }),
      )
    const out2 = join(dir, 'never-written.ndjson')
    await expect(
      exportRegistry({
        url: 'https://registry.invalid',
        token: OPERATOR,
        key: KEY,
        out: out2,
        fetchImpl: corrupt,
      }),
    ).rejects.toBeInstanceOf(RegistryError)
    expect(() => readFileSync(out2)).toThrow()

    const torn: typeof fetch = () =>
      Promise.resolve(new Response(readFileSync(out, 'utf8').slice(0, -1), { status: 200 }))
    await expect(
      exportRegistry({
        url: 'https://registry.invalid',
        token: OPERATOR,
        key: KEY,
        out: out2,
        fetchImpl: torn,
      }),
    ).rejects.toThrow()
  })

  it('registry-export never replaces a newer backup with an older download, and refuses http/unreachable/denied', async () => {
    const h = harness()
    await post(h, D1, hashAccountId(U1))
    const fetchImpl: typeof fetch = (input, init) => worker.fetch(new Request(input, init), h.env)
    const out = join(dir, 'backup.ndjson')
    await exportRegistry({
      url: 'https://registry.invalid',
      token: OPERATOR,
      key: KEY,
      out,
      fetchImpl,
    })
    await post(h, D2, hashAccountId(U2))
    await exportRegistry({
      url: 'https://registry.invalid',
      token: OPERATOR,
      key: KEY,
      out,
      fetchImpl,
    })
    const staleHarness = harness()
    const stale: typeof fetch = (input, init) =>
      worker.fetch(new Request(input, init), staleHarness.env)
    await post(staleHarness, D1, hashAccountId(U1))
    await expect(
      exportRegistry({
        url: 'https://registry.invalid',
        token: OPERATOR,
        key: KEY,
        out,
        fetchImpl: stale,
      }),
    ).rejects.toBeInstanceOf(RegistryError)
    expect(readRegistryFile(out, KEY).head.seq).toBe(2)

    await expect(
      exportRegistry({ url: 'http://registry.example', token: OPERATOR, key: KEY, out, fetchImpl }),
    ).rejects.toBeInstanceOf(RegistryError)
    const down: typeof fetch = () => Promise.reject(new Error('offline'))
    await expect(
      exportRegistry({
        url: 'https://registry.invalid',
        token: OPERATOR,
        key: KEY,
        out,
        fetchImpl: down,
      }),
    ).rejects.toBeInstanceOf(RegistryError)
    await expect(
      exportRegistry({ url: 'https://registry.invalid', token: APPEND, key: KEY, out, fetchImpl }),
    ).rejects.toBeInstanceOf(RegistryError)
  })
})
