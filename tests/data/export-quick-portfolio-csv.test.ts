import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthIdentityChangedError,
  IdentityAuthority,
  type IdentityLease,
} from '../../src/auth/identity-lease'
import type { LeasedDb } from '../../src/data/leased-client'
import { parseCsvRfc } from './csv-rfc-parser'

/**
 * P157 — the Portfolio Quick CSV (P130-21), driven through the REAL `buildPortfolioCsv` with the
 * network edge (`listPortfolio`, the Supabase auth client) replaced. Everything from mapping to
 * bytes — the shared writer included — is production code.
 */

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

interface FakeTile {
  holdingId: string
  holdingKind: string
  cardName: string | null
  cardSetName: string | null
  cardLocalId: string | null
  manualSetName: string | null
  manualCollectorNumber: string | null
  quantity: number
  condition: string | null
  grader: string | null
  grade: number | null
  variantFinish: string | null
  variantSubtype: string | null
  variantStamp: string | null
  hasMultipleStorageLocations: boolean
  unitValueMinor: bigint | null
  holdingValueMinor: bigint | null
}

interface World {
  listCalls: number
  onList: ((call: number) => void) | null
  listImpl: ((call: number) => unknown) | null
}

const world = vi.hoisted((): World => ({
  listCalls: 0,
  onList: null,
  listImpl: null,
}))

vi.mock('../../src/data/portfolio', () => ({
  portfolioDisplayName: (t: { cardName: string | null }) => t.cardName ?? 'Unknown item',
  listPortfolio: () => {
    world.listCalls++
    world.onList?.(world.listCalls)
    if (world.listImpl === null) throw new Error('listImpl not set')
    return Promise.resolve(world.listImpl(world.listCalls))
  },
}))

function tile(overrides: Partial<FakeTile> = {}): FakeTile {
  return {
    holdingId: `h-${String(Math.random())}`,
    holdingKind: 'raw_card',
    cardName: 'Pikachu',
    cardSetName: 'Base Set',
    cardLocalId: '58',
    manualSetName: null,
    manualCollectorNumber: null,
    quantity: 1,
    condition: null,
    grader: null,
    grade: null,
    variantFinish: null,
    variantSubtype: null,
    variantStamp: null,
    hasMultipleStorageLocations: false,
    unitValueMinor: null,
    holdingValueMinor: null,
    ...overrides,
  }
}

function serve(pages: FakeTile[][]): void {
  world.listImpl = (call) => {
    const index = call - 1
    const results = pages[index] ?? []
    const more = index < pages.length - 1
    return { results, nextCursor: more ? { holdingId: `cursor-${String(index)}` } : null }
  }
}

// The tab's identity for these tests: the real authority and lease of the app, and a client that
// carries only that lease (the export reads its identity from the client it is handed).
let authority: IdentityAuthority
let lease: IdentityLease

function leasedStub(): LeasedDb {
  return { identityLease: lease } as unknown as LeasedDb
}

async function build(signal?: AbortSignal): Promise<string> {
  const { buildPortfolioCsv } = await import('../../src/data/portfolioExport')
  return buildPortfolioCsv(undefined, leasedStub(), signal ? { signal } : {})
}

beforeEach(() => {
  authority = new IdentityAuthority()
  authority.observe(USER_A)
  lease = authority.begin(USER_A)
  world.listCalls = 0
  world.onList = null
  world.listImpl = null
})

describe('Quick CSV — formula and structure safety', () => {
  const hostile = [
    '=1+1',
    '+SUM(1,2)',
    '-1+2',
    '@SUM(A1:A2)',
    '\t=1+1',
    ' =1+1',
    '=HYPERLINK("inert-marker","x")',
    'has,comma',
    'has"quote',
    'multi\nline',
    'cr\rinside',
    'Header,Row\r\nCard name',
  ]

  it('no name can become a formula, add a row or shift a column', async () => {
    serve([hostile.map((cardName, i) => tile({ holdingId: `h${String(i)}`, cardName }))])
    const parsed = parseCsvRfc(await build())
    expect(parsed.records).toHaveLength(hostile.length + 1) // header + one record per holding
    for (const record of parsed.records) expect(record).toHaveLength(10)
    for (const [i, name] of hostile.entries()) {
      const cell = parsed.records[i + 1]?.[0] ?? ''
      const startsFormula = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(cell) && !cell.startsWith("'")
      expect(startsFormula, name).toBe(false)
      // Lossless apart from the documented apostrophe.
      expect(cell === name || cell === `'${name}`).toBe(true)
    }
  })

  it('carries a BOM, CRLF framing and a terminating CRLF (Excel + Japanese card names)', async () => {
    serve([[tile({ cardName: 'ピカチュウ' })]])
    const csv = await build()
    const parsed = parseCsvRfc(csv)
    expect(parsed.hadBom).toBe(true)
    expect(parsed.endsWithCrlf).toBe(true)
    expect(parsed.records[1]?.[0]).toBe('ピカチュウ')
  })

  it('labels the value-state column honestly (it never held a cost basis)', async () => {
    serve([[tile({ holdingKind: 'graded_card', unitValueMinor: null })]])
    const parsed = parseCsvRfc(await build())
    expect(parsed.records[0]).toEqual([
      'Card name',
      'Set',
      'Collector number',
      'Quantity',
      'Condition',
      'Variant',
      'Grade',
      'Storage',
      'Value status',
      'Current value (NOK)',
    ])
    expect(parsed.records[1]?.[8]).toBe('No manual value set')
  })
})

describe('Quick CSV — exact money, unknown vs zero', () => {
  it('writes a value past 2^53 digit for digit (the released code wrote ...92)', async () => {
    serve([[tile({ holdingValueMinor: 9007199254740993n })]])
    expect((await parse())[1]?.[9]).toBe('90071992547409.93')
  })

  it('bigint max and a negative-free small value render exactly', async () => {
    serve([
      [
        tile({ holdingId: 'a', holdingValueMinor: 9223372036854775807n }),
        tile({ holdingId: 'b', holdingValueMinor: 12345n }),
      ],
    ])
    const records = await parse()
    expect(records[1]?.[9]).toBe('92233720368547758.07')
    expect(records[2]?.[9]).toBe('123.45')
  })

  it('an unresolved value is an empty cell; a resolved zero is 0.00', async () => {
    serve([
      [
        tile({ holdingId: 'a', holdingValueMinor: null }),
        tile({ holdingId: 'b', holdingValueMinor: 0n }),
      ],
    ])
    const records = await parse()
    expect(records[1]?.[9]).toBe('')
    expect(records[2]?.[9]).toBe('0.00')
  })

  async function parse(): Promise<string[][]> {
    return parseCsvRfc(await build()).records
  }
})

describe('Quick CSV — complete or nothing', () => {
  it('walks every page and returns each holding once', async () => {
    const pages = [0, 1, 2].map((p) =>
      [0, 1].map((i) =>
        tile({ holdingId: `h${String(p)}${String(i)}`, cardName: `C${String(p)}${String(i)}` }),
      ),
    )
    serve(pages)
    const records = parseCsvRfc(await build()).records
    expect(records.slice(1).map((r) => r[0])).toEqual(['C00', 'C01', 'C10', 'C11', 'C20', 'C21'])
    expect(world.listCalls).toBe(3)
  })

  it('hitting the page ceiling with a cursor still pending is an ERROR, not a truncated file', async () => {
    world.listImpl = () => ({
      results: [tile({ holdingId: `h${String(world.listCalls)}` })],
      nextCursor: { holdingId: 'more' },
    })
    await expect(build()).rejects.toThrow(/nothing was saved/)
    expect(world.listCalls).toBe(500)
  })

  it('a page that fails mid-export rejects — no partial file is ever returned', async () => {
    world.listImpl = (call) => {
      if (call === 3) throw new Error('network down')
      return { results: [tile({ holdingId: `h${String(call)}` })], nextCursor: { holdingId: 'x' } }
    }
    await expect(build()).rejects.toThrow('network down')
  })

  it('honours an abort signal between pages', async () => {
    const controller = new AbortController()
    world.onList = (call) => {
      if (call === 2) controller.abort()
    }
    world.listImpl = (call) => ({
      results: [tile({ holdingId: `h${String(call)}` })],
      nextCursor: { holdingId: 'x' },
    })
    await expect(build(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(world.listCalls).toBe(2)
  })

  it('an already-aborted signal never issues a request', async () => {
    const controller = new AbortController()
    controller.abort()
    serve([[tile()]])
    await expect(build(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(world.listCalls).toBe(0)
  })
})

describe('Quick CSV — account isolation (identity lease)', () => {
  it('A→B during pagination discards the export (B rows never reach the file)', async () => {
    world.onList = (call) => {
      if (call === 2) authority.observe(USER_B) // the switch lands while page 2 is in flight
    }
    world.listImpl = (call) => ({
      results: [
        tile({
          holdingId: `h${String(call)}`,
          cardName: authority.userId === USER_B ? 'B-PRIVATE-CARD' : 'A-card',
        }),
      ],
      nextCursor: { holdingId: 'x' },
    })
    const outcome = await build().then(
      (csv) => ({ csv }),
      (error: unknown) => ({ error }),
    )
    expect('csv' in outcome).toBe(false)
    expect((outcome as { error: unknown }).error).toBeInstanceOf(AuthIdentityChangedError)
    expect(world.listCalls).toBe(2) // nothing was requested after the switch was observed
  })

  it('A→B→A is an identity change although the old user id is back', async () => {
    world.onList = (call) => {
      if (call === 2) {
        authority.observe(USER_B)
        authority.observe(USER_A)
      }
    }
    world.listImpl = (call) => ({
      results: [tile({ holdingId: `h${String(call)}` })],
      nextCursor: { holdingId: 'x' },
    })
    expect(authority.userId).toBe(USER_A)
    await expect(build()).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(world.listCalls).toBe(2)
  })

  it('sign-out mid-export fails instead of finishing anonymously', async () => {
    world.onList = (call) => {
      if (call === 2) authority.observe(null)
    }
    world.listImpl = (call) => ({
      results: [tile({ holdingId: `h${String(call)}` })],
      nextCursor: { holdingId: 'x' },
    })
    await expect(build()).rejects.toBeInstanceOf(AuthIdentityChangedError)
  })

  it('same-user auth events (token refresh) do not end the export', async () => {
    world.onList = () => {
      expect(authority.observe(USER_A)).toBe(false) // TOKEN_REFRESHED / USER_UPDATED / SIGNED_IN
    }
    world.listImpl = (call) => ({
      results: [tile({ holdingId: `h${String(call)}` })],
      nextCursor: call < 3 ? { holdingId: 'x' } : null,
    })
    const csv = parseCsvRfc(await build())
    expect(csv.records).toHaveLength(4) // header + three pages of one holding
  })

  it('a lease that is already dead issues no request', async () => {
    authority.observe(USER_B)
    serve([[tile()]])
    await expect(build()).rejects.toBeInstanceOf(AuthIdentityChangedError)
    expect(world.listCalls).toBe(0)
  })

  it('a page that returns after the lease ended is dropped, not kept', async () => {
    world.listImpl = () => {
      authority.observe(USER_B) // ends while the single page request is in flight
      return { results: [tile({ cardName: 'A-card' })], nextCursor: null }
    }
    await expect(build()).rejects.toBeInstanceOf(AuthIdentityChangedError)
  })
})
