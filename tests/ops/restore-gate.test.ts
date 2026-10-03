import { describe, expect, it } from 'vitest'
import {
  hashAccountId,
  RegistryStore,
  parseRegistryKey,
} from '../../scripts/restore-gate/erasure-registry'
import {
  apply,
  checkMachinery,
  EXIT,
  postcheck,
  promoteCheck,
  verify,
  type CheckReport,
  type SqlRunner,
} from '../../scripts/restore-gate/gate'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * P189: the gate's DECISIONS, with the database replaced by a scripted runner. What the SQL actually
 * does to a real restored image is proven in tests/db/p189_restore_safe_erasure.test.ts; this file
 * pins the mapping from "what the image reports" to exit codes and the promote-check rules, including
 * that a stamp alone never authorises promotion.
 */

const KEY = parseRegistryKey('0123456789abcdef'.repeat(4))
const CLEAN: CheckReport = {
  present_accounts: 0,
  orphan_accounts: 0,
  tables: {},
  receipts_unknown_to_registry: 0,
  receipts_contradicting_registry: 0,
  max_receipt_seq: 0,
  registry_older_than_image: false,
}

function registryOf(n: number) {
  const dir = mkdtempSync(join(tmpdir(), 'p189-gate-'))
  try {
    const store = new RegistryStore(join(dir, 'r.ndjson'), KEY)
    for (let i = 1; i <= n; i += 1) {
      store.append({
        deletion_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        subject: hashAccountId(`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`),
        deleted_at: '2026-10-02T10:00:00Z',
      })
    }
    return store.read()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A runner answering by what the statement is for. */
function runner(answers: {
  check?: Partial<CheckReport>
  apply?: { replayed_accounts: number; dry_run: boolean }
  stamp?: 'passed' | 'failed'
  last?: { status: string; registry_head_seq: number; registry_head_mac: string } | null
}): SqlRunner & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    json(text) {
      sql.push(text)
      if (text.includes('restore_gate_check'))
        return Promise.resolve({ ...CLEAN, ...answers.check })
      if (text.includes('restore_gate_apply'))
        return Promise.resolve(answers.apply ?? { replayed_accounts: 0, dry_run: false })
      if (text.includes('restore_gate_postcheck'))
        return Promise.resolve({ status: answers.stamp ?? 'passed' })
      if (text.includes('restore_gate_runs')) return Promise.resolve(answers.last ?? null)
      return Promise.resolve({
        tables: [true, true, true],
        functions: [true, true, true, true, true, true],
        barriers: 3,
      })
    },
  }
}

describe('verify', () => {
  it('a clean image with a non-empty registry is OK', async () => {
    const v = await verify(runner({}), registryOf(2), { allowEmpty: false })
    expect(v).toMatchObject({ verdict: 'clean', exit: EXIT.OK })
  })
  it('an erased account present in the image is 1, whatever else is true', async () => {
    const v = await verify(
      runner({ check: { present_accounts: 1, tables: { 'auth.users': 1 } } }),
      registryOf(2),
      { allowEmpty: false },
    )
    expect(v).toMatchObject({ verdict: 'resurrected', exit: EXIT.RESURRECTED })
  })
  it('an orphan (an erased id in an owner column with no login) is also refused', async () => {
    const v = await verify(runner({ check: { orphan_accounts: 1 } }), registryOf(1), {
      allowEmpty: false,
    })
    expect(v.exit).toBe(EXIT.RESURRECTED)
  })
  it('an empty registry is refused unless allowed on purpose', async () => {
    expect((await verify(runner({}), registryOf(0), { allowEmpty: false })).exit).toBe(
      EXIT.REGISTRY_REFUSED,
    )
    expect((await verify(runner({}), registryOf(0), { allowEmpty: true })).exit).toBe(EXIT.OK)
  })
  it('a registry older than the image, or contradicting its receipts, is 5', async () => {
    for (const check of [
      { registry_older_than_image: true },
      { receipts_unknown_to_registry: 1 },
      { receipts_contradicting_registry: 1 },
    ]) {
      expect((await verify(runner({ check }), registryOf(2), { allowEmpty: false })).exit).toBe(
        EXIT.REGISTRY_INCONSISTENT,
      )
    }
  })
  it('a registry shorter than the operator-pinned head is 5', async () => {
    const v = await verify(runner({}), registryOf(2), { allowEmpty: false, expectHeadSeq: 3 })
    expect(v).toMatchObject({ verdict: 'head_behind_expected', exit: EXIT.REGISTRY_INCONSISTENT })
  })
  it('only hex hashes, UUIDs and integers ever reach the SQL text', async () => {
    const r = runner({})
    await verify(r, registryOf(2), { allowEmpty: false })
    const text = r.sql.join('\n')
    expect(text).toMatch(
      /restore_gate_check\('\[\{"deletion_id":"[0-9a-f-]{36}","subject":"[0-9a-f]{64}","seq":1\}/,
    )
    expect(text).not.toContain('10000000-0000-4000-8000-000000000001') // the raw account id is never present
  })
})

describe('apply', () => {
  it('a dry run reports and does not verify or write', async () => {
    const r = runner({ apply: { replayed_accounts: 2, dry_run: true } })
    const out = await apply(r, registryOf(2), { allowEmpty: false, dryRun: true })
    expect(out).toMatchObject({ exit: EXIT.OK, replayed_accounts: 2, dry_run: true, after: null })
    expect(r.sql.some((s) => s.includes('restore_gate_check'))).toBe(false)
    expect(r.sql.some((s) => s.includes(', true)'))).toBe(true)
  })
  it('a real run only succeeds if the re-verification is clean ("applied" never means "attempted")', async () => {
    const bad = runner({
      apply: { replayed_accounts: 1, dry_run: false },
      check: { present_accounts: 1 },
    })
    expect((await apply(bad, registryOf(1), { allowEmpty: false, dryRun: false })).exit).toBe(
      EXIT.RESURRECTED,
    )
    const good = runner({ apply: { replayed_accounts: 1, dry_run: false } })
    expect((await apply(good, registryOf(1), { allowEmpty: false, dryRun: false })).exit).toBe(
      EXIT.OK,
    )
  })
})

describe('postcheck and promote-check', () => {
  it('postcheck stamps only a clean image, and a disagreement between verify and the stamp is not OK', async () => {
    expect((await postcheck(runner({}), registryOf(2), { allowEmpty: false })).exit).toBe(EXIT.OK)
    expect(
      (
        await postcheck(
          runner({ check: { present_accounts: 1 }, stamp: 'failed' }),
          registryOf(2),
          { allowEmpty: false },
        )
      ).exit,
    ).toBe(EXIT.RESURRECTED)
    expect(
      (await postcheck(runner({ stamp: 'failed' }), registryOf(2), { allowEmpty: false })).exit,
    ).toBe(EXIT.REGISTRY_INCONSISTENT)
  })

  it('promote-check refuses an image with no stamp, a failed stamp, or a stamp for another registry head', async () => {
    const reg = registryOf(2)
    expect((await promoteCheck(runner({ last: null }), reg, { allowEmpty: false })).reason).toBe(
      'no_passing_stamp',
    )
    expect(
      (
        await promoteCheck(
          runner({
            last: { status: 'failed', registry_head_seq: 2, registry_head_mac: reg.head.mac },
          }),
          reg,
          { allowEmpty: false },
        )
      ).exit,
    ).toBe(EXIT.NOT_PROMOTABLE)
    expect(
      (
        await promoteCheck(
          runner({
            last: { status: 'passed', registry_head_seq: 1, registry_head_mac: reg.head.mac },
          }),
          reg,
          { allowEmpty: false },
        )
      ).reason,
    ).toBe('stamp_does_not_cover_registry')
    expect(
      (
        await promoteCheck(
          runner({
            last: { status: 'passed', registry_head_seq: 2, registry_head_mac: 'f'.repeat(64) },
          }),
          reg,
          { allowEmpty: false },
        )
      ).reason,
    ).toBe('stamp_does_not_cover_registry')
  })

  it('a valid stamp does not authorise promotion by itself: the image is verified again', async () => {
    const reg = registryOf(2)
    const stamp = { status: 'passed', registry_head_seq: 2, registry_head_mac: reg.head.mac }
    const ok = await promoteCheck(runner({ last: stamp }), reg, { allowEmpty: false })
    expect(ok).toMatchObject({ exit: EXIT.OK, reason: 'promotable' })
    const resurrectedSince = await promoteCheck(
      runner({ last: stamp, check: { present_accounts: 1 } }),
      reg,
      { allowEmpty: false },
    )
    expect(resurrectedSince).toMatchObject({ exit: EXIT.RESURRECTED, reason: 'verify_failed' })
  })
})

describe('machinery', () => {
  it('names what is missing instead of guessing', async () => {
    const r: SqlRunner = {
      json: () =>
        Promise.resolve({
          tables: [true, false, true],
          functions: [true, true, false, true, true, true],
          barriers: 0,
        }),
    }
    const m = await checkMachinery(r)
    expect(m.present).toBe(false)
    expect(m.missing).toEqual([
      'table account_erasure_receipts',
      'function restore_gate_check',
      'write barrier triggers',
    ])
  })
})
