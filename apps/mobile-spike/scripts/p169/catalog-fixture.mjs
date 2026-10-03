/**
 * The SYNTHETIC catalog of the P169 stack, shared by the seed script (what the database holds) and
 * the mock TCGdex server (what the "provider" answers), so the two always agree on identity.
 * Nothing here is market data: every name starts with "P169", every set is fictional, every price is
 * an invented number chosen so that one specific mistake becomes visible.
 *
 * Each card exists for a reason:
 *   pika-base-025     same NAME and NUMBER as pika-reprint-025 but another set and other prices:
 *                     catches a price inherited across sets; two ACTIVE variants -> choice required
 *   pika-reprint-025  single active variant (only_variant), distinct price
 *   pika-promo        same name, promo number, one stamped holo; TCGplayer absent (one provider)
 *   zard-base-004     two active holo variants (plain vs 1st-edition stamp) + one INACTIVE normal;
 *                     the plain holo's EUR amount converts to a NOK amount above 2^53
 *   zero-099          provider reports exactly zero (a real 0, never "missing")
 *   unpriced-098      provider knows the card but has no price -> no_variant_price
 *   missing-097       provider 404 -> provider_error (not "no price", not zero)
 *   broken-096        provider 500 -> provider_error
 *   stale-095         Cardmarket 10 days old (stale), TCGplayer 45 days old (outdated)
 *   noid-094          no tcgdex id in the catalog -> no observation at all
 *   slow-093          provider answers after a delay (cancellation / late-result tests)
 *   huge-092          Cardmarket amount whose minor units exceed 2^53: the RELEASED function emits
 *                     it as an unsafe JSON number (refused by the client); the candidate drops it
 *   jp-001            Japanese-language card (language display + filter)
 *   bulk-NNN          pagination volume (name "P169 Bulk NNN")
 */

export const SETS = [
  { slug: 'p169-base', name: 'P169 Base Set', language: 'en' },
  { slug: 'p169-reprint', name: 'P169 Legends Reprint', language: 'en' },
  { slug: 'p169-promo', name: 'P169 Black Star Promos', language: 'en' },
  { slug: 'p169-jp', name: 'P169 Japanese Starter', language: 'ja' },
]

const DAY = 24 * 60 * 60 * 1000
/** Provider "updated" stamps relative to the run, so freshness classes are deterministic. */
export function isoDaysAgo(days, now = Date.now()) {
  return new Date(now - days * DAY).toISOString()
}

/**
 * key: stable fixture key (also the tcgdex id suffix), set: slug, localId, name, variants: catalog
 * rows {finish, stamp, active}, provider: mock TCGdex behaviour.
 */
export const CARDS = [
  {
    key: 'pika-base-025',
    set: 'p169-base',
    localId: '025',
    name: 'P169 Pikachu',
    rarity: 'Common',
    variants: [
      { finish: 'normal', stamp: '', active: true },
      { finish: 'reverse', stamp: '', active: true },
    ],
    provider: {
      prices: {
        'normal|': { cm: 150, tp: 210, cmAgeDays: 0, tpAgeDays: 0 },
        'reverse|': { cm: 420, tp: 500, cmAgeDays: 0, tpAgeDays: 0 },
      },
    },
  },
  {
    key: 'pika-reprint-025',
    set: 'p169-reprint',
    localId: '025',
    name: 'P169 Pikachu',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: { 'normal|': { cm: 30, tp: 45, cmAgeDays: 1, tpAgeDays: 1 } } },
  },
  {
    key: 'pika-promo',
    set: 'p169-promo',
    localId: 'SVP025',
    name: 'P169 Pikachu',
    rarity: 'Promo',
    variants: [{ finish: 'holo', stamp: 'promo', active: true }],
    provider: { prices: { 'holo|promo': { cm: 1200, tp: null, cmAgeDays: 2 } } },
  },
  {
    key: 'zard-base-004',
    set: 'p169-base',
    localId: '004',
    name: 'P169 Charizard',
    rarity: 'Rare Holo',
    variants: [
      { finish: 'holo', stamp: '', active: true },
      { finish: 'holo', stamp: '1st-edition', active: true },
      { finish: 'normal', stamp: '', active: false },
    ],
    provider: {
      prices: {
        // 9 876 543 210 987,65 EUR = 987654321098765 minor units (a safe integer, so the candidate
        // function relays it); x 11.5 NOK/EUR the NOK reference is ~1.1358e16 minor units > 2^53.
        'holo|': { cm: 987654321098765, tp: 1100000, cmAgeDays: 0, tpAgeDays: 0 },
        'holo|1st-edition': { cm: 25000, tp: 30000, cmAgeDays: 0, tpAgeDays: 0 },
      },
    },
  },
  {
    key: 'zero-099',
    set: 'p169-base',
    localId: '099',
    name: 'P169 Zero Energy',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: { 'normal|': { cm: 0, tp: 0, cmAgeDays: 0, tpAgeDays: 0 } } },
  },
  {
    key: 'unpriced-098',
    set: 'p169-base',
    localId: '098',
    name: 'P169 Unpriced Trainer',
    rarity: 'Uncommon',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: {} },
  },
  {
    key: 'missing-097',
    set: 'p169-base',
    localId: '097',
    name: 'P169 Missing Provider',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { status: 404 },
  },
  {
    key: 'broken-096',
    set: 'p169-base',
    localId: '096',
    name: 'P169 Broken Provider',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { status: 500 },
  },
  {
    key: 'stale-095',
    set: 'p169-base',
    localId: '095',
    name: 'P169 Stale Price',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: { 'normal|': { cm: 777, tp: 888, cmAgeDays: 10, tpAgeDays: 45 } } },
  },
  {
    key: 'noid-094',
    set: 'p169-base',
    localId: '094',
    name: 'P169 No Provider Id',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: null,
  },
  {
    key: 'slow-093',
    set: 'p169-base',
    localId: '093',
    name: 'P169 Slow Provider',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: {
      delayMs: 4000,
      prices: { 'normal|': { cm: 999, tp: 1099, cmAgeDays: 0, tpAgeDays: 0 } },
    },
  },
  {
    key: 'huge-092',
    set: 'p169-base',
    localId: '092',
    name: 'P169 Huge Provider Value',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    // 100 000 000 000 000,00 EUR -> 10^16 minor units > 2^53.
    provider: { prices: { 'normal|': { cmRaw: 100000000000000, tp: null, cmAgeDays: 0 } } },
  },
  {
    key: 'jp-001',
    set: 'p169-jp',
    localId: '001',
    name: 'P169 Pikachu JP',
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: { 'normal|': { cm: 60, tp: null, cmAgeDays: 0 } } },
  },
]

export const BULK_COUNT = 120
for (let i = 1; i <= BULK_COUNT; i += 1) {
  const n = String(i).padStart(3, '0')
  CARDS.push({
    key: `bulk-${n}`,
    set: 'p169-base',
    localId: `B${n}`,
    name: `P169 Bulk ${n}`,
    rarity: 'Common',
    variants: [{ finish: 'normal', stamp: '', active: true }],
    provider: { prices: { 'normal|': { cm: 100 + i, tp: null, cmAgeDays: 0 } } },
  })
}

export const tcgdexId = (card) => (card.provider === null ? null : `p169-${card.key}`)

const TP_BUCKET = { normal: 'normal', reverse: 'reverse-holofoil', holo: 'holofoil' }

/** The TCGdex card-detail payload for one card (the shape _shared/tcgdex.ts parses). */
export function tcgdexPayload(card, now = Date.now()) {
  const variantsDetailed = card.variants
    .filter((v) => v.active)
    .map((v) => {
      const price = card.provider?.prices?.[`${v.finish}|${v.stamp}`]
      const entry = { type: v.finish, stamp: v.stamp === '' ? [] : [v.stamp] }
      if (price !== undefined) {
        const cardmarket =
          price.cmRaw !== undefined
            ? { trend: price.cmRaw, updated: isoDaysAgo(price.cmAgeDays ?? 0, now) }
            : price.cm === null || price.cm === undefined
              ? null
              : { trend: price.cm / 100, updated: isoDaysAgo(price.cmAgeDays ?? 0, now) }
        const tcgplayer =
          price.tp === null || price.tp === undefined
            ? null
            : {
                updated: isoDaysAgo(price.tpAgeDays ?? 0, now),
                [TP_BUCKET[v.finish]]: { marketPrice: price.tp / 100 },
              }
        entry.pricing = { cardmarket, tcgplayer }
      }
      return entry
    })
  return {
    id: tcgdexId(card),
    localId: card.localId,
    name: card.name,
    variants_detailed: variantsDetailed,
  }
}
