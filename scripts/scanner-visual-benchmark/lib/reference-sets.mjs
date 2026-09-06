// Sets chosen for the P76 visual-recognition benchmark corpus (prompt §11): span vintage and
// modern layouts, holo/non-holo, full-art-heavy sets, and known cross-set reprints of the same
// artwork so "same/similar art, different printing" cases are represented for real.
export const BENCHMARK_SETS = [
  { id: 'base1', name: 'Base Set', lang: 'en' },
  { id: 'base2', name: 'Jungle', lang: 'en' },
  { id: 'neo1', name: 'Neo Genesis', lang: 'en' },
  { id: 'swsh1', name: 'Sword & Shield', lang: 'en' },
  { id: 'swsh7', name: 'Evolving Skies', lang: 'en' },
  { id: 'sv01', name: 'Scarlet & Violet', lang: 'en' },
]

// Celebrations Classic Collection deliberately reprints classic Base Set / vintage artwork under
// NEW card ids — forces real "same/near-identical art, different printing" ambiguity (prompt
// §35) into the corpus instead of hoping it appears by chance. Verified live against the TCGdex
// API 2026-08-26 (`/v2/en/sets/cel25cc`).
export const REPRINT_SET = { id: 'cel25cc', name: 'Celebrations Classic Collection', lang: 'en' }
