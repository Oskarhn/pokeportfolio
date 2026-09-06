import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P112 §11/§C.4 — a cheap, standing check that the specific facts recorded in
 * docs/M15_SOURCE_PROVENANCE.md stay true. This does not re-verify EVERY behaviour the matrix
 * documents (the migrations/tests/DECISIONS.md entries themselves own that); it exists to catch
 * the one failure mode a provenance document can't catch on its own — a future edit silently
 * deleting or renaming one of the specific renumbered/superseded artifacts the matrix points at,
 * which would otherwise only surface as a confusing mismatch between the doc and reality.
 */
describe('M15 source provenance matrix stays accurate', () => {
  const decisions = readFileSync(join(process.cwd(), 'docs', 'DECISIONS.md'), 'utf-8')

  it('the provenance matrix document itself exists', () => {
    expect(existsSync(join(process.cwd(), 'docs', 'M15_SOURCE_PROVENANCE.md'))).toBe(true)
  })

  it.each([
    ['D-120', 'Dashboard-read index'],
    ['D-121', "create_purchase' gains an optional"],
    ['D-122', "idempotent replay now preserves"],
    ['D-123', '404-resume'],
  ])('renumbered/corrected decision %s is present in DECISIONS.md', (id) => {
    expect(decisions).toMatch(new RegExp(`^## ${id} —`, 'm'))
  })

  it('the P94 race-path idempotency fix migration exists (superseded add_card_acquisition body)', () => {
    expect(
      existsSync(
        join(
          process.cwd(),
          'supabase',
          'migrations',
          '20260903120020_p94_scanner_idempotency_race_fix.sql',
        ),
      ),
    ).toBe(true)
  })

  it("the P111 notes-replay correction migration exists (supersedes P108's D-121 body)", () => {
    expect(
      existsSync(
        join(
          process.cwd(),
          'supabase',
          'migrations',
          '20260905130000_p111_purchase_notes_replay_semantics.sql',
        ),
      ),
    ).toBe(true)
  })

  it('the D-123 404-reprobe fix is still wired (shouldSkipPermanentFailure exported)', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'domain', 'scanner', 'checkpoint-identity.ts'),
      'utf-8',
    )
    expect(source).toMatch(/export function shouldSkipPermanentFailure/)
  })

  it("P109's full-entity SaleForm reset remains the sole reset authority (P106's items-only path is gone)", () => {
    const saleFormState = readFileSync(
      join(process.cwd(), 'src', 'features', 'sales', 'sale-form-state.ts'),
      'utf-8',
    )
    expect(saleFormState).toMatch(/createInitialSaleFormFields/)
    // P106's superseded items-only reset used a `previousPrefillKeyRef` — confirm it is gone, not
    // merely unused, so a future partial revert can't silently reintroduce dual reset paths.
    const sourceTreeHasOldRef = [
      readFileSync(join(process.cwd(), 'src', 'features', 'sales', 'sale-form-state.ts'), 'utf-8'),
      readFileSync(
        join(process.cwd(), 'src', 'features', 'sales', 'keyed-prefill-guard.ts'),
        'utf-8',
      ),
    ].some((content) => content.includes('previousPrefillKeyRef'))
    expect(sourceTreeHasOldRef).toBe(false)
  })
})
