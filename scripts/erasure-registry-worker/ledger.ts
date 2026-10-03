/**
 * The erasure ledger: the storage-side core of the production erasure registry (P195).
 *
 * It implements the write/read contract of scripts/restore-gate/registry-sink.ts on top of a SQL
 * store with transactional, serialised access (a Cloudflare Durable Object with SQLite storage in
 * production, node:sqlite in the tests). The record format, the hash chain and the HMAC are
 * byte-for-byte those of scripts/restore-gate/erasure-registry.ts — `exportNdjson()` output is
 * parsed by that module's `parseRegistry`, which is what the restore gate consumes.
 *
 * Uses only node:crypto (synchronous), so an append is one uninterrupted unit of work: read the
 * head, sign, insert, all inside a transaction. Nothing here can update or delete a record: the
 * table carries triggers that abort UPDATE and DELETE, and the public surface has no such method.
 *
 * Holds no personal data: a record is a deletion id, a salted-by-namespace SHA-256 of a random
 * account UUID, and a timestamp.
 */
import { createHmac } from 'node:crypto'

export const SCHEMA_VERSION = 2
export const SCOPE_VERSION = 1
export const GENESIS_PREV = '0'.repeat(64)

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

export type LedgerErrorCode = 'malformed' | 'conflict' | 'integrity' | 'key'

export class LedgerError extends Error {
  readonly code: LedgerErrorCode
  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

export interface LedgerSql {
  all(query: string, ...bindings: (string | number)[]): Record<string, unknown>[]
  run(query: string, ...bindings: (string | number)[]): void
  /** Runs `fn` atomically; every write inside is committed together or not at all. */
  transaction<T>(fn: () => T): T
}

export interface LedgerRecord {
  v: 2
  seq: number
  deletion_id: string
  subject: string
  deleted_at: string
  scope: 1
  prev: string
  mac: string
}

export interface LedgerHead {
  seq: number
  mac: string
  records: number
}

export function parseKey(hex: string | undefined): Buffer {
  const t = hex?.trim()
  if (!t || !/^[0-9a-fA-F]{64,}$/.test(t) || t.length % 2 !== 0) {
    throw new LedgerError('key', 'the registry key must be at least 64 hex characters')
  }
  return Buffer.from(t, 'hex')
}

function macOf(key: Buffer, r: Omit<LedgerRecord, 'mac'>): string {
  const canonical = JSON.stringify([
    r.v,
    r.seq,
    r.deletion_id,
    r.subject,
    r.deleted_at,
    r.scope,
    r.prev,
  ])
  return createHmac('sha256', key)
    .update('pokeportfolio:erasure-registry:v2\n')
    .update(canonical)
    .digest('hex')
}

function toRecord(row: Record<string, unknown>): LedgerRecord {
  return {
    v: SCHEMA_VERSION,
    seq: Number(row.seq),
    deletion_id: String(row.deletion_id),
    subject: String(row.subject),
    deleted_at: String(row.deleted_at),
    scope: SCOPE_VERSION,
    prev: String(row.prev),
    mac: String(row.mac),
  }
}

export interface AppendInput {
  deletion_id: string
  subject: string
  deleted_at: string
}

export class Ledger {
  private readonly sql: LedgerSql
  private readonly key: Buffer

  constructor(sql: LedgerSql, key: Buffer) {
    this.sql = sql
    this.key = key
    sql.run(
      `CREATE TABLE IF NOT EXISTS erasures (
         seq INTEGER PRIMARY KEY,
         deletion_id TEXT NOT NULL UNIQUE,
         subject TEXT NOT NULL UNIQUE,
         deleted_at TEXT NOT NULL,
         prev TEXT NOT NULL,
         mac TEXT NOT NULL
       )`,
    )
    sql.run(
      `CREATE TRIGGER IF NOT EXISTS erasures_no_update BEFORE UPDATE ON erasures
       BEGIN SELECT RAISE(ABORT, 'erasures is append-only'); END`,
    )
    sql.run(
      `CREATE TRIGGER IF NOT EXISTS erasures_no_delete BEFORE DELETE ON erasures
       BEGIN SELECT RAISE(ABORT, 'erasures is append-only'); END`,
    )
  }

  private tail(): LedgerRecord | undefined {
    const row = this.sql.all('SELECT * FROM erasures ORDER BY seq DESC LIMIT 1')[0]
    return row ? toRecord(row) : undefined
  }

  /** Records the erasure. Idempotent on deletion id and on subject, exactly like RegistryStore. */
  append(input: AppendInput): { record: LedgerRecord; created: boolean } {
    if (
      !UUID.test(input.deletion_id) ||
      !HEX64.test(input.subject) ||
      !ISO.test(input.deleted_at) ||
      Number.isNaN(Date.parse(input.deleted_at))
    ) {
      throw new LedgerError('malformed', 'invalid erasure record')
    }
    return this.sql.transaction(() => {
      const tail = this.tail()
      // A damaged head must stop writes: appending to a chain that does not verify buries the damage.
      if (tail) {
        const { mac, ...rest } = tail
        if (macOf(this.key, rest) !== mac) throw new LedgerError('integrity', 'head failed its MAC')
      }
      const sameId = this.sql.all(
        'SELECT * FROM erasures WHERE deletion_id = ?',
        input.deletion_id,
      )[0]
      if (sameId) {
        const existing = toRecord(sameId)
        if (existing.subject !== input.subject) {
          throw new LedgerError('conflict', 'deletion id already recorded for another subject')
        }
        return { record: existing, created: false }
      }
      const sameSubject = this.sql.all('SELECT * FROM erasures WHERE subject = ?', input.subject)[0]
      if (sameSubject) return { record: toRecord(sameSubject), created: false }

      const base = {
        v: SCHEMA_VERSION,
        seq: (tail?.seq ?? 0) + 1,
        deletion_id: input.deletion_id,
        subject: input.subject,
        deleted_at: input.deleted_at,
        scope: SCOPE_VERSION,
        prev: tail?.mac ?? GENESIS_PREV,
      } as const
      const record: LedgerRecord = { ...base, mac: macOf(this.key, base) }
      this.sql.run(
        'INSERT INTO erasures (seq, deletion_id, subject, deleted_at, prev, mac) VALUES (?, ?, ?, ?, ?, ?)',
        record.seq,
        record.deletion_id,
        record.subject,
        record.deleted_at,
        record.prev,
        record.mac,
      )
      return { record, created: true }
    })
  }

  head(): LedgerHead {
    const count = Number(this.sql.all('SELECT COUNT(*) AS n FROM erasures')[0]?.n ?? 0)
    const tail = this.tail()
    return { seq: tail?.seq ?? 0, mac: tail?.mac ?? GENESIS_PREV, records: count }
  }

  /**
   * The whole chain in the registry file format (NDJSON, newline-terminated). The chain is fully
   * re-verified first; a store that fails its own integrity check is never exported as if it were
   * sound.
   */
  exportNdjson(): string {
    const rows = this.sql.all('SELECT * FROM erasures ORDER BY seq ASC').map(toRecord)
    let prev = GENESIS_PREV
    let lines = ''
    for (const [i, r] of rows.entries()) {
      const { mac, ...rest } = r
      if (r.seq !== i + 1 || r.prev !== prev || macOf(this.key, rest) !== mac) {
        throw new LedgerError('integrity', 'stored chain failed verification')
      }
      prev = r.mac
      lines += `${JSON.stringify(r)}\n`
    }
    return lines
  }
}
