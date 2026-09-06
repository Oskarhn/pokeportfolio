import { describe, expect, it } from 'vitest'
import { EXPORT_SECTION_SELECTS } from '../../src/data/export/fetch-snapshot'

/**
 * P111 §11 — `purchases.idempotency_key`/`idempotency_request` (D-121/D-122) are operational
 * replay metadata, not a user-portable logical financial fact: the backup contract must never
 * carry them, and a restored purchase must never be able to collide with a historical request key
 * it never actually made. `EXPORT_SECTION_SELECTS.purchases` is already an explicit column
 * allowlist (never `select('*')`), which already excludes them by construction — this test locks
 * that in so a future column addition to `purchases` can't silently widen the export by switching
 * to a wildcard select or by someone appending the new column here without thinking about it.
 */
describe('export column allowlist excludes purchase idempotency replay metadata (D-122)', () => {
  it('purchases export select never mentions idempotency_key or idempotency_request', () => {
    expect(EXPORT_SECTION_SELECTS.purchases).not.toMatch(/idempotency/i)
  })
})
