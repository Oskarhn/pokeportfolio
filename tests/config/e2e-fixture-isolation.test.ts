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

  it('no shared-user spec writes an absurd amount (15+ digits) into the shared ledger', () => {
    // Rule 3, found by the first combined run: exact-money-input typed 90 071 992 547 409,93 kr into
    // the shared user's ledger, and the Purchases list — which every other spec's smoke test loads —
    // then overflowed a 390 px viewport by 6 px. Such amounts belong to a spec that owns its user.
    const offenders = shared.filter((s) => /\b\d{15,}\b/.test(s.text)).map((s) => s.name)
    expect(offenders).toEqual([])
    const owners = specs.filter((s) => !sharesProjectUser(s) && /\b\d{15,}\b/.test(s.text))
    expect(owners.map((s) => s.name)).toContain('exact-money-input.spec.ts')
  })
})

/**
 * P165 — the card the synthetic scanner photo prints ("Fauxosaur EX 049") is shared REFERENCE data
 * with exactly one owner, the lease helper. P164 had two specs each insert their own copy: `cards`
 * is unique on (set_id, local_id), so under parallel workers one `beforeAll` failed and six tests
 * never ran (and a copy in another set would make BOTH cards candidates of every scan). A run that
 * happens to schedule the specs apart proves nothing, so this is a static rule, like the ones above.
 */
describe('E2E fixture ownership: the printed scanner fixture card (P165)', () => {
  const E2E_DIR = join(DIR, '..')
  const allSpecs = readdirSync(E2E_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => ({ name, text: readFileSync(join(E2E_DIR, name), 'utf8') }))
  const authenticatedName = (name: string) => name.replace(/^authenticated[\\/]/, '')

  it('no spec inserts a catalog card itself', () => {
    const offenders = allSpecs.filter((s) => /insert\s+into\s+public\.cards\b/i.test(s.text))
    expect(offenders.map((s) => s.name)).toEqual([])
  })

  it('every spec that scans the printed photo against the real catalog leases the card, and only those do', () => {
    const scanning = allSpecs
      .filter(
        (s) => /^authenticated[\\/]/.test(s.name) && /synthetic-card-modern\.png/.test(s.text),
      )
      .map((s) => authenticatedName(s.name))
      .sort()
    const leasing = allSpecs
      .filter((s) => /\bacquireScannerFixtureCard\(/.test(s.text))
      .map((s) => authenticatedName(s.name))
      .sort()
    // The rule is not vacuous: it finds the two specs that exist today.
    expect(scanning).toEqual(['p164-cross-track.spec.ts', 'price-check-ledger.spec.ts'])
    expect(leasing).toEqual(scanning)
  })

  it('the lease is given back only after the spec removed its own users, and the spec never deletes the shared rows', () => {
    for (const name of ['p164-cross-track.spec.ts', 'price-check-ledger.spec.ts']) {
      const text = readFileSync(join(DIR, name), 'utf8')
      const after = text.slice(text.indexOf('test.afterAll('))
      const users = after.indexOf('deleteSyntheticUser')
      const release = after.indexOf('.release()')
      expect(users, `${name}: afterAll deletes its users`).toBeGreaterThan(-1)
      expect(release, `${name}: afterAll releases the lease`).toBeGreaterThan(users)
      expect(text, `${name}: never deletes the shared fixture rows itself`).not.toMatch(
        /delete\s+from\s+public\.(cards|card_variants)\b/i,
      )
    }
  })
})
