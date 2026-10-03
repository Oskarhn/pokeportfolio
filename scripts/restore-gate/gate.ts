/**
 * The restore promotion gate (P189): orchestration around the database-side functions in
 * supabase/migrations/20261002130000_p189_restore_safe_erasure.sql.
 *
 *   restore isolated → verify registry → replay erasures → postcheck → promote-check → promote
 *
 * A restored database that has not passed `postcheck` AND `promote-check` is NOT SAFE TO SERVE.
 *
 * Everything that touches data runs inside the database (so the same code path serves a pg
 * connection and the docker-exec psql runner the restore drill uses); this module validates what
 * goes in (only hex hashes, UUIDs and integers ever reach SQL, and they are validated before they
 * are inlined), interprets what comes out, and maps every outcome to an exit code. Nothing here
 * prints an account id, an address, a token or a row: counts and relation names only.
 */
import { gatePayload, type ParsedRegistry } from './erasure-registry'

/** Exit codes. 0 is the only value that permits promotion. */
export const EXIT = {
  OK: 0,
  /** An erased account is present in the image (verify) or replay did not converge (apply). */
  RESURRECTED: 1,
  /** Registry missing, empty, malformed, wrongly keyed or failed integrity. */
  REGISTRY_REFUSED: 2,
  /** The image lacks the deletion / gate machinery: roll migrations forward first. */
  NO_MACHINERY: 3,
  /** The database could not be read. */
  DB_UNREADABLE: 4,
  /** The registry and the image disagree about what has been erased (stale or foreign registry). */
  REGISTRY_INCONSISTENT: 5,
  /** promote-check: no passing stamp, or the stamp does not cover the current registry. */
  NOT_PROMOTABLE: 6,
  USAGE: 64,
} as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** Runs one SQL statement and returns its single `r` (jsonb) column, parsed. */
export interface SqlRunner {
  json(sql: string): Promise<unknown>
}

const HEX64 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A jsonb literal for the validated gate payload. Only [0-9a-f-{}[]",: ] and digits can occur. */
function registryLiteral(registry: ParsedRegistry): string {
  const payload = gatePayload(registry.records)
  for (const e of payload) {
    if (!UUID.test(e.deletion_id) || !HEX64.test(e.subject) || !Number.isSafeInteger(e.seq)) {
      throw new Error('registry payload failed validation')
    }
  }
  return `'${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb`
}

export interface Machinery {
  present: boolean
  missing: string[]
}

export async function checkMachinery(db: SqlRunner): Promise<Machinery> {
  const r = (await db.json(`select jsonb_build_object(
      'tables', jsonb_build_array(
        to_regclass('public.account_deletion_requests') is not null,
        to_regclass('public.account_erasure_receipts') is not null,
        to_regclass('public.restore_gate_runs') is not null),
      'functions', jsonb_build_array(
        to_regprocedure('public.erasure_subject_hash(uuid)') is not null,
        to_regprocedure('public.restore_gate_scan(text[])') is not null,
        to_regprocedure('public.restore_gate_check(jsonb,bigint)') is not null,
        to_regprocedure('public.restore_gate_apply(jsonb,boolean)') is not null,
        to_regprocedure('public.restore_gate_postcheck(jsonb,bigint,text,integer)') is not null,
        to_regprocedure('public.purge_account_data(uuid,integer)') is not null),
      'barriers', (select count(*) from pg_trigger where tgname = 'account_deletion_barrier')
    ) as r`)) as { tables: boolean[]; functions: boolean[]; barriers: number }
  const missing: string[] = []
  const tableNames = ['account_deletion_requests', 'account_erasure_receipts', 'restore_gate_runs']
  const fnNames = [
    'erasure_subject_hash',
    'restore_gate_scan',
    'restore_gate_check',
    'restore_gate_apply',
    'restore_gate_postcheck',
    'purge_account_data',
  ]
  r.tables.forEach((ok, i) => {
    if (!ok) missing.push(`table ${tableNames[i] ?? '?'}`)
  })
  r.functions.forEach((ok, i) => {
    if (!ok) missing.push(`function ${fnNames[i] ?? '?'}`)
  })
  if (r.barriers === 0) missing.push('write barrier triggers')
  return { present: missing.length === 0, missing }
}

export interface CheckReport {
  present_accounts: number
  orphan_accounts: number
  tables: Record<string, number>
  receipts_unknown_to_registry: number
  receipts_contradicting_registry: number
  max_receipt_seq: number
  registry_older_than_image: boolean
}

export type Verdict =
  'clean' | 'resurrected' | 'registry_inconsistent' | 'registry_empty' | 'head_behind_expected'

export interface VerifyOutcome {
  verdict: Verdict
  exit: ExitCode
  report: CheckReport
  registry: { records: number; head_seq: number }
}

export interface VerifyOptions {
  allowEmpty: boolean
  /** Operator-pinned minimum head: a registry shorter than this is refused. */
  expectHeadSeq?: number
}

export async function verify(
  db: SqlRunner,
  registry: ParsedRegistry,
  options: VerifyOptions,
): Promise<VerifyOutcome> {
  const report = (await db.json(
    `select public.restore_gate_check(${registryLiteral(registry)}, ${String(registry.head.seq)}) as r`,
  )) as CheckReport
  const registrySummary = { records: registry.head.records, head_seq: registry.head.seq }
  const out = (verdict: Verdict, exit: ExitCode): VerifyOutcome => ({
    verdict,
    exit,
    report,
    registry: registrySummary,
  })

  if (registry.head.records === 0 && !options.allowEmpty)
    return out('registry_empty', EXIT.REGISTRY_REFUSED)
  if (options.expectHeadSeq !== undefined && registry.head.seq < options.expectHeadSeq) {
    return out('head_behind_expected', EXIT.REGISTRY_INCONSISTENT)
  }
  if (
    report.registry_older_than_image ||
    report.receipts_unknown_to_registry > 0 ||
    report.receipts_contradicting_registry > 0
  ) {
    return out('registry_inconsistent', EXIT.REGISTRY_INCONSISTENT)
  }
  if (report.present_accounts > 0 || report.orphan_accounts > 0)
    return out('resurrected', EXIT.RESURRECTED)
  return out('clean', EXIT.OK)
}

export interface ApplyOutcome {
  exit: ExitCode
  replayed_accounts: number
  dry_run: boolean
  after: VerifyOutcome | null
}

/**
 * Replays the registry onto the image. With dryRun nothing is written and the outcome reports what
 * a real run would replay. A real run is followed by a verify; apply only succeeds if that verify is
 * clean, so "applied" never means "attempted".
 */
export async function apply(
  db: SqlRunner,
  registry: ParsedRegistry,
  options: VerifyOptions & { dryRun: boolean },
): Promise<ApplyOutcome> {
  const result = (await db.json(
    `select public.restore_gate_apply(${registryLiteral(registry)}, ${options.dryRun ? 'true' : 'false'}) as r`,
  )) as { replayed_accounts: number; dry_run: boolean }
  if (options.dryRun) {
    return {
      exit: EXIT.OK,
      replayed_accounts: result.replayed_accounts,
      dry_run: true,
      after: null,
    }
  }
  const after = await verify(db, registry, options)
  return {
    exit: after.exit,
    replayed_accounts: result.replayed_accounts,
    dry_run: false,
    after,
  }
}

export interface PostcheckOutcome {
  exit: ExitCode
  verify: VerifyOutcome
  stamped: boolean
}

/** Verifies and, only if clean, writes the passing stamp. A failing check stamps `failed`. */
export async function postcheck(
  db: SqlRunner,
  registry: ParsedRegistry,
  options: VerifyOptions,
): Promise<PostcheckOutcome> {
  const v = await verify(db, registry, options)
  const stamp = (await db.json(
    `select public.restore_gate_postcheck(${registryLiteral(registry)}, ${String(registry.head.seq)}, '${registry.head.mac}', ${String(registry.head.records)}) as r`,
  )) as { status: 'passed' | 'failed' }
  // The verdict from verify() is authoritative; the stamp must agree with it or something is wrong.
  const stamped = stamp.status === 'passed'
  if (v.exit === EXIT.OK && !stamped)
    return { exit: EXIT.REGISTRY_INCONSISTENT, verify: v, stamped }
  return { exit: v.exit, verify: v, stamped }
}

export interface PromoteOutcome {
  exit: ExitCode
  reason: 'promotable' | 'no_passing_stamp' | 'stamp_does_not_cover_registry' | 'verify_failed'
  verify: VerifyOutcome | null
}

/**
 * The preflight to run immediately before pointing anything at a restored database. It does not
 * trust a stamp: it requires a passing stamp for THIS registry head and then verifies again.
 */
export async function promoteCheck(
  db: SqlRunner,
  registry: ParsedRegistry,
  options: VerifyOptions,
): Promise<PromoteOutcome> {
  const last = (await db.json(
    `select coalesce((select to_jsonb(s) from (
        select status, registry_head_seq, registry_head_mac
          from public.restore_gate_runs order by id desc limit 1) s), 'null'::jsonb) as r`,
  )) as { status: string; registry_head_seq: number; registry_head_mac: string } | null
  if (last === null || last.status !== 'passed') {
    return { exit: EXIT.NOT_PROMOTABLE, reason: 'no_passing_stamp', verify: null }
  }
  if (
    last.registry_head_seq !== registry.head.seq ||
    last.registry_head_mac !== registry.head.mac
  ) {
    return { exit: EXIT.NOT_PROMOTABLE, reason: 'stamp_does_not_cover_registry', verify: null }
  }
  const v = await verify(db, registry, options)
  if (v.exit !== EXIT.OK) return { exit: v.exit, reason: 'verify_failed', verify: v }
  return { exit: EXIT.OK, reason: 'promotable', verify: v }
}
