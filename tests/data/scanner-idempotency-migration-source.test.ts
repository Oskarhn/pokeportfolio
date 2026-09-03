/**
 * Source-level regression guard for F-20/F-21 (P94) — needs no live database, no Docker: reads
 * the migration file directly off disk.
 *
 * WHY THIS EXISTS: F-20 was exactly a DUPLICATION-DRIFT bug — the exception-handler (race) replay
 * path independently re-implemented the same replay-validation logic the early (sequential) path
 * already had, and silently omitted the voided_at check when it did. A purely behavioral test
 * cannot deterministically force execution down the exception-handler branch WHILE a competing
 * void has landed in the single-statement window between its failed INSERT and its own SELECT
 * (see tests/db/m15_scanner_idempotency.test.ts's own header for the full reasoning on why that
 * specific interleaving is not client-orchestratable). This test instead pins the fix at the
 * source level: the exception handler's own SQL block — not just the early-check block — contains
 * both required guards, so a future edit that quietly drops one back out of ONLY the exception
 * handler (reintroducing exactly this drift class) fails this test immediately.
 *
 * NEVER points at 20260903120000_m15_scanner_idempotency.sql (the original, immutable migration
 * this repository never edits in place) — only at the P94 forward-fix migration that replaces the
 * function body.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const migrationPath = join(
  repoRoot,
  'supabase',
  'migrations',
  '20260903120020_p94_scanner_idempotency_race_fix.sql',
)

function readMigration(): string {
  return readFileSync(migrationPath, 'utf-8')
}

/** Extracts the text of the OUTER `exception when unique_violation then ... end;` block — the
 *  race-path replay handler F-20 fixed — distinct from the nested holdings-identity exception
 *  handler earlier in the function (a different, unrelated unique_violation handler) and distinct
 *  from the early sequential-check block that runs before any mutation. Anchored on the specific
 *  comment this migration's own exception handler carries, immediately followed by the block. */
function extractExceptionHandlerBlock(source: string): string {
  const marker = 'P94 F-20/F-21: this race-path replay now applies'
  const markerIndex = source.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error(
      `Could not find the F-20/F-21 exception-handler marker comment in ${migrationPath} — has it been reworded or removed?`,
    )
  }
  const blockEnd = source.indexOf('\n  end;\n\n  return query', markerIndex)
  if (blockEnd === -1) {
    throw new Error('Could not find the end of the exception-handler block after the marker.')
  }
  return source.slice(markerIndex, blockEnd)
}

describe('F-20/F-21 migration source (needs no live database)', () => {
  it('never edits the original, immutable M15 idempotency migration', () => {
    // The original migration is untouched by this session — confirmed by its own unrelated
    // content still being present verbatim (spot-checked lines that would change if edited).
    const original = readFileSync(
      join(repoRoot, 'supabase', 'migrations', '20260903120000_m15_scanner_idempotency.sql'),
      'utf-8',
    )
    expect(original).toContain('-- M15: Server-side idempotency for add_card_acquisition (D-096).')
    // The forward-fix migration exists as a SEPARATE, later-timestamped file.
    expect(() => readMigration()).not.toThrow()
  })

  it('uses CREATE OR REPLACE (signature unchanged) — never DROP+CREATE, never a grant/revoke restatement', () => {
    const source = readMigration()
    expect(source).toContain('create or replace function public.add_card_acquisition(')
    expect(source).not.toMatch(/drop function/i)
    expect(source).not.toMatch(/^\s*grant execute/im)
    expect(source).not.toMatch(/^\s*revoke execute/im)
  })

  it('F-20: the exception-handler (race-path) block checks voided_at, with the same external error text as the early path', () => {
    const handler = extractExceptionHandlerBlock(readMigration())
    expect(handler).toContain('if v_replay.voided_at is not null then')
    expect(handler).toContain(
      "raise exception 'idempotency-key-reuse: the original acquisition was already processed '",
    )
  })

  it('F-21: the exception-handler (race-path) block also checks full material equivalence, including grader AND grade', () => {
    const handler = extractExceptionHandlerBlock(readMigration())
    expect(handler).toContain('public.grader_to_text(h.grader)')
    expect(handler).toContain('public.grader_to_text(p_grader)')
    expect(handler).toContain('coalesce(h.grade, -1) = coalesce(p_grade, -1)')
    expect(handler).toContain(
      "raise exception 'idempotency-key-reuse: key % already belongs to a different '",
    )
  })

  it('the exception-handler material check is a byte-identical predicate to the early-check block (parity, not just presence)', () => {
    const source = readMigration()
    const earlyCheckStart = source.indexOf('-- ── Early idempotent replay')
    const exceptionHandlerStart = source.indexOf('P94 F-20/F-21: this race-path replay now applies')
    expect(earlyCheckStart).toBeGreaterThan(-1)
    expect(exceptionHandlerStart).toBeGreaterThan(earlyCheckStart)
    const earlyBlock = source.slice(earlyCheckStart, source.indexOf('return;', earlyCheckStart))
    const exceptionBlock = extractExceptionHandlerBlock(source)

    // The full 11-condition material predicate, exactly as it appears in the early block — every
    // line must also appear, verbatim, in the exception-handler block. This is the actual parity
    // guarantee: not just "both mention grade," but the identical predicate in both places.
    const predicateLines = [
      'h.holding_kind = v_holding_kind',
      'coalesce(h.card_variant_id, h.sealed_product_id, h.manual_card_id)',
      "coalesce(public.card_condition_to_text(h.condition), '')",
      'h.grading_state = p_grading_state',
      "coalesce(public.grader_to_text(h.grader), '') = coalesce(public.grader_to_text(p_grader), '')",
      'coalesce(h.grade, -1) = coalesce(p_grade, -1)',
      'al2.origin = p_origin',
      'al2.cost_basis_state = p_cost_basis_state',
      'al2.quantity = p_quantity',
      'al2.acquired_on = p_acquired_on',
      '(al2.storage_location_id is not distinct from p_storage_location_id)',
    ]
    for (const line of predicateLines) {
      expect(earlyBlock).toContain(line)
      expect(exceptionBlock).toContain(line)
    }
  })
})
