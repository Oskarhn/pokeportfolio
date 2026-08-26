import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  SCORING_TIERS,
  SCORING_WEIGHTS,
  matchScannerObservation,
  parseScannerSignals,
  rankScannerCandidates,
  type ScannerCandidateRecord,
} from '../../../src/domain/scanner'

/**
 * Engine behaviour (P67 §9, §14–§20): explainable bands, ambiguity-aware confidence,
 * no-signal short-circuit, synthetic OCR cases, and property invariants (determinism,
 * monotonicity, dedupe stability).
 */

function card(
  cardId: string,
  name: string,
  localId: string,
  setName: string,
  language: 'en' | 'ja' = 'en',
): ScannerCandidateRecord {
  return {
    cardId,
    name,
    localId,
    rarity: null,
    category: null,
    illustrator: null,
    imageBaseUrl: null,
    language,
    setId: `${setName}-${language}`,
    setName,
    variantCount: 1,
  }
}

const TOP_REASONS = (match: ReturnType<typeof matchScannerObservation>) =>
  match.candidates[0]?.reasons ?? []

describe('scoring model — documented weight arithmetic', () => {
  it('a clean scan composes into HIGH from convergent printed evidence', () => {
    const candidates = [card('base1-4', 'Charizard', '4', 'Base Set')]
    const match = matchScannerObservation(
      {
        rawNameText: 'Charizard',
        rawCollectorNumberText: '4/102',
        rawSetText: 'Base Set',
        languageHint: 'en',
      },
      candidates,
    )
    expect(match.tier).toBe('high')
    expect(match.candidates[0]?.score).toBe(
      SCORING_WEIGHTS.collectorNumberExact +
        SCORING_WEIGHTS.nameExact +
        SCORING_WEIGHTS.setExact +
        SCORING_WEIGHTS.languageMatch,
    )
    expect(TOP_REASONS(match)).toEqual([
      'collector-number-exact',
      'name-exact',
      'set-exact',
      'language-match',
    ])
  })

  it('one-character name misses stay HIGH when number and set agree', () => {
    const match = matchScannerObservation(
      {
        rawNameText: 'P1kachu',
        rawCollectorNumberText: '58/102',
        rawSetText: 'Base Set',
        languageHint: 'en',
      },
      [card('base1-58', 'Pikachu', '58', 'Base Set')],
    )
    expect(match.tier).toBe('high')
    expect(TOP_REASONS(match)).toContain('collector-number-exact')
    expect(TOP_REASONS(match)).toContain('name-close')
  })

  it('the same local number across many sets is an ambiguous LOW candidate set (§9)', () => {
    // "4" exists in essentially every set. Id-exact alone must NOT imply uniqueness.
    const candidates = [
      card('a', 'Bulbasaur', '4', 'Jungle'),
      card('b', 'Squirtle', '4', 'Fossil'),
      card('c', 'Caterpie', '4', 'Base Set 2'),
      card('d', 'Oddish', '4', 'Team Up'),
    ]
    const match = matchScannerObservation(
      { rawCollectorNumberText: '4', languageHint: 'en' },
      candidates,
    )
    // Score lands in the medium BAND, but a zero margin against the runner-up caps the TIER.
    expect(match.candidates[0]?.score).toBeGreaterThanOrEqual(SCORING_TIERS.mediumMinScore)
    expect(match.tier).toBe('low')
    expect(match.notes).toContain('runner-up-margin-small')
  })

  it('an exact name alone is LOW — popular Pokémon have many printings (§9)', () => {
    const candidates = [
      card('p1', 'Pikachu', '58', 'Base Set'),
      card('p2', 'Pikachu', '25', 'XY'),
      card('p3', 'Pikachu', '10', 'Sword & Shield'),
    ]
    const match = matchScannerObservation({ rawNameText: 'Pikachu' }, candidates)
    expect(TOP_REASONS(match)).toEqual(['name-exact'])
    expect(match.candidates[0]?.score).toBe(SCORING_WEIGHTS.nameExact)
    expect(match.tier).toBe('low')
  })

  it('HIGH requires a real margin: near-equal twins are demoted to MEDIUM (§15)', () => {
    const twins = [
      card('t1', 'Charizard', '4', 'Base Set'),
      card('t2', 'Charizard', '4', 'Legendary Collection'),
    ]
    const ambiguous = matchScannerObservation(
      { rawNameText: 'Charizard', rawCollectorNumberText: '4', languageHint: 'en' },
      twins,
    )
    expect(ambiguous.candidates[0]?.score).toBeGreaterThanOrEqual(SCORING_TIERS.highMinScore)
    expect(ambiguous.tier).toBe('medium')
    expect(ambiguous.notes).toContain('runner-up-margin-small')

    // Adding the set hint separates them by exactly the high margin → HIGH returns.
    const resolved = matchScannerObservation(
      {
        rawNameText: 'Charizard',
        rawCollectorNumberText: '4',
        rawSetText: 'Base Set',
        languageHint: 'en',
      },
      twins,
    )
    expect(resolved.candidates[0]?.card.cardId).toBe('t1')
    expect(resolved.tier).toBe('high')
  })

  it('language disagreement subtracts — an English hint argues against Japanese cards', () => {
    const jaCard = card('j1', 'リザードン', '004', '拡張パック', 'ja')
    const withJaHint = matchScannerObservation(
      { rawCollectorNumberText: '004', languageHint: 'ja' },
      [jaCard],
    )
    const withEnHint = matchScannerObservation(
      { rawCollectorNumberText: '004', languageHint: 'en' },
      [jaCard],
    )
    const jaScore = withJaHint.candidates[0]?.score ?? 0
    const enScore = withEnHint.candidates[0]?.score ?? 0
    expect(jaScore - enScore).toBe(
      SCORING_WEIGHTS.languageMatch + SCORING_WEIGHTS.languageMismatchPenalty,
    )
  })
})

describe('no-signal behaviour (§17)', () => {
  it('returns NO MATCH for empty or junk observations without any candidates', () => {
    for (const observation of [
      {},
      { rawNameText: '' },
      { rawNameText: '??' },
      { rawNameText: 'ab' },
      { rawCollectorNumberText: '///' },
      { rawNameText: 'x', rawCollectorNumberText: '--' },
    ]) {
      const match = matchScannerObservation(observation, [card('a', 'Pikachu', '58', 'Base Set')])
      expect(match.tier).toBe('none')
      expect(match.candidates).toEqual([])
      expect(match.notes).toEqual(['insufficient-signal'])
    }
  })

  it('a two-character name fragment stays below the usable-signal threshold', () => {
    expect(parseScannerSignals({ rawNameText: 'Me' }).normalizedName).toBeNull()
    expect(parseScannerSignals({ rawNameText: 'Mew' }).normalizedName).toBe('mew')
  })
})

describe('synthetic OCR error cases (§18)', () => {
  const catalog = [
    card('g1', 'Gardevoir', '7', 'EX Sandstorm'),
    card('f1', 'Flabébé', '72', 'XY'),
    card('nf', 'Nidoran♀', '55', 'Base Set'),
    card('nm', 'Nidoran♂', '57', 'Base Set'),
    card('z1', 'Zekrom', '47', 'Black & White'),
  ]

  it.each([
    ['Pikachu', 'Pikachu'],
    ['P1kachu', 'Pikachu'],
    ['CHARIZARD  ', 'Charizard'],
    ['Gar devoir', 'Gardevoir'],
  ])('name "%s" resolves closest to "%s"', (raw, expected) => {
    const match = matchScannerObservation({ rawNameText: raw }, [
      ...catalog,
      card('pk', expected, '1', 'Some Set'),
    ])
    expect(match.candidates[0]?.card.name).toBe(expected)
  })

  it('accent-dropped Gardevoir-family and Flabébé reads still hit exactly', () => {
    const match = matchScannerObservation({ rawNameText: 'FLABEBE' }, catalog)
    expect(match.candidates[0]?.card.cardId).toBe('f1')
    expect(TOP_REASONS(match)).toContain('name-exact')
  })

  it('Nidoran gender symbols disambiguate instead of colliding', () => {
    const female = matchScannerObservation(
      { rawNameText: 'Nidoran♀', rawCollectorNumberText: '55' },
      catalog,
    )
    expect(female.candidates[0]?.card.cardId).toBe('nf')

    const maleObservedAsM = matchScannerObservation(
      { rawNameText: 'NidoranM', rawCollectorNumberText: '57' },
      catalog,
    )
    expect(maleObservedAsM.candidates[0]?.card.cardId).toBe('nm')
  })

  it('leading-zero and lost-slash collector numbers reach the right printing', () => {
    const oldSet: ScannerCandidateRecord = {
      ...card('o1', 'Venusaur', '015/102', 'Base Set'),
    }
    const match = matchScannerObservation(
      // Lost slash AND doubled zero padding: still one unambiguous id.
      { rawNameText: 'Venusaur', rawCollectorNumberText: '0015 0102' },
      [oldSet, ...catalog],
    )
    // Zero-padding differences do not break the exact-id comparison.
    expect(TOP_REASONS(match)).toContain('collector-number-exact')
  })

  it('I/1 confusion inside a prefixed id still supports the right candidate (folded)', () => {
    const target = card('tg1', 'Gardevoir', 'TG01', 'Paldea Evolved')
    const match = matchScannerObservation(
      { rawNameText: 'Gardevoir', rawCollectorNumberText: 'TGO1' },
      [target],
    )
    expect(TOP_REASONS(match)).toContain('collector-number-ocr-folded')
    expect(match.tier).not.toBe('none')
  })
})

describe('ambiguity surfacing (§19)', () => {
  it('reprints rank by their own convergent evidence rather than inventing certainty', () => {
    const printings = [
      card('r1', 'Pikachu', '58', 'Base Set'),
      card('r2', 'Pikachu', '60', 'Base Set 2'),
      card('r3', 'Pikachu', '25', 'Celebrations'),
    ]
    const scan = matchScannerObservation(
      { rawNameText: 'Pikachu', rawCollectorNumberText: '60', languageHint: 'en' },
      printings,
    )
    expect(scan.candidates[0]?.card.cardId).toBe('r2')
    expect(scan.candidates[1]?.card.cardId).toBe('r1')
  })

  it('Trainer cards sharing a name stay distinguishable through their numbers', () => {
    const trainers = [
      card('s1', 'Bill', '88', 'Base Set'),
      card('s2', 'Bill', '91', 'Base Set'),
      card('s3', 'Bill', '1', 'XY'),
    ]
    const scan = matchScannerObservation(
      { rawNameText: 'Bill', rawCollectorNumberText: '91/102' },
      trainers,
    )
    expect(scan.candidates[0]?.card.cardId).toBe('s2')
  })
})

describe('ranking mechanics', () => {
  const pool = [
    card('c1', 'Pikachu', '58', 'Base Set'),
    card('c2', 'Raichu', '26', 'Base Set'),
    card('c3', 'Pikachu', '25', 'XY'),
    card('c4', 'Pikachu', '10', 'Sword & Shield'),
    card('c5', 'Pichu', '1', 'Neo Genesis'),
    card('c6', 'Pikachu', '35', 'EX Ruby & Sapphire'),
    card('c7', 'Morpeko', '37', 'Sword & Shield'),
  ]

  it('bounds returned candidates to the documented maximum', () => {
    const many = Array.from({ length: 12 }, (_, i) => card(`m${i}`, 'Energy', `${i + 1}`, 'Base'))
    const match = matchScannerObservation({ rawNameText: 'Energy' }, many)
    expect(match.candidates.length).toBe(SCORING_TIERS.maxReturnedCandidates)
  })

  it('breaks score ties by cardId — input order cannot change the outcome', () => {
    const observation = { rawNameText: 'Pikachu' }
    const forward = matchScannerObservation(observation, [...pool])
    const reversed = matchScannerObservation(observation, [...pool].reverse())
    expect(reversed.candidates.map((c) => c.card.cardId)).toEqual(
      forward.candidates.map((c) => c.card.cardId),
    )
  })

  it('deduplicates repeated records deterministically', () => {
    const once = matchScannerObservation({ rawNameText: 'Pikachu' }, pool)
    const duplicated = matchScannerObservation({ rawNameText: 'Pikachu' }, [...pool, ...pool])
    expect(duplicated).toEqual(once)
  })

  it('ignores the reserved visualSimilarity seam entirely (§23)', () => {
    const without = matchScannerObservation({ rawNameText: 'Pikachu' }, pool)
    const withSeam = matchScannerObservation(
      { rawNameText: 'Pikachu', visualSimilarity: 0.93 },
      pool,
    )
    expect(withSeam).toEqual(without)
  })
})

describe('property invariants (fast-check)', () => {
  const arbCandidate = fc
    .record({
      id: fc.stringMatching(/^cd-[a-z]{4}$/),
      name: fc.constantFrom('Pikachu', 'Charizard', 'Gardevoir', 'Bill', 'Zekrom'),
      localId: fc.constantFrom('1', '4', '25', '58', 'TG01'),
      setName: fc.constantFrom('Base Set', 'XY', 'Surging Sparks'),
    })
    .map((r): ScannerCandidateRecord => ({
      cardId: r.id,
      name: r.name,
      localId: r.localId,
      rarity: null,
      category: null,
      illustrator: null,
      imageBaseUrl: null,
      language: 'en',
      setId: r.setName,
      setName: r.setName,
      variantCount: 1,
    }))
  const arbCandidates = fc.uniqueArray(arbCandidate, {
    // Real retrieval never yields two rows with one card id (the adapter dedupes at fetch
    // time), so the ranking properties model distinct ids; the explicit dedupe tests below
    // cover colliding inputs separately.
    selector: (candidate) => candidate.cardId,
    maxLength: 8,
  })
  const baseObservation = { rawNameText: 'Pikachu', rawCollectorNumberText: '58' }

  it('matching twice is deterministic — no hidden state, no randomness', () => {
    fc.assert(
      fc.property(arbCandidates, fc.nat(4), (candidates, seed) => {
        const observations = [
          baseObservation,
          { rawNameText: 'Charizard' },
          { rawCollectorNumberText: 'TG01' },
          { rawNameText: 'P1kachu', rawCollectorNumberText: '58/102', languageHint: 'en' },
          {},
        ] as const
        const observation = observations[seed] ?? baseObservation
        expect(matchScannerObservation(observation, candidates)).toEqual(
          matchScannerObservation(observation, candidates),
        )
      }),
    )
  })

  it('input permutation cannot change ranked output', () => {
    fc.assert(
      fc.property(arbCandidates, (candidates) => {
        const forward = matchScannerObservation(baseObservation, candidates)
        const backward = matchScannerObservation(baseObservation, [...candidates].reverse())
        expect(backward).toEqual(forward)
      }),
    )
  })

  it('adding non-negative evidence never lowers the same candidate’s score', () => {
    fc.assert(
      fc.property(arbCandidates, (candidates) => {
        const weaker = parseScannerSignals(baseObservation)
        const stronger = parseScannerSignals({
          ...baseObservation,
          rawSetText: 'Base Set',
          languageHint: 'en',
        })
        const weakMatch = rankScannerCandidates(weaker, candidates)
        const strongMatch = rankScannerCandidates(stronger, candidates)
        for (const strongCandidate of strongMatch.candidates) {
          const weakCandidate = weakMatch.candidates.find(
            (c) => c.card.cardId === strongCandidate.card.cardId,
          )
          // Candidates absent from the weak result were cut by the bound, not down-scored;
          // every shared candidate must obey monotonicity.
          if (weakCandidate) {
            expect(strongCandidate.score).toBeGreaterThanOrEqual(weakCandidate.score)
          }
        }
      }),
    )
  })

  it('duplicate inputs collapse — result equals the deduplicated run', () => {
    fc.assert(
      fc.property(arbCandidates, fc.nat(3), (candidates, copies) => {
        const padded = [...candidates]
        for (let i = 0; i < copies; i++) padded.push(...candidates)
        expect(matchScannerObservation(baseObservation, padded)).toEqual(
          matchScannerObservation(baseObservation, candidates),
        )
      }),
    )
  })
})

describe('pure-ranking performance (§22 — measured, not fabricated)', () => {
  it('ranks 20/50/100 candidates well inside any OCR/network budget', () => {
    const makeCatalog = (size: number): ScannerCandidateRecord[] =>
      Array.from({ length: size }, (_, i) =>
        card(`perf-${i}`, `Pokémon ${i}`, `${(i % 250) + 1}/400`, `Set ${i % 40}`),
      )

    const timings: Record<number, number> = {}
    for (const size of [20, 50, 100]) {
      const catalog = makeCatalog(size)
      const signals = parseScannerSignals({
        rawNameText: 'Pokémon 42',
        rawCollectorNumberText: '43/400',
        rawSetText: 'Set 7',
        languageHint: 'en',
      })
      // Warm-up outside timing, then average a meaningful number of runs.
      rankScannerCandidates(signals, catalog)
      const RUNS = 2000
      const startedAt = performance.now()
      for (let i = 0; i < RUNS; i++) {
        rankScannerCandidates(signals, catalog)
      }
      timings[size] = (performance.now() - startedAt) / RUNS
    }

    // Real machine-dependent numbers go to the log for the session record; the assertion is a
    // catastrophic-only budget (a pathological regression or accidental N+1 would blow past
    // it), deliberately loose enough that slow CI hardware cannot flake.
    console.info(
      '[scanner perf] avg ms per full ranking — 20:',
      timings[20]?.toFixed(4),
      '· 50:',
      timings[50]?.toFixed(4),
      '· 100:',
      timings[100]?.toFixed(4),
    )
    expect(timings[20]).toBeLessThan(5)
    expect(timings[50]).toBeLessThan(5)
    expect(timings[100]).toBeLessThan(5)
  })
})
