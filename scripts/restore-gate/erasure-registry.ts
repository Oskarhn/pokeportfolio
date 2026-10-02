/**
 * The erasure registry: an append-only, integrity-chained record of account erasures that lives
 * OUTSIDE every database backup (P189, which replaces P156's undated hash list).
 *
 * Why it exists. Deleting an account removes it from the LIVE database; nothing in a backup taken
 * earlier can know that it happened, so restoring that backup resurrects the person — login,
 * profile, ledger. The only thing that can prevent that is a record the restore cannot overwrite.
 * The source of truth therefore must NOT be restored together with the snapshot it corrects: keep it
 * on a different system, with different credentials, backed up on its own schedule.
 *
 * What a record holds — the minimum that lets a restore recognise an erased account, and nothing
 * else (no address, no name, no financial data, no credential, no token):
 *
 *   v            schema version (2). Unsupported versions are refused, never skipped.
 *   seq          1, 2, 3 … with no gaps. A gap or a repeat is corruption or tampering.
 *   deletion_id  random UUID of this erasure; the idempotency key between the deletion workflow,
 *                the registry and the database's witness copy (account_erasure_receipts).
 *   subject      SHA-256 of a namespaced, lower-cased account UUID. The UUID is random (122 bits), so
 *                the hash cannot be enumerated back to a person; it is compared only with ids found
 *                inside a restored image. The stable Supabase auth user UUID is sufficient: it is the
 *                key every owned row and the login itself carry, so nothing else is needed.
 *   deleted_at   when the erasure was recorded (UTC, ISO 8601).
 *   scope        1 = the account, its login and all application data listed in
 *                docs/security/P189_DELETION_DATA_MAP.md. A restore must replay at least this scope.
 *   prev, mac    hash chain and HMAC-SHA256 over the record under an operator-held key, so an edited,
 *                reordered, dropped-from-the-middle or forged record fails verification.
 *
 * Format: newline-delimited canonical JSON, one record per line, file must end in a newline (a torn
 * final write is a refusal). Append-only by construction here; make it append-only on the storage
 * side too (object-lock / WORM / an operator account without delete) where the host supports it.
 *
 * Truncation of the TAIL cannot be detected from the file alone — an attacker or an accident that
 * removes the last records leaves a valid chain. That is why the database keeps a witness copy of
 * every receipt (account_erasure_receipts): a restored image whose newest receipt is beyond the
 * registry's head proves the registry is older than the backup, and the gate refuses it. Operators
 * may additionally pin the head they expect (--expect-head-seq).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'

export const REGISTRY_SCHEMA_VERSION = 2
export const ERASURE_SCOPE_VERSION = 1
export const GENESIS_PREV = '0'.repeat(64)

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

export type RegistryErrorCode =
  | 'key_missing'
  | 'key_invalid'
  | 'torn_record'
  | 'malformed_record'
  | 'unsupported_schema'
  | 'unsupported_scope'
  | 'sequence_gap'
  | 'chain_broken'
  | 'mac_invalid'
  | 'duplicate_deletion_id'
  | 'duplicate_subject'
  | 'conflicting_record'
  | 'unreadable'

export class RegistryError extends Error {
  readonly code: RegistryErrorCode
  constructor(code: RegistryErrorCode, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.code = code
  }
}

export interface RegistryRecord {
  v: 2
  seq: number
  deletion_id: string
  subject: string
  deleted_at: string
  scope: 1
  prev: string
  mac: string
}

export interface RegistryHead {
  seq: number
  mac: string
  records: number
}

/** The registry's stand-in for an account id. Must equal public.erasure_subject_hash(uuid). */
export function hashAccountId(id: string): string {
  const lower = id.toLowerCase()
  if (!UUID.test(lower)) throw new RegistryError('malformed_record', 'not an account id')
  return createHash('sha256').update(`pokeportfolio:erased-account:${lower}`).digest('hex')
}

/** The MAC key: at least 32 random bytes as hex (64+ hex characters). Supplied by the operator. */
export function parseRegistryKey(text: string | undefined): Buffer {
  const trimmed = text?.trim()
  if (!trimmed) throw new RegistryError('key_missing', 'the registry key is not set')
  if (!/^[0-9a-fA-F]{64,}$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new RegistryError('key_invalid', 'the registry key must be at least 64 hex characters')
  }
  return Buffer.from(trimmed, 'hex')
}

export function generateRegistryKey(): string {
  return randomBytes(32).toString('hex')
}

function macOf(key: Buffer, r: Omit<RegistryRecord, 'mac'>): string {
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

/** Signs a record body. Exposed for the store and for tests that must forge VALID-but-contradictory records. */
export function signRecord(key: Buffer, base: Omit<RegistryRecord, 'mac'>): RegistryRecord {
  return { ...base, mac: macOf(key, base) }
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

const KEYS = ['v', 'seq', 'deletion_id', 'subject', 'deleted_at', 'scope', 'prev', 'mac'] as const

function parseLine(line: string, lineNo: number): RegistryRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw new RegistryError('malformed_record', `line ${String(lineNo)} is not JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RegistryError('malformed_record', `line ${String(lineNo)} is not an object`)
  }
  const o = value as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) {
    throw new RegistryError('malformed_record', `line ${String(lineNo)} has unexpected fields`)
  }
  if (o.v !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryError(
      'unsupported_schema',
      `line ${String(lineNo)}: unsupported schema version`,
    )
  }
  if (o.scope !== ERASURE_SCOPE_VERSION) {
    throw new RegistryError(
      'unsupported_scope',
      `line ${String(lineNo)}: unsupported erasure scope`,
    )
  }
  if (
    typeof o.seq !== 'number' ||
    !Number.isSafeInteger(o.seq) ||
    o.seq < 1 ||
    typeof o.deletion_id !== 'string' ||
    !UUID.test(o.deletion_id) ||
    typeof o.subject !== 'string' ||
    !HEX64.test(o.subject) ||
    typeof o.deleted_at !== 'string' ||
    !ISO.test(o.deleted_at) ||
    Number.isNaN(Date.parse(o.deleted_at)) ||
    typeof o.prev !== 'string' ||
    !HEX64.test(o.prev) ||
    typeof o.mac !== 'string' ||
    !HEX64.test(o.mac)
  ) {
    throw new RegistryError('malformed_record', `line ${String(lineNo)} has an invalid field`)
  }
  return o as unknown as RegistryRecord
}

export interface ParsedRegistry {
  records: readonly RegistryRecord[]
  head: RegistryHead
}

/**
 * Strict, fail-closed parse + integrity verification. Anything that is not exactly a valid chain
 * under `key` throws; nothing is skipped past. An EMPTY registry parses to zero records — whether
 * that is acceptable is the gate's decision, not the parser's.
 */
export function parseRegistry(text: string, key: Buffer): ParsedRegistry {
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new RegistryError(
      'torn_record',
      'the registry does not end with a newline (a torn write?)',
    )
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n')
  const records: RegistryRecord[] = []
  const ids = new Set<string>()
  const subjects = new Set<string>()
  let prev = GENESIS_PREV
  for (const [index, raw] of lines.entries()) {
    const n = index + 1
    const record = parseLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw, n)
    if (record.seq !== n) {
      throw new RegistryError('sequence_gap', `line ${String(n)}: sequence is not contiguous`)
    }
    if (record.prev !== prev) {
      throw new RegistryError('chain_broken', `line ${String(n)}: chain does not link`)
    }
    const { mac, ...rest } = record
    if (!constantTimeEqualHex(mac, macOf(key, rest))) {
      throw new RegistryError('mac_invalid', `line ${String(n)}: integrity check failed`)
    }
    if (ids.has(record.deletion_id)) {
      throw new RegistryError('duplicate_deletion_id', `line ${String(n)}: duplicate deletion id`)
    }
    if (subjects.has(record.subject)) {
      throw new RegistryError('duplicate_subject', `line ${String(n)}: duplicate subject`)
    }
    ids.add(record.deletion_id)
    subjects.add(record.subject)
    records.push(record)
    prev = record.mac
  }
  const last = records[records.length - 1]
  return {
    records,
    head: { seq: last?.seq ?? 0, mac: last?.mac ?? GENESIS_PREV, records: records.length },
  }
}

export function readRegistryFile(path: string, key: Buffer): ParsedRegistry {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new RegistryError('unreadable', 'the registry file could not be read')
  }
  return parseRegistry(text, key)
}

export interface AppendInput {
  deletion_id: string
  subject: string
  deleted_at: string
}

export interface AppendResult {
  record: RegistryRecord
  /** False when the same erasure was already recorded (idempotent replay). */
  created: boolean
}

/**
 * File-backed store: the reference implementation of the registry's write side. Every append
 * re-verifies the whole chain first (a few hundred bytes per erasure — cheap), writes one line and
 * fsyncs before returning, so an acknowledged record is on stable storage. Serialise callers
 * (the sink server does).
 */
export class RegistryStore {
  private readonly path: string
  private readonly key: Buffer

  constructor(path: string, key: Buffer) {
    this.path = path
    this.key = key
  }

  read(): ParsedRegistry {
    if (!existsSync(this.path)) return parseRegistry('', this.key)
    return readRegistryFile(this.path, this.key)
  }

  append(input: AppendInput): AppendResult {
    if (
      !UUID.test(input.deletion_id) ||
      !HEX64.test(input.subject) ||
      !ISO.test(input.deleted_at)
    ) {
      throw new RegistryError('malformed_record', 'invalid erasure record')
    }
    const parsed = this.read()
    const sameId = parsed.records.find((r) => r.deletion_id === input.deletion_id)
    if (sameId) {
      if (sameId.subject !== input.subject) {
        throw new RegistryError(
          'conflicting_record',
          'deletion id already recorded for another subject',
        )
      }
      return { record: sameId, created: false }
    }
    // The same subject under another deletion id: the erasure is already recorded. The registry's
    // own record is authoritative and is returned as-is (the caller adopts its deletion id).
    const sameSubject = parsed.records.find((r) => r.subject === input.subject)
    if (sameSubject) return { record: sameSubject, created: false }

    const base = {
      v: REGISTRY_SCHEMA_VERSION,
      seq: parsed.head.seq + 1,
      deletion_id: input.deletion_id,
      subject: input.subject,
      deleted_at: input.deleted_at,
      scope: ERASURE_SCOPE_VERSION,
      prev: parsed.head.mac,
    } as const
    const record = signRecord(this.key, base)
    const fd = openSync(this.path, 'a')
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return { record, created: true }
  }
}

/** The subset of a registry the database-side gate needs: nothing but ids, subjects and sequence. */
export function gatePayload(
  records: readonly RegistryRecord[],
): { deletion_id: string; subject: string; seq: number }[] {
  return records.map((r) => ({ deletion_id: r.deletion_id, subject: r.subject, seq: r.seq }))
}
