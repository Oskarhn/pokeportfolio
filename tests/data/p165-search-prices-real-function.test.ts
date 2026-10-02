import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// pricing.ts / price-check.ts import the app client (needs Vite env); the tests below install a
// real client, built by the app's own factory, in its place.
const holder = vi.hoisted((): { client: unknown } => ({ client: null }))
vi.mock('../../src/data/supabase-client', () => ({
  get supabase() {
    return holder.client
  },
}))

import { convert } from '../../src/domain/fx'
import { fromMinorUnits } from '../../src/domain/money'
import { buildRawSection } from '../../src/domain/price-check/raw-section'
import type { VariantIdentity } from '../../src/domain/price-check/types'
import {
  EXACT_TRANSPORT_REWRITE_HEADER,
  findUnsafeIntegerLiteral,
} from '../../src/data/exact-json-guard'
import { PriceCheckError, fetchCardPriceResponse } from '../../src/data/price-check'
import { searchPrices } from '../../src/data/pricing'
import {
  createAccessTokenSupabaseClient,
  createAppSupabaseClient,
} from '../../src/data/supabase-factory'

/**
 * P165 — independent check of the exact-money transport for `search-prices`, driven by what the
 * function's REAL code puts on the wire, not by hand-written JSON.
 *
 * P164 proved the client half with JSON text it typed itself, and pinned the function half with a
 * test that reads the function's source. Here the function half runs: `scripts/p165/edge-harness`
 * executes supabase/functions/search-prices/index.ts and everything it imports under Deno, with the
 * provider's HTTP answer and the two database reads controlled (see harness.mjs). The response TEXT
 * it produces is inspected before any JSON parser sees it, and is then pushed through real clients
 * built by the app's factory into the real Price Check and legacy pricing consumers.
 *
 * What this is NOT: a call to the live provider or to a deployed function. The Deno-backed tests
 * are skipped, loudly, on a machine without `deno`; the frozen-wire tests at the end run everywhere.
 */

const HARNESS_DIR = resolve(__dirname, '../../scripts/p165/edge-harness')
const FUNCTIONS_DIR = resolve(__dirname, '../../supabase/functions')

const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const withDeno = hasDeno ? describe : describe.skip
if (!hasDeno) {
  console.warn(
    'P165: `deno` is not installed — the tests that execute the real search-prices function are SKIPPED.',
  )
}

const CARD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const V_NORMAL = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001'
const V_REVERSE = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'
const SUPABASE_URL = 'http://127.0.0.1:59998'
const FIXED_NOW = Date.parse('2026-09-25T12:00:00Z')

interface FunctionOutput {
  status: number
  contentType: string | null
  text: string
  providerRequests: string[]
}

interface VariantRow {
  id: string
  finish: string
  tcgdexCardId: string
  stamp?: string
}

function variantRow({ id, finish, tcgdexCardId, stamp }: VariantRow) {
  return {
    id,
    card_id: CARD,
    finish,
    stamp: stamp ?? '',
    subtype: '',
    size: 'standard',
    cards: { id: CARD, tcgdex_card_id: tcgdexCardId, language: 'en' },
  }
}

/** Runs the function's real code once. `provider` maps a TCGdex card id to the provider's answer
 *  (an object, or a STRING sent verbatim so a scenario controls the numeric literals). */
function runFunction(
  rows: VariantRow[],
  provider: Record<string, unknown>,
  { useEuPricing = true, functionsDir = FUNCTIONS_DIR } = {},
): FunctionOutput {
  const dir = mkdtempSync(join(tmpdir(), 'p165-edge-'))
  const scenarioFile = join(dir, 'scenario.json')
  writeFileSync(
    scenarioFile,
    JSON.stringify({
      request: { cardIds: [CARD], useEuPricing },
      variantRows: rows.map(variantRow),
      fx: { EUR: 11.54, USD: 10.5 },
      provider,
    }),
  )
  try {
    const run = spawnSync(
      'deno',
      [
        'run',
        '--no-lock',
        `--import-map=${join(HARNESS_DIR, 'import_map.json')}`,
        '--allow-read',
        '--allow-env',
        join(HARNESS_DIR, 'harness.mjs'),
        functionsDir,
        scenarioFile,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    )
    if (run.status !== 0) throw new Error(`the deno harness failed:\n${run.stderr}`)
    return JSON.parse(run.stdout) as FunctionOutput
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A provider card with ONE normal and ONE reverse variant; Cardmarket card-level pricing. */
function providerCard(id: string, trend: unknown, trendHolo: unknown, tcgplayerNormal?: unknown) {
  return {
    id,
    variants: { normal: true, reverse: true },
    pricing: {
      cardmarket: { updated: '2026-09-20T00:00:00.000Z', trend, 'trend-holo': trendHolo },
      ...(tcgplayerNormal === undefined
        ? {}
        : {
            tcgplayer: {
              updated: '2026-09-20T00:00:00.000Z',
              normal: { marketPrice: tcgplayerNormal },
            },
          }),
    },
  }
}

const TWO_VARIANTS: VariantRow[] = [
  { id: V_NORMAL, finish: 'normal', tcgdexCardId: 'p165-a' },
  { id: V_REVERSE, finish: 'reverse', tcgdexCardId: 'p165-a' },
]

interface WireRow {
  cardVariantId: string
  priceState: string
  provider: string | null
  priceKind: string | null
  sourceCurrency: string | null
  sourceValueMinor: number | null
  valueNokMinor: string | null
  observations?: { provider: string; priceKind: string; valueMinor: string }[]
}

function rowsOf(text: string): WireRow[] {
  return (JSON.parse(text) as { results: WireRow[] }).results
}

const variantIdentity = (variantId: string, finish: 'normal' | 'reverse'): VariantIdentity => ({
  variantId,
  finish,
  stamp: '',
  subtype: '',
  size: 'standard',
  isActive: true,
})

/** A real client built by the app's factory whose network is a fixed body. The reporter records
 *  whether the guard had to rewrite anything. */
function clientReturning(text: string, kind: 'app' | 'access-token' = 'app') {
  const rewrites: string[][] = []
  const baseFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    )
  const transport = { onResponseRewrite: (literals: string[]) => void rewrites.push(literals) }
  const client =
    kind === 'app'
      ? createAppSupabaseClient(SUPABASE_URL, 'publishable-test-key', transport, { baseFetch })
      : createAccessTokenSupabaseClient(
          SUPABASE_URL,
          'publishable-test-key',
          () => Promise.resolve('stub-access-token'),
          transport,
          { baseFetch },
        )
  return { client, rewrites }
}

async function priceCheckFrom(text: string, kind: 'app' | 'access-token' = 'app') {
  const { client, rewrites } = clientReturning(text, kind)
  const response = await fetchCardPriceResponse(CARD, {
    invoke: (name, options) => client.functions.invoke(name, options),
    now: () => FIXED_NOW,
  })
  return { response, rewrites }
}

async function legacyPricesFrom(text: string, kind: 'app' | 'access-token' = 'app') {
  const { client } = clientReturning(text, kind)
  holder.client = client
  return searchPrices([CARD], true)
}

withDeno('the real search-prices function code, executed under Deno (P165)', () => {
  it('ordinary prices: every money value is exact decimal text on the wire, before any parser runs', () => {
    const out = runFunction(TWO_VARIANTS, { 'p165-a': providerCard('p165-a', 7.31, 2.5, 8.05) })
    expect(out.status).toBe(200)
    expect(out.providerRequests).toEqual(['https://api.tcgdex.net/v2/en/cards/p165-a'])

    // Independent of the client's own guard: nothing in the raw text is an unsafe integer, every
    // observation amount and every NOK reference is a JSON STRING, the headline a small number.
    expect(findUnsafeIntegerLiteral(out.text)).toBeNull()
    expect(out.text).not.toMatch(/"valueMinor":(?!")/)
    expect(out.text).not.toMatch(/"valueNokMinor":(?!"|null)/)

    const [normal, reverse] = rowsOf(out.text)
    expect(normal?.cardVariantId).toBe(V_NORMAL)
    // 7.31 EUR, 8.05 USD — chosen by hand, not read back from the function.
    expect(normal?.sourceValueMinor).toBe(731)
    expect(normal?.observations?.map((o) => o.valueMinor)).toEqual(['731', '805'])
    expect(reverse?.sourceValueMinor).toBe(250)
    expect(reverse?.observations?.map((o) => o.valueMinor)).toEqual(['250'])

    // The function's NOK reference agrees with the domain's own conversion (both round half up):
    // 731 x 11.54 = 8435.74 -> 8436, 250 x 11.54 = 2885 exactly.
    expect(normal?.valueNokMinor).toBe(
      convert(fromMinorUnits(731n, 'EUR'), '11.54', 'NOK').minorUnits.toString(),
    )
    expect(normal?.valueNokMinor).toBe('8436')
    expect(reverse?.valueNokMinor).toBe('2885')
  })

  it('an absurd provider price (99999999999999.99 EUR, sent as a bare JSON literal) is ABSENT, not rounded: the variant has no price, its sibling keeps its own', async () => {
    const providerText =
      '{"id":"p165-a","variants":{"normal":true,"reverse":true},"pricing":{"cardmarket":' +
      '{"updated":"2026-09-20T00:00:00.000Z","trend":99999999999999.99,"trend-holo":2.5}}}'
    const out = runFunction(TWO_VARIANTS, { 'p165-a': providerText })
    expect(findUnsafeIntegerLiteral(out.text)).toBeNull()
    expect(out.text).not.toMatch(/[0-9]{16}/)
    const [normal, reverse] = rowsOf(out.text)
    expect(normal).toMatchObject({
      cardVariantId: V_NORMAL,
      priceState: 'missing',
      provider: null,
      sourceValueMinor: null,
      valueNokMinor: null,
    })
    expect(normal?.observations).toEqual([])
    expect(reverse).toMatchObject({ priceState: 'available', sourceValueMinor: 250 })

    // ...and the person sees "no price" for it, and the sibling's exact price.
    const { response } = await priceCheckFrom(out.text)
    const missing = buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section
    expect(missing).toMatchObject({ status: 'unavailable', unavailable: 'no_variant_price' })
    expect(missing.observations).toEqual([])
    const kept = buildRawSection(response, variantIdentity(V_REVERSE, 'reverse')).section
    expect(kept.observations.map((o) => o.price.minorUnits)).toEqual([250n])
  })

  it('the headline number always equals its own observation string, for prices around 2^53 - 1', () => {
    // Provider values straddling the last exactly-representable minor-unit amount. The invariant is
    // stated without knowing which side of the limit each value lands on: whatever the function
    // emits for money must be exact, and the two representations of one price must agree.
    const values = [
      '90071992547409.88',
      '90071992547409.89',
      '90071992547409.9',
      '90071992547409.91',
      '90071992547409.92',
      '90071992547409.93',
      '90071992547409.94',
    ]
    const rows: VariantRow[] = values.map((_, index) => ({
      id: `aaaaaaaa-aaaa-4aaa-8aaa-0000000001${String(index).padStart(2, '0')}`,
      finish: 'normal',
      tcgdexCardId: `p165-edge-${String(index)}`,
    }))
    const provider = Object.fromEntries(
      values.map((value, index) => [
        `p165-edge-${String(index)}`,
        `{"id":"p165-edge-${String(index)}","variants":{"normal":true},"pricing":{"cardmarket":{"updated":"2026-09-20T00:00:00.000Z","trend":${value}}}}`,
      ]),
    )
    const out = runFunction(rows, provider)
    expect(findUnsafeIntegerLiteral(out.text)).toBeNull()
    expect(rowsOf(out.text)).toHaveLength(values.length)
    for (const row of rowsOf(out.text)) {
      if (row.priceState === 'missing') {
        expect(row.sourceValueMinor).toBeNull()
        expect(row.observations).toEqual([])
        continue
      }
      const headline = row.sourceValueMinor
      expect(Number.isSafeInteger(headline)).toBe(true)
      const observation = row.observations?.find(
        (o) => o.provider === row.provider && o.priceKind === row.priceKind,
      )
      expect(observation?.valueMinor).toBe(String(headline))
    }
  })

  it('zero stays zero, and a provider that reports nothing is unknown, never zero', async () => {
    const providerText =
      '{"id":"p165-a","variants":{"normal":true,"reverse":true},"pricing":{"cardmarket":' +
      '{"updated":"2026-09-20T00:00:00.000Z","trend":0,"trend-holo":null,"avg30":null,"avg7":null,"avg":null}}}'
    const out = runFunction(TWO_VARIANTS, { 'p165-a': providerText })
    const [normal, reverse] = rowsOf(out.text)
    expect(normal).toMatchObject({ priceState: 'available', sourceValueMinor: 0 })
    expect(normal?.observations?.map((o) => o.valueMinor)).toEqual(['0'])
    expect(reverse).toMatchObject({ priceState: 'missing', sourceValueMinor: null })
    const { response } = await priceCheckFrom(out.text)
    expect(
      buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section.observations.map(
        (o) => o.price.minorUnits,
      ),
    ).toEqual([0n])
    expect(buildRawSection(response, variantIdentity(V_REVERSE, 'reverse')).section.status).toBe(
      'unavailable',
    )
  })

  it('a negative provider value is never shown as a price', async () => {
    const providerText =
      '{"id":"p165-a","variants":{"normal":true},"pricing":{"cardmarket":' +
      '{"updated":"2026-09-20T00:00:00.000Z","trend":-1.5}}}'
    const out = runFunction([TWO_VARIANTS[0] as VariantRow], { 'p165-a': providerText })
    const { response } = await priceCheckFrom(out.text)
    const section = buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section
    expect(section.observations).toEqual([])
    expect(section.status).toBe('unavailable')
  })

  it('what the function really emitted is read exactly by both real consumers, through both client kinds', async () => {
    const out = runFunction(TWO_VARIANTS, { 'p165-a': providerCard('p165-a', 7.31, 2.5, 8.05) })
    for (const kind of ['app', 'access-token'] as const) {
      const { response, rewrites } = await priceCheckFrom(out.text, kind)
      expect(rewrites, `${kind}: the guard had nothing to rewrite`).toEqual([])
      const section = buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section
      expect(
        section.observations.map((o) => [o.provider, o.price.currency, o.price.minorUnits]),
      ).toEqual([
        ['tcgdex_cardmarket', 'EUR', 731n],
        ['tcgdex_tcgplayer', 'USD', 805n],
      ])
      const legacy = await legacyPricesFrom(out.text, kind)
      expect(legacy.get(V_NORMAL)).toMatchObject({
        sourceCurrency: 'EUR',
        sourceValueMinor: 731n,
        valueNokMinor: 8436n,
      })
      expect(legacy.get(V_REVERSE)).toMatchObject({ sourceValueMinor: 250n, valueNokMinor: 2885n })
    }
  })
})

withDeno('variant and provider mapping, by the real mapper (P165 counterexamples)', () => {
  const at = '2026-09-20T00:00:00.000Z'
  const valuesOf = (row: WireRow | undefined) => row?.observations?.map((o) => o.valueMinor)

  it('two sibling variants of one finish: card-level pricing is ambiguous, so NEITHER gets a price', () => {
    const rows: VariantRow[] = [
      { id: V_NORMAL, finish: 'reverse', stamp: 'pokeball', tcgdexCardId: 'p165-a' },
      { id: V_REVERSE, finish: 'reverse', stamp: 'masterball', tcgdexCardId: 'p165-a' },
    ]
    const out = runFunction(rows, {
      'p165-a': {
        id: 'p165-a',
        variants_detailed: [
          { type: 'reverse', stamp: ['pokeball'] },
          { type: 'reverse', stamp: ['masterball'] },
        ],
        pricing: {
          cardmarket: { updated: at, trend: 9.99, 'trend-holo': 4.44 },
          tcgplayer: { updated: at, 'reverse-holofoil': { marketPrice: 3.2 } },
        },
      },
    })
    for (const row of rowsOf(out.text)) {
      expect(row).toMatchObject({ priceState: 'missing', sourceValueMinor: null })
      expect(row.observations).toEqual([])
    }
  })

  it('a variant with its own embedded price gets it; its sibling never inherits the card-level number', () => {
    const rows: VariantRow[] = [
      { id: V_NORMAL, finish: 'reverse', stamp: 'pokeball', tcgdexCardId: 'p165-a' },
      { id: V_REVERSE, finish: 'reverse', stamp: 'masterball', tcgdexCardId: 'p165-a' },
    ]
    const out = runFunction(rows, {
      'p165-a': {
        id: 'p165-a',
        variants_detailed: [
          {
            type: 'reverse',
            stamp: ['pokeball'],
            pricing: { cardmarket: { updated: at, trend: 1.11 } },
          },
          { type: 'reverse', stamp: ['masterball'] },
        ],
        pricing: { cardmarket: { updated: at, trend: 9.99, 'trend-holo': 4.44 } },
      },
    })
    const [pokeball, masterball] = rowsOf(out.text)
    expect(valuesOf(pokeball)).toEqual(['111'])
    expect(masterball).toMatchObject({ priceState: 'missing', sourceValueMinor: null })
    expect(out.text).not.toContain('999')
    expect(out.text).not.toContain('444')
  })

  it("a holofoil price is never a normal printing's price", () => {
    const out = runFunction([{ id: V_NORMAL, finish: 'normal', tcgdexCardId: 'p165-a' }], {
      'p165-a': {
        id: 'p165-a',
        variants: { normal: true },
        pricing: { tcgplayer: { updated: at, holofoil: { marketPrice: 40 } } },
      },
    })
    expect(rowsOf(out.text)[0]).toMatchObject({ priceState: 'missing', sourceValueMinor: null })
  })

  it('TCGplayer buckets are matched to their own finish: reverse-holofoil is reverse, holofoil is holo', () => {
    const out = runFunction(
      [
        { id: V_NORMAL, finish: 'holo', tcgdexCardId: 'p165-a' },
        { id: V_REVERSE, finish: 'reverse', tcgdexCardId: 'p165-a' },
      ],
      {
        'p165-a': {
          id: 'p165-a',
          variants: { holo: true, reverse: true },
          pricing: {
            // two non-normal finishes: the Cardmarket "-holo" slot cannot be attributed to either
            cardmarket: { updated: at, trend: 7, 'trend-holo': 8 },
            tcgplayer: {
              updated: at,
              holofoil: { marketPrice: 12.5 },
              'reverse-holofoil': { marketPrice: 3.25 },
            },
          },
        },
      },
    )
    const [holo, reverse] = rowsOf(out.text)
    expect(holo?.cardVariantId).toBe(V_NORMAL)
    expect(valuesOf(holo)).toEqual(['1250'])
    expect(valuesOf(reverse)).toEqual(['325'])
  })

  it('two catalog cards in one request: every variant is priced from its OWN provider card', () => {
    const out = runFunction(
      [
        { id: V_NORMAL, finish: 'normal', tcgdexCardId: 'p165-x' },
        { id: V_REVERSE, finish: 'normal', tcgdexCardId: 'p165-y' },
      ],
      {
        'p165-x': {
          id: 'p165-x',
          variants: { normal: true },
          pricing: { cardmarket: { updated: at, trend: 1.11 } },
        },
        'p165-y': {
          id: 'p165-y',
          variants: { normal: true },
          pricing: { cardmarket: { updated: at, trend: 2.22 } },
        },
      },
    )
    const [x, y] = rowsOf(out.text)
    expect([x?.cardVariantId, x?.sourceValueMinor]).toEqual([V_NORMAL, 111])
    expect([y?.cardVariantId, y?.sourceValueMinor]).toEqual([V_REVERSE, 222])
  })

  it('useEuPricing=false prefers TCGplayer for the headline, and the observations still carry both providers', () => {
    const out = runFunction(
      TWO_VARIANTS.slice(0, 1),
      { 'p165-a': providerCard('p165-a', 7.31, 2.5, 8.05) },
      { useEuPricing: false },
    )
    const [normal] = rowsOf(out.text)
    expect(normal).toMatchObject({
      provider: 'tcgdex_tcgplayer',
      sourceCurrency: 'USD',
      sourceValueMinor: 805,
    })
    expect(valuesOf(normal)).toEqual(['731', '805'])
  })
})

/**
 * Frozen wire: the text the RELEASED function (d8682e0) produced for the absurd-price scenario
 * above, captured by running that release's supabase/functions under the same harness. It is the
 * "old function, new frontend" half of the skew, and the reason the rewrite marker exists: the
 * number below is 99999999999999.99 EUR x 100 after `Number(bigint)` — already rounded to
 * ...998 by the producer — and the transport guard would otherwise quote it into a plausible
 * exact-looking string.
 */
const RELEASED_ABSURD_WIRE =
  '{"ok":true,"results":[' +
  `{"cardVariantId":"${V_NORMAL}","cardId":"${CARD}","priceState":"available","provider":"tcgdex_cardmarket","priceKind":"cm_trend","sourceCurrency":"EUR","sourceValueMinor":9999999999999998,"valueNokMinor":"115399999999999977","providerUpdatedAt":"2026-09-20T00:00:00.000Z"},` +
  `{"cardVariantId":"${V_REVERSE}","cardId":"${CARD}","priceState":"available","provider":"tcgdex_cardmarket","priceKind":"cm_trend","sourceCurrency":"EUR","sourceValueMinor":250,"valueNokMinor":"2885","providerUpdatedAt":"2026-09-20T00:00:00.000Z"}` +
  '],"providerErrorCount":0}'

const RELEASED_ORDINARY_WIRE =
  '{"ok":true,"results":[' +
  `{"cardVariantId":"${V_NORMAL}","cardId":"${CARD}","priceState":"available","provider":"tcgdex_cardmarket","priceKind":"cm_trend","sourceCurrency":"EUR","sourceValueMinor":731,"valueNokMinor":"8436","providerUpdatedAt":"2026-09-20T00:00:00.000Z"}` +
  '],"providerErrorCount":0}'

describe('released function -> this frontend (frozen wire, runs everywhere)', () => {
  it('an unsafe headline number is refused by Price Check, whichever client kind carried it', async () => {
    for (const kind of ['app', 'access-token'] as const) {
      await expect(priceCheckFrom(RELEASED_ABSURD_WIRE, kind)).rejects.toMatchObject({
        name: 'PriceCheckError',
        reason: 'malformed_response',
      })
    }
    await expect(priceCheckFrom(RELEASED_ABSURD_WIRE)).rejects.toBeInstanceOf(PriceCheckError)
  })

  it('...and yields no prices at all in the legacy consumer (the sibling row is dropped with it)', async () => {
    for (const kind of ['app', 'access-token'] as const) {
      expect((await legacyPricesFrom(RELEASED_ABSURD_WIRE, kind)).size).toBe(0)
    }
  })

  it('the marker is on the very Response the client hands to the consumer', async () => {
    const { client, rewrites } = clientReturning(RELEASED_ABSURD_WIRE)
    const invoked = await client.functions.invoke('search-prices', {
      body: { cardIds: [CARD], useEuPricing: true },
    })
    expect(rewrites).toEqual([['9999999999999998']])
    expect(invoked.response?.headers.get(EXACT_TRANSPORT_REWRITE_HEADER)).toBe('1')
  })

  it('cloning or re-wrapping the guard Response keeps the marker (a copy is taken before the body is read)', async () => {
    const base: typeof fetch = () =>
      Promise.resolve(
        new Response(RELEASED_ABSURD_WIRE, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const { createExactTransportFetch } = await import('../../src/data/exact-json-guard')
    const response = await createExactTransportFetch(base)('http://x.test/search-prices')
    expect(response.clone().headers.get(EXACT_TRANSPORT_REWRITE_HEADER)).toBe('1')
    expect(
      new Response(await response.text(), response).headers.get(EXACT_TRANSPORT_REWRITE_HEADER),
    ).toBe('1')
  })

  it('an ordinary released response still shows its exact single price, marked as headline-only', async () => {
    const { response, rewrites } = await priceCheckFrom(RELEASED_ORDINARY_WIRE)
    expect(rewrites).toEqual([])
    const built = buildRawSection(response, variantIdentity(V_NORMAL, 'normal'))
    expect(built.headlineOnly).toBe(true)
    expect(built.section.observations.map((o) => o.price.minorUnits)).toEqual([731n])
    const legacy = await legacyPricesFrom(RELEASED_ORDINARY_WIRE)
    expect(legacy.get(V_NORMAL)).toMatchObject({ sourceValueMinor: 731n, valueNokMinor: 8436n })
  })
})

describe('a number elsewhere in the response (frozen wire, runs everywhere)', () => {
  const withExtra = (extra: string) =>
    RELEASED_ORDINARY_WIRE.replace('"providerErrorCount":0', `"providerErrorCount":0,${extra}`)

  it('an unsafe literal in an UNRELATED field also refuses the whole response (documented, fail-closed)', async () => {
    const text = withExtra('"requestCounter":12345678901234567890')
    await expect(priceCheckFrom(text)).rejects.toMatchObject({ reason: 'malformed_response' })
    expect((await legacyPricesFrom(text)).size).toBe(0)
  })

  it('a large but SAFE integer elsewhere does not suppress the price', async () => {
    // 16 digits, below 2^53 - 1: the guard must leave it alone.
    const text = withExtra('"requestCounter":4503599627370496')
    const { response, rewrites } = await priceCheckFrom(text)
    expect(rewrites).toEqual([])
    expect(
      buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section.observations,
    ).toHaveLength(1)
    expect((await legacyPricesFrom(text)).get(V_NORMAL)?.sourceValueMinor).toBe(731n)
  })

  it('a value in exponent form is not an integer literal to the guard, and no consumer accepts it as a price', async () => {
    // JSON.stringify writes a JS number >= 1e21 like this. The guard's scope is integer literals;
    // the consumers' grammar (Price Check: decimal string only; legacy: safe integer only) is what
    // keeps such a value from being shown.
    const text = RELEASED_ORDINARY_WIRE.replace(
      '"sourceValueMinor":731',
      '"sourceValueMinor":1.5e+21',
    )
    expect(findUnsafeIntegerLiteral(text)).toBeNull()
    const { response } = await priceCheckFrom(text)
    expect(
      buildRawSection(response, variantIdentity(V_NORMAL, 'normal')).section.observations,
    ).toEqual([])
    expect((await legacyPricesFrom(text)).size).toBe(0)
  })
})

describe('the NOK reference keeps every currency exponent (independent expected values)', () => {
  it.each([
    // [source minor units, source currency, NOK per ONE major unit, expected NOK ore]
    [731n, 'EUR', '11.54', 8436n], // 7.31 x 11.54 = 84.3574 kr
    [805n, 'USD', '10.5', 8453n], // 8.05 x 10.5 = 84.525 kr, half up
    [2599n, 'JPY', '0.061234', 15915n], // JPY has no minor unit: 2599 yen x 0.061234 = 159.147 kr
    [1n, 'JPY', '0.5', 50n], // 1 yen x 0.5 = 0.50 kr = 50 ore, not 0.5 ore
    [0n, 'EUR', '11.54', 0n], // a real zero converts to zero
  ] as const)('%s %s at %s NOK -> %s ore', (minor, currency, rate, expected) => {
    expect(convert(fromMinorUnits(minor, currency), rate, 'NOK').minorUnits).toBe(expected)
  })
})
