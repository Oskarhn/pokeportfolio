/**
 * Pure decision logic of the owner-operated deletion proof (P197B), kept free of I/O so the
 * dangerous parts - "is this really the right account / backup / target", "did the registry grow by
 * exactly the one record we expect", "did the restore drill prove what it must" - are unit-tested.
 *
 * Nothing here prints or returns a secret. Account ids are compared, never logged.
 */
import { createHash } from 'node:crypto'
import { hashAccountId, type RegistryRecord } from './erasure-registry'

export const PRODUCTION_PROJECT_REF = 'nopmkroeygmlvndzjjqs'
export const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`
export const PRODUCTION_REGISTRY_URL =
  'https://pokeportfolio-erasure-registry.oskarhn06.workers.dev'
export const PRODUCTION_FRONTEND_ORIGIN = 'https://pokeportfolio-dev.pages.dev'

/** The fingerprint `pnpm db:backup` stamps into a manifest for a linked project. */
export function backupFingerprintForRef(ref: string): string {
  return createHash('sha256').update(`linked:${ref}`).digest('hex').slice(0, 16)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export type TargetKind = 'production' | 'local-rehearsal'

export interface ResolvedTarget {
  kind: TargetKind
  supabaseUrl: string
  registryUrl: string
}

/**
 * Accepts exactly two shapes: the Production project with the Production registry, or a loopback
 * Supabase with a loopback registry (a rehearsal). A mix - e.g. Production Auth with a local
 * registry that would happily "record" a deletion nobody can ever replay - is refused.
 */
export function resolveTarget(supabaseUrl: string, registryUrl: string): ResolvedTarget {
  let supabase: URL
  let registry: URL
  try {
    supabase = new URL(supabaseUrl)
    registry = new URL(registryUrl)
  } catch {
    throw new Error('the Supabase URL and the registry URL must both be valid URLs')
  }
  if (supabase.origin === PRODUCTION_SUPABASE_URL && registry.origin === PRODUCTION_REGISTRY_URL) {
    return { kind: 'production', supabaseUrl: supabase.origin, registryUrl: registry.origin }
  }
  const localSupabase = supabase.protocol === 'http:' && LOCAL_HOSTS.has(supabase.hostname)
  const localRegistry = registry.protocol === 'http:' && LOCAL_HOSTS.has(registry.hostname)
  if (localSupabase && localRegistry) {
    return { kind: 'local-rehearsal', supabaseUrl: supabase.origin, registryUrl: registry.origin }
  }
  throw new Error(
    'refused: the targets must be the Production project + Production registry, or both loopback',
  )
}

export interface CopyTable {
  columns: string[]
  rows: Record<string, string>[]
}

/**
 * One COPY block of a pg_dump data file, rows keyed by column name. Handles CRLF files (the
 * Windows-written dumps end every line with \r\n, so the terminating `\.` must be matched after
 * stripping the carriage return) and quoted identifiers. Returns null when the table is absent.
 * `\N` is returned as the literal string `\N` (SQL NULL).
 */
export function readCopyTable(dataSql: string, qualified: string): CopyTable | null {
  const [schema, table] = qualified.split('.')
  const header = new RegExp(
    `^COPY "?${schema ?? ''}"?\\."?${table ?? ''}"? \\(([^)]*)\\) FROM stdin;$`,
  )
  const lines = dataSql.split(/\r?\n/)
  const start = lines.findIndex((l) => header.test(l))
  if (start < 0) return null
  const columns = [...(header.exec(lines[start] ?? '')?.[1] ?? '').matchAll(/"?([A-Za-z0-9_]+)"?/g)]
    .map((m) => m[1])
    .filter((c): c is string => c !== undefined)
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === '\\.') return { columns, rows }
    const fields = line.split('\t')
    rows.push(Object.fromEntries(columns.map((c, i) => [c, fields[i] ?? ''])))
  }
  throw new Error(`unterminated COPY block for ${qualified}`)
}

const NULL = '\\N'

export interface BackupAccountFacts {
  inAuthUsers: boolean
  profileIsAdmin: boolean | null
  profileCreatedAt: string | null
  liveOwnedPurchases: number
  liveOwnedLots: number
  /** Ids of every profile that is an administrator in this image (never to be deleted). */
  adminIds: string[]
}

export function inspectBackupAccount(dataSql: string, userId: string): BackupAccountFacts {
  const id = userId.toLowerCase()
  const users = readCopyTable(dataSql, 'auth.users')
  const profiles = readCopyTable(dataSql, 'public.profiles')
  const purchases = readCopyTable(dataSql, 'public.purchases')
  const lots = readCopyTable(dataSql, 'public.acquisition_lots')
  if (!users || !profiles || !purchases || !lots) {
    throw new Error('the backup lacks a table the proof needs (auth.users/profiles/purchases/lots)')
  }
  const profile = profiles.rows.find((r) => r.id?.toLowerCase() === id)
  const live = (r: Record<string, string>): boolean =>
    r.user_id?.toLowerCase() === id && (r.voided_at ?? NULL) === NULL
  return {
    inAuthUsers: users.rows.some((r) => r.id?.toLowerCase() === id),
    profileIsAdmin: profile ? profile.is_admin === 't' : null,
    profileCreatedAt: profile?.created_at ?? null,
    liveOwnedPurchases: purchases.rows.filter(live).length,
    liveOwnedLots: lots.rows.filter(live).length,
    adminIds: profiles.rows
      .filter((r) => r.is_admin === 't')
      .map((r) => (r.id ?? '').toLowerCase()),
  }
}

/** `2026-10-08 10:09:35.205497+00` (pg_dump timestamptz text) -> epoch ms, NaN if unreadable. */
export function parsePgTimestamp(text: string): number {
  const m =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      text.trim(),
    )
  if (!m) return Number.NaN
  const fraction = (m[3] ?? '').slice(0, 3).padEnd(3, '0')
  let zone = m[4] ?? 'Z'
  if (/^[+-]\d{2}$/.test(zone)) zone += ':00'
  else if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`
  return Date.parse(`${m[1] ?? ''}T${m[2] ?? ''}.${fraction}${zone}`)
}

/** Reasons the backup cannot serve as the pre-deletion image of this account (empty = fit). */
export function backupUnfitReasons(
  facts: BackupAccountFacts,
  userId: string,
  backupFinishedAtUtc: string,
): string[] {
  const reasons: string[] = []
  if (!facts.inAuthUsers) reasons.push('account is not in the backup auth.users')
  if (facts.profileIsAdmin === null) reasons.push('account has no profile row in the backup')
  if (facts.profileIsAdmin === true) reasons.push('account is an administrator in the backup')
  if (facts.adminIds.length === 0) reasons.push('the backup identifies no administrator at all')
  if (facts.adminIds.includes(userId.toLowerCase())) reasons.push('account is in the admin set')
  if (facts.liveOwnedPurchases < 1) reasons.push('no live purchase for the account in the backup')
  if (facts.liveOwnedLots < 1) reasons.push('no live lot for the account in the backup')
  const created = parsePgTimestamp(facts.profileCreatedAt ?? '')
  const finished = Date.parse(backupFinishedAtUtc)
  if (!(finished > created)) reasons.push('the backup finished before the account was created')
  return reasons
}

export interface ExtensionCheck {
  ok: boolean
  reason: string
  newRecordCount: number
}

function linesOf(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0)
}

/**
 * Whether `afterText` is `beforeText` plus exactly one new record naming `userId`'s subject, at the
 * head. Purely structural (the HMAC chain has already been verified by the registry parser): this is
 * the append-only property the proof relies on - nothing earlier was rewritten, and the single new
 * record is this erasure.
 */
export function registryExtendsByOne(
  beforeText: string,
  afterText: string,
  userId: string,
  now: Date,
  toleranceMs = 15 * 60_000,
): ExtensionCheck {
  const before = linesOf(beforeText)
  const after = linesOf(afterText)
  const added = after.length - before.length
  if (added !== 1)
    return { ok: false, reason: `registry grew by ${String(added)}`, newRecordCount: added }
  if (before.some((l, i) => after[i] !== l)) {
    return { ok: false, reason: 'an earlier registry record changed', newRecordCount: added }
  }
  let record: RegistryRecord
  try {
    record = JSON.parse(after[after.length - 1] ?? '') as RegistryRecord
  } catch {
    return { ok: false, reason: 'new registry record is unreadable', newRecordCount: added }
  }
  if (record.subject !== hashAccountId(userId)) {
    return { ok: false, reason: 'new record is not this account', newRecordCount: added }
  }
  const at = Date.parse(record.deleted_at)
  if (!Number.isFinite(at) || Math.abs(now.getTime() - at) > toleranceMs) {
    return { ok: false, reason: 'new record time is not current', newRecordCount: added }
  }
  return {
    ok: true,
    reason: 'one new record, this account, earlier records untouched',
    newRecordCount: 1,
  }
}

/** The one restore-drill check that is allowed to fail: documented in RESTORE_RUNBOOK.md section 7. */
export const KNOWN_DRILL_LIMITATION = /^POST_RESTORE_CRON_PRODUCTION_CALLS/

const REQUIRED_DRILL_PASSES: { label: string; prefix: string }[] = [
  { label: 'erasure machinery present', prefix: 'ERASURE_GATE machinery present' },
  { label: 'pre-deletion image contained the erased account', prefix: 'ERASURE_GATE hazard' },
  { label: 'replay removed the erased account', prefix: 'ERASURE_GATE apply' },
  { label: 'postcheck stamped passed', prefix: 'ERASURE_GATE postcheck' },
  { label: 'promote-check promotable', prefix: 'ERASURE_GATE promote-check' },
  { label: 'other accounts untouched', prefix: 'ERASURE_GATE untouched' },
]

export interface DrillVerdict {
  pass: boolean
  checksTotal: number
  checksFailed: number
  onlyKnownLimitationFailed: boolean
  replayedAccounts: number | null
  problems: string[]
}

/**
 * Judges a restore-drill log by CONTENT, not by exit code: the drill exits non-zero on the
 * documented cron limitation, and a zero exit alone would also accept a run where the replay
 * touched nothing. Passes only if the drill reached its summary line, every required erasure
 * check passed, the replay removed at least one account, and the only failed check (if any) is
 * the documented cron limitation.
 */
export function evaluateDrillLog(log: string): DrillVerdict {
  const problems: string[] = []
  const checks: { name: string; pass: boolean; detail: string }[] = []
  for (const raw of log.split(/\r?\n/)) {
    const m = /^(PASS|FAIL) {2}(.+?) — (.*)$/.exec(raw)
    if (m) checks.push({ name: m[2] ?? '', pass: m[1] === 'PASS', detail: m[3] ?? '' })
  }
  if (!/P137 RESTORE DRILL: (PASS|FAIL) /.test(log))
    problems.push('the drill did not reach its summary')
  const failed = checks.filter((c) => !c.pass)
  const unexpected = failed.filter((c) => !KNOWN_DRILL_LIMITATION.test(c.name))
  if (unexpected.length > 0)
    problems.push(`${String(unexpected.length)} unexpected failed check(s)`)
  for (const req of REQUIRED_DRILL_PASSES) {
    const found = checks.find((c) => c.name.startsWith(req.prefix))
    if (!found) problems.push(`missing check: ${req.label}`)
    else if (!found.pass) problems.push(`failed check: ${req.label}`)
  }
  const apply = checks.find((c) => c.name.startsWith('ERASURE_GATE apply'))
  const replayedText = /replayed=(\d+)/.exec(apply?.detail ?? '')?.[1]
  const replayedAccounts = replayedText === undefined ? null : Number(replayedText)
  if (replayedAccounts === null || replayedAccounts < 1) {
    problems.push('the replay removed no account')
  }
  if (!/verdict=clean/.test(apply?.detail ?? '')) problems.push('post-replay verdict is not clean')
  return {
    pass: problems.length === 0,
    checksTotal: checks.length,
    checksFailed: failed.length,
    onlyKnownLimitationFailed:
      failed.length > 0 && failed.every((c) => KNOWN_DRILL_LIMITATION.test(c.name)),
    replayedAccounts,
    problems,
  }
}

/**
 * A secret as typed or pasted by a person: whitespace, a `NAME=` / `export NAME=` / `$env:NAME=`
 * prefix copied from an env file, and one pair of surrounding quotes are not part of the value.
 */
export function cleanSecret(raw: string): string {
  let value = raw.trim()
  value = value.replace(/^(?:export\s+|\$env:)?[A-Z][A-Z0-9]*_[A-Z0-9_]*\s*=\s*/, '').trim()
  value = value.replace(/^(['"])(.*)\1$/, '$2').trim()
  return value
}

/** Why a typed operator token cannot be right before any network call is made (null = plausible). */
export function operatorTokenProblem(token: string, hmacKeyText: string): string | null {
  if (token.length < 24) return `it is too short (${String(token.length)} characters)`
  if (/\s/.test(token)) return 'it contains whitespace'
  if (token === hmacKeyText) {
    return 'it is identical to the HMAC key (the same value was entered at both prompts)'
  }
  return null
}

/**
 * What a registry refusal of the export means, in words that tell the operator which credential to
 * look for. The Worker answers 401 when the bearer matches neither the operator nor the append
 * token, and 403 when it matches the append token (which may not read).
 */
export function explainExportRefusal(message: string): string | null {
  if (message.includes('(401)')) {
    return (
      'the registry accepts this value as neither the operator token nor the append token (401). ' +
      "Use the PRODUCTION entry's ERASURE_OPERATOR_TOKEN - not the test registry's, not the append token, " +
      'not the HMAC key - or rotate the operator token'
    )
  }
  if (message.includes('(403)')) {
    return 'this is the APPEND token (403): the operator token is a different value'
  }
  return null
}
