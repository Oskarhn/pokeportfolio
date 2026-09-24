import { describe, expect, it } from 'vitest'
import {
  cardsSharingAName,
  resolveVariant,
  variantLabel,
} from '../../../src/domain/price-check/identity'
import {
  gradedSection,
  groupGradedByCompany,
  parseGradedObservations,
} from '../../../src/domain/price-check/graded'
import { interpretScan, type ScanCandidate } from '../../../src/domain/price-check/scan'
import type { VariantIdentity } from '../../../src/domain/price-check/types'

function variant(id: string, over: Partial<VariantIdentity> = {}): VariantIdentity {
  return {
    variantId: id,
    finish: 'normal',
    stamp: '',
    subtype: '',
    size: 'standard',
    isActive: true,
    ...over,
  }
}

describe('resolveVariant — a price needs one exact variant', () => {
  const normal = variant('n')
  const reverse = variant('r', { finish: 'reverse' })
  const holo = variant('h', { finish: 'holo', subtype: 'shadowless', stamp: '1st-edition' })

  it('a card with several variants and no choice never gets a default', () => {
    const r = resolveVariant([normal, reverse, holo], undefined)
    expect(r.status).toBe('choice_required')
  })

  it('exactly one active variant is confirmed automatically, and says why', () => {
    expect(resolveVariant([normal], undefined)).toEqual({
      status: 'confirmed',
      variant: normal,
      basis: 'only_variant',
    })
    const retired = variant('old', { isActive: false })
    expect(resolveVariant([normal, retired], undefined)).toMatchObject({
      status: 'confirmed',
      basis: 'only_variant',
      variant: normal,
    })
  })

  it('an explicit choice is honoured', () => {
    expect(resolveVariant([normal, reverse], 'r')).toEqual({
      status: 'confirmed',
      variant: reverse,
      basis: 'chosen',
    })
  })

  it('a requested variant that is not this card’s is a mismatch — it never falls back to another', () => {
    const r = resolveVariant([normal, reverse], 'someone-elses-variant')
    expect(r.status).toBe('mismatch')
    const single = resolveVariant([normal], 'someone-elses-variant')
    expect(single.status).toBe('mismatch')
  })

  it('no variants → no_variants', () => {
    expect(resolveVariant([], undefined)).toEqual({ status: 'no_variants' })
  })

  it('two active variants are never auto-resolved even if one is "obviously" the base', () => {
    expect(resolveVariant([normal, reverse], undefined).status).toBe('choice_required')
  })

  it('labels every identity dimension', () => {
    expect(variantLabel(holo)).toBe('Holo · shadowless · 1st-edition')
    expect(variantLabel(variant('x', { size: 'oversized' }))).toBe('Normal · Oversized')
    expect(variantLabel(variant('y', { finish: 'other' }))).toBe('Other finish')
  })
})

describe('cardsSharingAName — a name alone is not identity', () => {
  it('flags cards whose names collide (case/space-insensitive), keeps distinct ones unflagged', () => {
    const shared = cardsSharingAName([
      { cardId: 'a', name: 'Charizard' },
      { cardId: 'b', name: ' charizard ' },
      { cardId: 'c', name: 'Pikachu' },
      { cardId: 'd', name: 'CHARIZARD' },
    ])
    expect([...shared].sort()).toEqual(['a', 'b', 'd'])
  })

  it('a single result shares its name with nothing', () => {
    expect(cardsSharingAName([{ cardId: 'a', name: 'Mew' }]).size).toBe(0)
  })
})

describe('graded observations', () => {
  const source = { id: 'fixture', label: 'Fixture source' }
  const ctx = { source, fetchedAt: '2026-09-20T10:00:00Z', synthetic: true }
  const row = (o: Record<string, unknown> = {}) => ({
    company: 'PSA',
    grade: '10',
    kind: 'sold',
    currency: 'USD',
    valueMinor: '25000',
    observedAt: '2026-09-18T00:00:00Z',
    ...o,
  })

  it('parses company, grade, kind, exact price and marks fixtures synthetic', () => {
    const { observations, dropped } = parseGradedObservations([row()], ctx)
    expect(dropped).toEqual([])
    expect(observations[0]).toMatchObject({
      subject: { type: 'graded', company: 'PSA', grade: '10', qualifier: null },
      kind: 'sold',
      price: { minorUnits: 25000n, currency: 'USD' },
      synthetic: true,
    })
  })

  it('refuses a price that does not state its basis (no default to "sold")', () => {
    expect(parseGradedObservations([row({ kind: undefined })], ctx).dropped[0]?.reason).toBe(
      'missing_kind',
    )
    expect(parseGradedObservations([row({ kind: 'average' })], ctx).dropped[0]?.reason).toBe(
      'missing_kind',
    )
  })

  it.each([
    ['unknown company', { company: 'ACME' }, 'unknown_company'],
    ['prototype company', { company: 'constructor' }, 'unknown_company'],
    ['grade 0', { grade: '0' }, 'malformed_grade'],
    ['grade 11', { grade: '11' }, 'malformed_grade'],
    ['numeric grade', { grade: 10 }, 'malformed_grade'],
    ['grade 9.7', { grade: '9.7' }, 'malformed_grade'],
    ['bad price', { valueMinor: '-3' }, 'malformed_price'],
    ['bad currency', { currency: 'toString' }, 'unsupported_currency'],
  ])('drops %s', (_n, over, reason) => {
    expect(parseGradedObservations([row(over)], ctx).dropped[0]?.reason).toBe(reason)
  })

  it('PSA 10, BGS 10 and CGC 10 stay three separate subjects; qualifiers are part of identity', () => {
    const { observations } = parseGradedObservations(
      [
        row({ company: 'PSA', grade: '10', valueMinor: '30000' }),
        row({ company: 'BGS', grade: '10', valueMinor: '50000', qualifier: 'Pristine' }),
        row({ company: 'BGS', grade: '10', valueMinor: '20000' }),
        row({ company: 'CGC', grade: '10', valueMinor: '10000' }),
        row({ company: 'PSA', grade: '9', valueMinor: '9000' }),
      ],
      ctx,
    )
    const groups = groupGradedByCompany(observations)
    expect(groups.map((g) => g.company)).toEqual(['PSA', 'BGS', 'CGC'])
    expect(groups[0]?.rows.map((r) => r.price.minorUnits)).toEqual([30000n, 9000n])
    // Same company + grade, different qualifier → two rows, never merged or averaged.
    expect(groups[1]?.rows).toHaveLength(2)
  })

  it('section status: nothing configured / errored / empty / available', () => {
    const none = gradedSection({ sources: [], observations: [], dropped: [] })
    expect(none).toMatchObject({
      status: 'unavailable',
      unavailable: 'graded_source_not_configured',
    })
    expect(
      gradedSection({
        sources: [{ id: 's', label: 'S', state: 'error' }],
        observations: [],
        dropped: [],
      }).unavailable,
    ).toBe('provider_error')
    expect(
      gradedSection({
        sources: [{ id: 's', label: 'S', state: 'ok' }],
        observations: [],
        dropped: [],
      }).unavailable,
    ).toBe('graded_no_data')
    const { observations } = parseGradedObservations([row()], ctx)
    expect(
      gradedSection({
        sources: [{ id: 's', label: 'S', state: 'ok' }],
        observations,
        dropped: [],
      }).status,
    ).toBe('available')
  })
})

describe('interpretScan — how much confirmation a scanned identity needs', () => {
  const cand = (id: string): ScanCandidate => ({
    candidateId: id,
    name: id,
    setName: null,
    collectorNumber: null,
    imageBaseUrl: null,
    languageLabel: null,
  })

  it('HIGH pre-selects the best candidate (still confirmed by the person)', () => {
    expect(interpretScan({ confidence: 'HIGH', candidates: [cand('a'), cand('b')] })).toEqual({
      kind: 'high',
      candidates: [cand('a'), cand('b')],
      preselectedId: 'a',
    })
  })

  it('MEDIUM and LOW never pre-select', () => {
    for (const confidence of ['MEDIUM', 'LOW'] as const) {
      const outcome = interpretScan({ confidence, candidates: [cand('a')] })
      expect(outcome.kind).toBe('review')
      expect('preselectedId' in outcome).toBe(false)
    }
  })

  it('NO_MATCH, or HIGH with no candidates, is a manual-search fallback', () => {
    expect(interpretScan({ confidence: 'NO_MATCH', candidates: [] })).toEqual({ kind: 'no_match' })
    expect(interpretScan({ confidence: 'HIGH', candidates: [] })).toEqual({ kind: 'no_match' })
  })

  it('a contradictory NO_MATCH that carries candidates is shown for review, not pre-selected', () => {
    expect(interpretScan({ confidence: 'NO_MATCH', candidates: [cand('a')] }).kind).toBe('review')
  })
})
