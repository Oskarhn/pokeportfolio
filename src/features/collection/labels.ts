import type { CardCondition, Grader, LotOrigin } from '../../data/collection'

/** Shared UI labels for collection enums — kept in one place per DESIGN_SYSTEM.md §8 ("financial
 *  terms mean what they mean") so a label never drifts between the two screens that show it. */

export const CONDITION_LABEL: Record<CardCondition, string> = {
  MT: 'Mint',
  NM: 'Near Mint',
  EX: 'Excellent',
  GD: 'Good',
  LP: 'Lightly Played',
  PL: 'Played',
  PO: 'Poor',
}

export const GRADER_LABEL: Record<Grader, string> = {
  psa: 'PSA',
  cgc: 'CGC',
  bgs: 'BGS',
  ace: 'ACE',
  sgc: 'SGC',
  tag: 'TAG',
  other: 'Other',
}

/** The exact frozen origin set (M6 prompt §24). 'found' exists in the schema from M3 but is not
 *  offered here — nothing in the UI needs a seventh option beyond the frozen list. */
export const ORIGIN_LABEL: Record<LotOrigin, string> = {
  purchase: 'Purchased',
  opening: 'Pulled',
  gift: 'Gifted',
  trade_in: 'Traded in',
  pre_tracking: 'Existing collection',
  other: 'Other',
  found: 'Found',
}

export const FINISH_LABEL: Record<string, string> = {
  normal: 'Normal',
  holo: 'Holo',
  reverse: 'Reverse holo',
  other: 'Other',
}

/** M9 provenance labels (prompt §81) — factual attribution, never "Official Cardmarket API". */
export const PROVIDER_LABEL: Record<string, string> = {
  tcgdex_cardmarket: 'Cardmarket, via TCGdex',
  tcgdex_tcgplayer: 'TCGplayer, via TCGdex',
}

export const PRICE_KIND_LABEL: Record<string, string> = {
  cm_trend: 'Trend',
  cm_avg30: '30-day average',
  cm_avg7: '7-day average',
  cm_avg: 'Average',
  tp_market: 'Market price',
}
