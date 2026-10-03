import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  gatePayload,
  generateRegistryKey,
  GENESIS_PREV,
  hashAccountId,
  parseRegistry,
  parseRegistryKey,
  RegistryError,
  RegistryStore,
  signRecord,
} from '../../scripts/restore-gate/erasure-registry'
import { createSink } from '../../scripts/restore-gate/registry-sink'
import {
  appendErasure,
  loadSinkConfig,
  SinkError,
} from '../../supabase/functions/_shared/erasure-sink'

/**
 * P189: the erasure registry format, its integrity rules and its write contract. Synthetic ids only.
 */

const KEY_HEX = '0123456789abcdef'.repeat(4)
const KEY = parseRegistryKey(KEY_HEX)
const OTHER_KEY = parseRegistryKey('fedcba9876543210'.repeat(4))
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const D1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const D2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOW = '2026-10-02T10:00:00Z'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p189-reg-'))
  path = join(dir, 'registry.ndjson')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const record = (store: RegistryStore, id: string, user: string) =>
  store.append({ deletion_id: id, subject: hashAccountId(user), deleted_at: NOW })

describe('subject hash', () => {
  it('is a namespaced SHA-256 of the lower-cased UUID and is case-insensitive', () => {
    expect(hashAccountId(U1)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAccountId(U1.toUpperCase())).toBe(hashAccountId(U1))
    expect(hashAccountId(U1)).not.toBe(hashAccountId(U2))
  })
  it('refuses anything that is not a UUID (an email can never be hashed into a record)', () => {
    expect(() => hashAccountId('someone@example.invalid')).toThrow(RegistryError)
    expect(() => hashAccountId('')).toThrow(RegistryError)
  })
})

describe('key handling', () => {
  it('requires at least 32 bytes of hex', () => {
    expect(() => parseRegistryKey(undefined)).toThrow(/not set/)
    expect(() => parseRegistryKey('abcd')).toThrow(/64 hex/)
    expect(() => parseRegistryKey('z'.repeat(64))).toThrow(/64 hex/)
    expect(parseRegistryKey(generateRegistryKey())).toHaveLength(32)
  })
})

describe('append + parse', () => {
  it('writes canonical records that verify, with contiguous sequence numbers and a linked chain', () => {
    const store = new RegistryStore(path, KEY)
    const a = record(store, D1, U1)
    const b = record(store, D2, U2)
    expect([a.created, b.created]).toEqual([true, true])
    expect([a.record.seq, b.record.seq]).toEqual([1, 2])
    expect(a.record.prev).toBe(GENESIS_PREV)
    expect(b.record.prev).toBe(a.record.mac)
    const parsed = store.read()
    expect(parsed.head).toEqual({ seq: 2, mac: b.record.mac, records: 2 })
    expect(gatePayload(parsed.records).map((r) => r.seq)).toEqual([1, 2])
  })

  it('stores nothing but the minimum fields: no id, address or name', () => {
    const store = new RegistryStore(path, KEY)
    record(store, D1, U1)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(U1)
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(
      ['deleted_at', 'deletion_id', 'mac', 'prev', 'scope', 'seq', 'subject', 'v'].sort(),
    )
  })

  it('is idempotent: the same erasure again returns the same record and adds nothing', () => {
    const store = new RegistryStore(path, KEY)
    const first = record(store, D1, U1)
    const again = record(store, D1, U1)
    expect(again.created).toBe(false)
    expect(again.record).toEqual(first.record)
    expect(store.read().head.records).toBe(1)
  })

  it('returns the existing record when the same subject arrives under another deletion id', () => {
    const store = new RegistryStore(path, KEY)
    const first = record(store, D1, U1)
    const again = record(store, D2, U1)
    expect(again.created).toBe(false)
    expect(again.record.deletion_id).toBe(first.record.deletion_id)
    expect(store.read().head.records).toBe(1)
  })

  it('refuses a deletion id that is already recorded for a different subject', () => {
    const store = new RegistryStore(path, KEY)
    record(store, D1, U1)
    expect(() => record(store, D1, U2)).toThrow(/another subject/)
  })

  it('an empty or absent registry parses to zero records (the gate decides whether that is acceptable)', () => {
    expect(new RegistryStore(path, KEY).read().head).toEqual({
      seq: 0,
      mac: GENESIS_PREV,
      records: 0,
    })
  })
})

describe('integrity: every kind of damage is a refusal', () => {
  const build = (): string[] => {
    const store = new RegistryStore(path, KEY)
    record(store, D1, U1)
    record(store, D2, U2)
    return readFileSync(path, 'utf8').trimEnd().split('\n')
  }
  const expectRefused = (text: string, code: string, key = KEY) => {
    try {
      parseRegistry(text, key)
      throw new Error('was accepted')
    } catch (e) {
      expect(e).toBeInstanceOf(RegistryError)
      expect((e as RegistryError).code).toBe(code)
    }
  }

  it('wrong key', () => {
    build()
    expectRefused(readFileSync(path, 'utf8'), 'mac_invalid', OTHER_KEY)
  })
  it('an edited subject', () => {
    const [l1, l2] = build()
    const edited = JSON.parse(l1!) as Record<string, unknown>
    edited.subject = 'f'.repeat(64)
    expectRefused(`${JSON.stringify(edited)}\n${l2!}\n`, 'mac_invalid')
  })
  it('a record dropped from the middle', () => {
    const store = new RegistryStore(path, KEY)
    record(store, D1, U1)
    record(store, D2, U2)
    record(store, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '33333333-3333-4333-8333-333333333333')
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expectRefused(`${lines[0]!}\n${lines[2]!}\n`, 'sequence_gap')
  })
  it('reordered records', () => {
    const [l1, l2] = build()
    expectRefused(`${l2!}\n${l1!}\n`, 'sequence_gap')
  })
  it('a torn final write (no trailing newline)', () => {
    const [l1, l2] = build()
    expectRefused(`${l1!}\n${l2!.slice(0, -10)}`, 'torn_record')
  })
  it('malformed JSON, extra fields and wrong types', () => {
    const [l1] = build()
    expectRefused('not json\n', 'malformed_record')
    expectRefused(`${JSON.stringify({ ...JSON.parse(l1!), extra: 1 })}\n`, 'malformed_record')
    expectRefused(`${JSON.stringify({ ...JSON.parse(l1!), seq: '1' })}\n`, 'malformed_record')
    expectRefused(`${JSON.stringify({ ...JSON.parse(l1!), subject: 'zz' })}\n`, 'malformed_record')
  })
  it('an unsupported schema version or scope is refused, never skipped', () => {
    const [l1] = build()
    expectRefused(`${JSON.stringify({ ...JSON.parse(l1!), v: 3 })}\n`, 'unsupported_schema')
    expectRefused(`${JSON.stringify({ ...JSON.parse(l1!), scope: 2 })}\n`, 'unsupported_scope')
  })
  it('a broken chain (prev does not link)', () => {
    const [l1, l2] = build()
    const b = JSON.parse(l2!) as Record<string, unknown>
    b.prev = 'e'.repeat(64)
    expectRefused(`${l1!}\n${JSON.stringify(b)}\n`, 'chain_broken')
  })
  it('contradictory duplicates with VALID signatures: the same deletion id twice, or the same subject twice', () => {
    const base = { v: 2 as const, deleted_at: NOW, scope: 1 as const }
    const r1 = signRecord(KEY, {
      ...base,
      seq: 1,
      deletion_id: D1,
      subject: hashAccountId(U1),
      prev: GENESIS_PREV,
    })
    const sameId = signRecord(KEY, {
      ...base,
      seq: 2,
      deletion_id: D1,
      subject: hashAccountId(U2),
      prev: r1.mac,
    })
    const sameSubject = signRecord(KEY, {
      ...base,
      seq: 2,
      deletion_id: D2,
      subject: hashAccountId(U1),
      prev: r1.mac,
    })
    const lines = (...rs: object[]) => rs.map((r) => JSON.stringify(r)).join('\n') + '\n'
    expectRefused(lines(r1, sameId), 'duplicate_deletion_id')
    expectRefused(lines(r1, sameSubject), 'duplicate_subject')
  })
  it('a hand-copied duplicate line is refused', () => {
    const store = new RegistryStore(path, KEY)
    const line = JSON.stringify(record(store, D1, U1).record)
    expectRefused(`${line}\n${line}\n`, 'sequence_gap')
  })
  it('the head of a valid registry is what a promoter can pin', () => {
    build()
    expect(parseRegistry(readFileSync(path, 'utf8'), KEY).head.seq).toBe(2)
  })
  it('a registry file with CRLF line endings still verifies', () => {
    build()
    const text = readFileSync(path, 'utf8').replaceAll('\n', '\r\n')
    writeFileSync(path, text)
    expect(() => parseRegistry(text.replaceAll('\r\n', '\n'), KEY)).not.toThrow()
  })
})

describe('sink client configuration (loadSinkConfig)', () => {
  const env = (o: Record<string, string>) => ({ get: (n: string) => o[n] })
  const TOKEN = 't'.repeat(32)
  it('is null (deletion refused) when either value is missing or the token is short', () => {
    expect(loadSinkConfig(env({}))).toBeNull()
    expect(loadSinkConfig(env({ ERASURE_REGISTRY_URL: 'https://r.example.invalid' }))).toBeNull()
    expect(
      loadSinkConfig(
        env({ ERASURE_REGISTRY_URL: 'https://r.example.invalid', ERASURE_REGISTRY_TOKEN: 'short' }),
      ),
    ).toBeNull()
  })
  it('requires https, except for loopback / Docker-host names', () => {
    const base = { ERASURE_REGISTRY_TOKEN: TOKEN }
    expect(
      loadSinkConfig(env({ ...base, ERASURE_REGISTRY_URL: 'http://r.example.invalid' })),
    ).toBeNull()
    expect(
      loadSinkConfig(env({ ...base, ERASURE_REGISTRY_URL: 'https://r.example.invalid/x/' }))?.url,
    ).toBe('https://r.example.invalid/x')
    expect(
      loadSinkConfig(env({ ...base, ERASURE_REGISTRY_URL: 'http://host.docker.internal:55790' })),
    ).not.toBeNull()
    expect(
      loadSinkConfig(env({ ...base, ERASURE_REGISTRY_URL: 'http://127.0.0.1:1' })),
    ).not.toBeNull()
  })
  it('refuses credentials, queries and fragments in the URL', () => {
    const base = { ERASURE_REGISTRY_TOKEN: TOKEN }
    for (const u of [
      'https://u:p@r.example.invalid',
      'https://r.example.invalid?x=1',
      'https://r.example.invalid#f',
    ]) {
      expect(loadSinkConfig(env({ ...base, ERASURE_REGISTRY_URL: u }))).toBeNull()
    }
  })
})

describe('sink client: only a confirmed record for the record it sent is a success', () => {
  const config = { url: 'https://r.example.invalid', token: 't'.repeat(32) }
  const input = { deletionId: D1, subject: hashAccountId(U1), deletedAt: NOW }
  const reply =
    (status: number, body: unknown): typeof fetch =>
    () =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
  const good = { status: 'recorded', seq: 4, deletion_id: D1, subject: input.subject }

  it('accepts 200 and 201 with a matching confirmation', async () => {
    expect(await appendErasure(config, input, reply(201, good))).toEqual({ seq: 4, deletionId: D1 })
    expect(await appendErasure(config, input, reply(200, good))).toEqual({ seq: 4, deletionId: D1 })
  })
  it.each([
    ['a refusal', reply(401, { error: 'unauthorized' })],
    ['a server error', reply(500, {})],
    ['a redirect-like status', reply(302, {})],
    ['no confirmation', reply(200, {})],
    ['the wrong status word', reply(200, { ...good, status: 'queued' })],
    ['a different subject', reply(200, { ...good, subject: 'f'.repeat(64) })],
    ['a missing sequence', reply(200, { ...good, seq: undefined })],
    ['a non-integer sequence', reply(200, { ...good, seq: 1.5 })],
    ['a zero sequence', reply(200, { ...good, seq: 0 })],
    ['a malformed deletion id', reply(200, { ...good, deletion_id: 'x' })],
  ])('rejects %s', async (_name, f) => {
    await expect(appendErasure(config, input, f)).rejects.toBeInstanceOf(SinkError)
  })
  it('rejects an unreachable registry and unreadable JSON', async () => {
    await expect(
      appendErasure(config, input, () => Promise.reject(new Error('ECONNREFUSED'))),
    ).rejects.toBeInstanceOf(SinkError)
    await expect(
      appendErasure(config, input, () =>
        Promise.resolve(new Response('not json', { status: 200 })),
      ),
    ).rejects.toBeInstanceOf(SinkError)
  })
  it('sends only the minimum fields and the bearer token', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    await appendErasure(config, input, ((url: string, init: RequestInit) => {
      seen = { url, init }
      return Promise.resolve(new Response(JSON.stringify(good), { status: 201 }))
    }) as unknown as typeof fetch)
    expect(seen?.url).toBe('https://r.example.invalid/v1/erasures')
    expect(JSON.parse(seen?.init.body as string)).toEqual({
      deletion_id: D1,
      subject: input.subject,
      deleted_at: NOW,
      scope: 1,
    })
    expect((seen?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${config.token}`,
    )
  })
})

describe('the reference sink (HTTP contract)', () => {
  const TOKEN = 's'.repeat(32)
  let server: ReturnType<typeof createSink>
  let base: string
  beforeEach(async () => {
    server = createSink({ registryPath: path, key: KEY, token: TOKEN })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })
  afterEach(async () => {
    await new Promise<void>((r) =>
      server.close(() => {
        r()
      }),
    )
  })
  const post = (body: unknown, token: string | null = TOKEN) =>
    fetch(`${base}/v1/erasures`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  const body = { deletion_id: D1, subject: hashAccountId(U1), deleted_at: NOW, scope: 1 }

  it('refuses a missing or wrong token before reading anything', async () => {
    expect((await post(body, null)).status).toBe(401)
    expect((await post(body, 'x'.repeat(32))).status).toBe(401)
    expect(new RegistryStore(path, KEY).read().head.records).toBe(0)
  })
  it('records durably, answers 201 then 200 for the replay, with the same sequence', async () => {
    const first = await post(body)
    const again = await post(body)
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(((await first.json()) as { seq: number }).seq).toBe(1)
    expect(((await again.json()) as { seq: number }).seq).toBe(1)
    expect(new RegistryStore(path, KEY).read().head.records).toBe(1)
  })
  it('rejects malformed bodies and a conflicting deletion id', async () => {
    expect((await post({ ...body, scope: 2 })).status).toBe(400)
    expect((await post({ ...body, subject: 'nope' })).status).toBe(400)
    await post(body)
    expect((await post({ ...body, subject: hashAccountId(U2) })).status).toBe(409)
  })
  it('stops accepting writes when the registry file no longer verifies (never appends to damage)', async () => {
    await post(body)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"seq":1', '"seq":9'))
    expect((await post({ ...body, deletion_id: D2, subject: hashAccountId(U2) })).status).toBe(500)
  })
  it('serves its head to an authorised caller only', async () => {
    await post(body)
    const ok = await fetch(`${base}/v1/head`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect(((await ok.json()) as { records: number }).records).toBe(1)
    expect((await fetch(`${base}/v1/head`)).status).toBe(401)
  })
})
