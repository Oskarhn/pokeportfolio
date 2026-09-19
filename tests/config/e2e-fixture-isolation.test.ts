import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P147 — the authenticated E2E project shares one synthetic user across its specs, so the lots they
 * create live in one pool. A spec that SELLS through the UI must not sell from that pool: the sale
 * form pre-fills the holding's first lot, which can belong to another worker's fixture (P146 saw a
 * parallel-only failure "card has already been partially disposed" for exactly that reason).
 *
 * The rule (documented at ISOLATED_SALE_VARIANT in tests/e2e/authenticated/fixtures.ts):
 *
 *   1. every spec that shares the project's user and presses "Save sale" takes its inventory from
 *      ISOLATED_SALE_VARIANT;
 *   2. no OTHER shared-user spec touches that variant, so its holding holds only that spec's lots.
 *
 * A spec that creates its own synthetic users (auth-*-real, ...) has its own inventory and is out
 * of scope. This is a static check on purpose: the failure it prevents needs parallel workers and
 * an unlucky order, so a run that happens to pass proves nothing.
 */

const DIR = join(__dirname, '..', 'e2e', 'authenticated')
const specs = readdirSync(DIR)
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }))

// A spec that builds its own synthetic users (directly or through the two-tab helpers) has its own
// inventory and is out of scope.
const sharesProjectUser = (spec: { text: string }) =>
  !/\b(?:createSyntheticUser|createPair)\(/.test(spec.text)

// The variant must actually be USED as the inventory of a fixture, not merely imported.
const usesIsolatedVariant = (spec: { text: string }) =>
  /cardVariantId:\s*ISOLATED_SALE_VARIANT/.test(spec.text)

// Only an exact "Save sale" button press SELLS. (A validation-only click on an empty form uses a
// pattern like /^(Save sale|Record sale)$/ and records nothing.)
const sellsThroughUi = (spec: { text: string }) => /name:\s*'Save sale'/.test(spec.text)

describe('E2E fixture isolation (shared-user authenticated specs)', () => {
  const shared = specs.filter(sharesProjectUser)

  it('finds the specs it is meant to police (the rule is not vacuous)', () => {
    expect(shared.length).toBeGreaterThanOrEqual(8)
    expect(shared.filter(sellsThroughUi).map((s) => s.name)).toContain('blank-money-input.spec.ts')
  })

  it('every shared-user spec that sells through the UI sells from its own variant', () => {
    const offenders = shared
      .filter(sellsThroughUi)
      .filter((s) => !usesIsolatedVariant(s))
      .map((s) => s.name)
    expect(offenders).toEqual([])
  })

  it('no other shared-user spec touches that variant', () => {
    const users = shared.filter(usesIsolatedVariant).map((s) => s.name)
    expect(users).toEqual(['blank-money-input.spec.ts'])
    // ...including by naming the variant directly.
    const direct = shared.filter((s) => /grassEnergyVariantId/.test(s.text)).map((s) => s.name)
    expect(direct).toEqual([])
  })
})
