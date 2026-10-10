import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  backupFingerprintForRef,
  backupUnfitReasons,
  cleanSecret,
  describeInterruption,
  evaluateDrillLog,
  explainExportRefusal,
  inspectBackupAccount,
  matchesTestRegistryCredential,
  operatorTokenProblem,
  parsePgTimestamp,
  PRODUCTION_PROJECT_REF,
  PRODUCTION_REGISTRY_URL,
  PRODUCTION_SUPABASE_URL,
  readCopyTable,
  registryExtendsByOne,
  resolveTarget,
} from '../../scripts/restore-gate/deletion-proof-core'
import {
  hashAccountId,
  parseRegistryKey,
  RegistryStore,
} from '../../scripts/restore-gate/erasure-registry'

/**
 * P197B: the decision logic of the owner-operated deletion proof. Synthetic ids only.
 */

const SYNTH = '5a5a5a5a-1111-4222-8333-444444444444'
const ADMIN = '6b6b6b6b-2222-4333-8444-555555555555'
const KEY = parseRegistryKey('0123456789abcdef'.repeat(4))

/** A pg_dump-shaped data file with CRLF line endings, like the ones written on Windows. */
function dump(
  opts: { synthAdmin?: boolean; synthPurchase?: boolean; synthLot?: boolean } = {},
): string {
  const lines = [
    '-- header',
    'COPY "auth"."users" ("instance_id", "id", "email") FROM stdin;',
    `0000\t${ADMIN}\tadmin@example.test`,
    `0000\t${SYNTH}\tsynthetic@example.test`,
    '\\.',
    '',
    'COPY "public"."profiles" ("id", "display_name", "is_admin", "created_at") FROM stdin;',
    `${ADMIN}\tA\tt\t2026-08-20 17:39:45+00`,
    `${SYNTH}\tS\t${opts.synthAdmin ? 't' : 'f'}\t2026-10-08 10:09:35+00`,
    '\\.',
    '',
    'COPY "public"."purchases" ("id", "user_id", "voided_at") FROM stdin;',
    `p1\t${ADMIN}\t\\N`,
    ...(opts.synthPurchase === false ? [] : [`p2\t${SYNTH}\t\\N`]),
    `p3\t${SYNTH}\t2026-10-08 11:00:00+00`,
    '\\.',
    '',
    'COPY "public"."acquisition_lots" ("id", "user_id", "voided_at") FROM stdin;',
    `l1\t${ADMIN}\t\\N`,
    ...(opts.synthLot === false ? [] : [`l2\t${SYNTH}\t\\N`]),
    '\\.',
    '-- end',
  ]
  return lines.join('\r\n') + '\r\n'
}

describe('resolveTarget', () => {
  it('accepts Production Auth with the Production registry', () => {
    expect(resolveTarget(PRODUCTION_SUPABASE_URL, PRODUCTION_REGISTRY_URL).kind).toBe('production')
  })
  it('accepts a loopback rehearsal only when both ends are loopback', () => {
    expect(resolveTarget('http://127.0.0.1:54321', 'http://127.0.0.1:8787').kind).toBe(
      'local-rehearsal',
    )
  })
  it('refuses Production Auth with a local registry (a deletion nobody could replay)', () => {
    expect(() => resolveTarget(PRODUCTION_SUPABASE_URL, 'http://127.0.0.1:8787')).toThrow()
  })
  it('refuses another hosted project, another worker and a lookalike host', () => {
    expect(() =>
      resolveTarget('https://aaaaaaaaaaaaaaaaaaaa.supabase.co', PRODUCTION_REGISTRY_URL),
    ).toThrow()
    expect(() =>
      resolveTarget(PRODUCTION_SUPABASE_URL, 'https://other.oskarhn06.workers.dev'),
    ).toThrow()
    expect(() =>
      resolveTarget(
        `https://${PRODUCTION_PROJECT_REF}.supabase.co.evil.test`,
        PRODUCTION_REGISTRY_URL,
      ),
    ).toThrow()
  })
  it('refuses plain http for a non-loopback host and garbage', () => {
    expect(() => resolveTarget('http://example.test', 'http://example.test')).toThrow()
    expect(() => resolveTarget('not a url', PRODUCTION_REGISTRY_URL)).toThrow()
  })
})

describe('parsePgTimestamp', () => {
  it('reads pg_dump timestamptz text including microseconds and short offsets', () => {
    expect(parsePgTimestamp('2026-10-08 10:09:35.205497+00')).toBe(
      Date.parse('2026-10-08T10:09:35.205Z'),
    )
    expect(parsePgTimestamp('2026-10-08 12:09:35+02')).toBe(Date.parse('2026-10-08T10:09:35Z'))
    expect(parsePgTimestamp('2026-10-08T10:09:35Z')).toBe(Date.parse('2026-10-08T10:09:35Z'))
  })
  it('is NaN for garbage, which makes the backup unfit rather than fit', () => {
    expect(parsePgTimestamp('yesterday')).toBeNaN()
    const facts = inspectBackupAccount(dump(), SYNTH)
    expect(
      backupUnfitReasons(
        { ...facts, profileCreatedAt: 'yesterday' },
        SYNTH,
        '2026-10-08T10:27:54Z',
      ),
    ).toContain('the backup finished before the account was created')
  })
})

describe('backup fingerprint', () => {
  it('matches the one the real Production backup carries', () => {
    expect(backupFingerprintForRef(PRODUCTION_PROJECT_REF)).toBe('31ac1436b3dc6bd0')
  })
})

describe('readCopyTable / inspectBackupAccount (CRLF dump)', () => {
  it('stops at the terminator even with carriage returns and keys rows by column name', () => {
    const t = readCopyTable(dump(), 'public.profiles')
    expect(t?.rows).toHaveLength(2)
    expect(t?.rows[1]).toMatchObject({ id: SYNTH, is_admin: 'f' })
  })
  it('returns null for a missing table and throws on a truncated block', () => {
    expect(readCopyTable(dump(), 'public.nope')).toBeNull()
    expect(() =>
      readCopyTable('COPY "public"."profiles" ("id") FROM stdin;\r\nx\r\n', 'public.profiles'),
    ).toThrow()
  })
  it('finds the account, its non-admin profile and only its LIVE holdings', () => {
    const facts = inspectBackupAccount(dump(), SYNTH)
    expect(facts).toMatchObject({
      inAuthUsers: true,
      profileIsAdmin: false,
      liveOwnedPurchases: 1, // the voided purchase does not count
      liveOwnedLots: 1,
      adminIds: [ADMIN],
    })
    expect(backupUnfitReasons(facts, SYNTH, '2026-10-08T10:27:54.090Z')).toEqual([])
  })
  it('rejects a backup that is unfit: admin target, no holdings, taken before creation', () => {
    const admin = inspectBackupAccount(dump({ synthAdmin: true }), SYNTH)
    expect(backupUnfitReasons(admin, SYNTH, '2026-10-08T10:27:54Z').length).toBeGreaterThan(0)
    const empty = inspectBackupAccount(dump({ synthPurchase: false, synthLot: false }), SYNTH)
    expect(backupUnfitReasons(empty, SYNTH, '2026-10-08T10:27:54Z')).toEqual(
      expect.arrayContaining([
        'no live purchase for the account in the backup',
        'no live lot for the account in the backup',
      ]),
    )
    const early = inspectBackupAccount(dump(), SYNTH)
    expect(backupUnfitReasons(early, SYNTH, '2026-10-07T00:00:00Z')).toContain(
      'the backup finished before the account was created',
    )
    const other = inspectBackupAccount(dump(), '99999999-9999-4999-8999-999999999999')
    expect(
      backupUnfitReasons(other, '99999999-9999-4999-8999-999999999999', '2026-10-08T10:27:54Z'),
    ).toContain('account is not in the backup auth.users')
  })
})

describe('registryExtendsByOne', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'p197b-core-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const NOW = new Date('2026-10-08T12:00:00Z')
  const D = (n: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
  function store(): RegistryStore {
    return new RegistryStore(join(dir, 'r.ndjson'), KEY)
  }
  function text(s: RegistryStore): string {
    return (
      s
        .read()
        .records.map((r) => JSON.stringify(r))
        .join('\n') + (s.read().records.length ? '\n' : '')
    )
  }

  it('accepts exactly one new head record for this account', () => {
    const s = store()
    s.append({
      deletion_id: D(1),
      subject: hashAccountId('7c7c7c7c-3333-4444-8555-666666666666'),
      deleted_at: '2026-10-01T00:00:00Z',
    })
    const before = text(s)
    s.append({
      deletion_id: D(2),
      subject: hashAccountId(SYNTH),
      deleted_at: '2026-10-08T11:59:00Z',
    })
    expect(registryExtendsByOne(before, text(s), SYNTH, NOW)).toMatchObject({ ok: true })
  })
  it('refuses no growth, double growth, another subject and a stale timestamp', () => {
    const s = store()
    s.append({
      deletion_id: D(1),
      subject: hashAccountId(SYNTH),
      deleted_at: '2026-10-08T11:59:00Z',
    })
    const one = text(s)
    expect(registryExtendsByOne(one, one, SYNTH, NOW).ok).toBe(false)
    expect(registryExtendsByOne('', one, ADMIN, NOW)).toMatchObject({
      ok: false,
      reason: 'new record is not this account',
    })
    s.append({
      deletion_id: D(2),
      subject: hashAccountId(ADMIN),
      deleted_at: '2026-10-08T11:59:30Z',
    })
    expect(registryExtendsByOne('', text(s), SYNTH, NOW).ok).toBe(false)
    expect(registryExtendsByOne('', one, SYNTH, new Date('2026-10-09T00:00:00Z'))).toMatchObject({
      ok: false,
      reason: 'new record time is not current',
    })
  })
  it('refuses a registry whose earlier record was rewritten', () => {
    const s = store()
    s.append({
      deletion_id: D(1),
      subject: hashAccountId(ADMIN),
      deleted_at: '2026-10-01T00:00:00Z',
    })
    const before = text(s)
    s.append({
      deletion_id: D(2),
      subject: hashAccountId(SYNTH),
      deleted_at: '2026-10-08T11:59:00Z',
    })
    const tampered = text(s).replace(D(1), D(9))
    expect(registryExtendsByOne(before, tampered, SYNTH, NOW)).toMatchObject({
      ok: false,
      reason: 'an earlier registry record changed',
    })
  })
})

describe('evaluateDrillLog', () => {
  const good = [
    'PASS  BACKUP_VERIFIED — ok',
    'PASS  ERASURE_GATE machinery present in the restored image (rolled forward) — ok',
    'PASS  ERASURE_GATE hazard: the restored image still held the erased account(s) before replay — present=1',
    'PASS  ERASURE_GATE apply: erased accounts replayed onto the restored image and re-verified clean — replayed=1 verdict=clean tables_with_residue={}',
    'PASS  ERASURE_GATE postcheck: image stamped passed for the current registry head — verdict=clean',
    'PASS  ERASURE_GATE promote-check: PROMOTABLE (the only state in which this image may serve) — promotable',
    'PASS  ERASURE_GATE untouched: every other account and its holdings are unchanged by the replay — kept=1',
  ]
  const cron =
    'FAIL  POST_RESTORE_CRON_PRODUCTION_CALLS: non-Production restore target ends with zero configured ingest base URLs — 2 jobs'

  it('passes when everything passes', () => {
    const v = evaluateDrillLog([...good, '', 'P137 RESTORE DRILL: PASS (7 checks)'].join('\n'))
    expect(v).toMatchObject({ pass: true, replayedAccounts: 1, onlyKnownLimitationFailed: false })
  })
  it('accepts the documented cron limitation as the ONLY failure', () => {
    const v = evaluateDrillLog([...good, cron, 'P137 RESTORE DRILL: FAIL (1 of 8)'].join('\r\n'))
    expect(v).toMatchObject({ pass: true, onlyKnownLimitationFailed: true, checksFailed: 1 })
  })
  it('refuses any other failed check, even alongside the cron limitation', () => {
    const bad = good.map((l) => (l.includes('postcheck') ? l.replace('PASS', 'FAIL') : l))
    const v = evaluateDrillLog([...bad, cron, 'P137 RESTORE DRILL: FAIL (2 of 8)'].join('\n'))
    expect(v.pass).toBe(false)
    expect(v.problems.join()).toContain('postcheck')
  })
  it('refuses a replay that removed nothing, a missing required check and a crashed drill', () => {
    const none = good.map((l) => l.replace('replayed=1', 'replayed=0'))
    expect(evaluateDrillLog([...none, 'P137 RESTORE DRILL: PASS (7 checks)'].join('\n')).pass).toBe(
      false,
    )
    const missing = good.filter((l) => !l.includes('promote-check'))
    expect(
      evaluateDrillLog([...missing, 'P137 RESTORE DRILL: PASS (6 checks)'].join('\n')).pass,
    ).toBe(false)
    expect(evaluateDrillLog([...good, 'P137 RESTORE DRILL: ERROR — boom'].join('\n')).pass).toBe(
      false,
    )
    expect(evaluateDrillLog(good.join('\n')).pass).toBe(false)
  })
  it('does not treat an unrelated failure as the cron limitation', () => {
    const v = evaluateDrillLog(
      [...good, 'FAIL  APP_COMPATIBILITY: RLS — x', 'P137 RESTORE DRILL: FAIL (1 of 8)'].join('\n'),
    )
    expect(v.pass).toBe(false)
    expect(v.onlyKnownLimitationFailed).toBe(false)
  })
})

describe('secret hygiene', () => {
  it('cleans copy-paste decoration without touching the value', () => {
    const v = 'a'.repeat(48)
    expect(cleanSecret(`  ${v}  `)).toBe(v)
    expect(cleanSecret(`ERASURE_OPERATOR_TOKEN=${v}`)).toBe(v)
    expect(cleanSecret(`export ERASURE_OPERATOR_TOKEN="${v}"`)).toBe(v)
    expect(cleanSecret(`$env:ERASURE_OPERATOR_TOKEN='${v}'`)).toBe(v)
    expect(cleanSecret(`${v}==`)).toBe(`${v}==`) // base64 padding survives
  })
  it('rejects implausible operator tokens before any network call', () => {
    const key = 'ab'.repeat(32)
    expect(operatorTokenProblem('short', key)).toContain('too short')
    expect(operatorTokenProblem(`${'a'.repeat(30)} ${'b'.repeat(30)}`, key)).toContain('whitespace')
    expect(operatorTokenProblem(key, key)).toContain('identical to the HMAC key')
    expect(operatorTokenProblem('c'.repeat(48), key)).toBeNull()
  })
  it('tells 401 (neither token) from 403 (append token)', () => {
    expect(explainExportRefusal('the registry refused the export (401)')).toContain('neither')
    expect(explainExportRefusal('the registry refused the export (403)')).toContain('APPEND')
    expect(explainExportRefusal('the registry is unreachable')).toBeNull()
  })
})

describe('test-registry guard', () => {
  const testEnv = [
    `ERASURE_REGISTRY_KEY=${'1a'.repeat(32)}`,
    `ERASURE_APPEND_TOKEN=${'b'.repeat(48)}`,
    `ERASURE_OPERATOR_TOKEN=${'c'.repeat(48)}`,
  ].join('\r\n')
  it('recognises the test registry credentials, never anything else', () => {
    const prodKey = '2b'.repeat(32)
    expect(matchesTestRegistryCredential('d'.repeat(48), prodKey, testEnv)).toBeNull()
    expect(matchesTestRegistryCredential('c'.repeat(48), prodKey, testEnv)).toBe('operator token')
    expect(matchesTestRegistryCredential('b'.repeat(48), prodKey, testEnv)).toBe('operator token')
    expect(matchesTestRegistryCredential('d'.repeat(48), '1A'.repeat(32), testEnv)).toBe('HMAC key')
    expect(matchesTestRegistryCredential('1a'.repeat(32), prodKey, testEnv)).toBe('operator token')
  })
  it('does not match on an empty or malformed file', () => {
    expect(matchesTestRegistryCredential('c'.repeat(48), '2b'.repeat(32), '')).toBeNull()
    expect(matchesTestRegistryCredential('c'.repeat(48), '2b'.repeat(32), 'garbage')).toBeNull()
  })
})

describe('interruption report (Ctrl+C / termination signal)', () => {
  const sent = { requestSent: true, requestAnswered: false, deleted: false }

  it('before the request is sent: states that nothing changed and that re-running is safe', () => {
    const report = describeInterruption({
      requestSent: false,
      requestAnswered: false,
      deleted: false,
    })
    expect(report.phase).toBe('before-send')
    expect(report.exitCode).toBe(130)
    const text = report.lines.join('\n')
    expect(text).toContain('BEFORE THE DELETION REQUEST WAS SENT')
    expect(text).toContain('safe to start the tool again')
    expect(text).not.toMatch(/DO NOT RUN/)
  })

  it('after the request is sent without an answer: ambiguous, never advises a re-run', () => {
    const report = describeInterruption(sent)
    expect(report.phase).toBe('outcome-unknown')
    const text = report.lines.join('\n')
    expect(text).toContain('OUTCOME IS UNKNOWN')
    expect(text).toContain('DO NOT RUN THIS TOOL AGAIN')
    expect(text).not.toMatch(/safe to start/i)
    expect(text).not.toMatch(/nothing was changed/i)
  })

  it('after an answer: never claims nothing happened, distinguishes deleted from not deleted', () => {
    const deleted = describeInterruption({ ...sent, requestAnswered: true, deleted: true })
    const refused = describeInterruption({ ...sent, requestAnswered: true, deleted: false })
    expect(deleted.phase).toBe('after-answer')
    expect(deleted.lines.join('\n')).toContain('ANSWERED AS DELETED')
    expect(refused.lines.join('\n')).toContain('NOT AS DELETED')
    for (const r of [deleted, refused])
      expect(r.lines.join('\n')).toContain('DO NOT RUN THIS TOOL AGAIN')
  })

  it('the two cancellation outcomes are never worded alike', () => {
    const before = describeInterruption({
      requestSent: false,
      requestAnswered: false,
      deleted: false,
    })
    const after = describeInterruption(sent)
    expect(before.lines.join('\n')).not.toBe(after.lines.join('\n'))
    expect(before.phase).not.toBe(after.phase)
  })

  it('emits fixed text only: nothing derived from a secret, id or response can appear', () => {
    for (const facts of [
      { requestSent: false, requestAnswered: false, deleted: false },
      sent,
      { ...sent, requestAnswered: true, deleted: true },
    ]) {
      const text = describeInterruption(facts).lines.join('\n')
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
      expect(text).not.toMatch(/https?:\/\//)
      expect(text).not.toMatch(/Bearer|token=|password/i)
    }
  })
})

describe('the tool marks the request answered only when the answer is whole', () => {
  // How the signals reach describeInterruption is covered in deletion-proof-interruption.test.ts.
  const source = readFileSync(
    join(import.meta.dirname, '../../scripts/restore-gate/owner-deletion-proof.ts'),
    'utf8',
  )
  it('marks the request answered only once the response body was read', () => {
    expect(source).toMatch(/state.requestAnswered = requestCompleted/)
  })
})
