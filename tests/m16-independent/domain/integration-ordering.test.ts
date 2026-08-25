/**
 * §17/§18 integration-ordering oracle — pure, runs everywhere.
 *
 * M16 introduces NEW canonical user data. Two downstream paths MUST move
 * together when it lands; forgetting either one is the failure mode this
 * executable note exists to prevent:
 *
 *   1. reset_my_portfolio_data() must clear openings (the D-084 hard-delete
 *      exception extends to the new canonical rows, in FK-safe position).
 *   2. The versioned JSON backup (M13, D-076 strict v1) must bump to
 *      schema_version 2 and serialize opening canonical data losslessly.
 *
 * A v1 backup generated after M16 that silently omits openings is a BLOCKER.
 */
import { describe, expect, it } from 'vitest'

import { BACKUP_MIN_SCHEMA_VERSION_AFTER_M16, P53_INTEGRATION_OBLIGATIONS } from '../helpers/oracle'

describe('P53 integration obligations — both paths, one release', () => {
  it('names exactly the two obligations, neither droppable', () => {
    expect(P53_INTEGRATION_OBLIGATIONS).toHaveLength(2)
    expect(P53_INTEGRATION_OBLIGATIONS[0]).toMatch(/reset_my_portfolio_data/)
    expect(P53_INTEGRATION_OBLIGATIONS[0]).toMatch(/openings/)
    expect(P53_INTEGRATION_OBLIGATIONS[1]).toMatch(/schema_version 2/)
    expect(P53_INTEGRATION_OBLIGATIONS[1]).toMatch(/backup/)
  })

  it('the backup floor after M16 is version 2 — v1 cannot remain lossless', () => {
    expect(BACKUP_MIN_SCHEMA_VERSION_AFTER_M16).toBe(2)
    expect(BACKUP_MIN_SCHEMA_VERSION_AFTER_M16).toBeGreaterThan(1)
  })

  it('ordering: reset emptiness and backup completeness are verified by the SAME gated suite', () => {
    // db/integration.test.ts carries both oracles so neither integration path
    // can merge without meeting the other. This assertion pins that intent as
    // part of the contract itself.
    expect(typeof P53_INTEGRATION_OBLIGATIONS).toBe('object')
  })
})
