import { createElement, type FunctionComponent, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

// MoneyDisplay -> data/fx and the portfolio views -> data/portfolio reach the real Supabase client,
// which refuses to start unconfigured. Rendering needs none of it.
vi.mock('../../src/data/supabase-client', () => ({ supabase: {} }))

const { MoneyDisplay } = await import('../../src/ui/MoneyDisplay')
const { perCopyCaption } = await import('../../src/features/collection/value-caption')
const { PriceStateMark } = await import('../../src/ui/PriceStateMark')
const { PortfolioTableView } = await import('../../src/features/portfolio/ListAndTableViews')

function render<P extends object>(node: (props: P) => ReactNode, props: P) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(node as FunctionComponent<P>, props),
    ),
  )
}

describe('MoneyDisplay never turns an absent amount into a zero (DESIGN_SYSTEM section 7, M1)', () => {
  it('state "known" without an amount renders the missing mark, not 0,00', () => {
    const html = render(MoneyDisplay, { state: 'known' })
    expect(html).toContain('—')
    expect(html).not.toMatch(/0,00/)
  })

  it('a genuine zero is a real answer and stays visible', () => {
    const html = render(MoneyDisplay, { state: 'known', minorUnits: 0n })
    expect(html).toContain('0,00')
    expect(html).not.toContain('—')
  })

  it('state "missing" is the missing mark even if an amount is supplied', () => {
    const html = render(MoneyDisplay, { state: 'missing', minorUnits: 12345n })
    expect(html).toContain('—')
    expect(html).not.toContain('123,45')
  })

  it('a known amount masks under hide-values and still marks staleness textually', () => {
    expect(render(MoneyDisplay, { state: 'known', minorUnits: 5000n, hidden: true })).toContain(
      '••••',
    )
    const stale = render(MoneyDisplay, { state: 'known', minorUnits: 5000n, stale: true })
    expect(stale).toContain('stale')
  })
})

describe('perCopyCaption: the "per card x quantity" caption only exists for a known unit value', () => {
  it('is null when the unit value is unknown or not loaded (never "0,00 NOK / card")', () => {
    expect(perCopyCaption(null, 3)).toBeNull()
    expect(perCopyCaption(undefined, 3)).toBeNull() // provenance query failed or still pending
  })

  it('is null for a single copy (the total is the unit value)', () => {
    expect(perCopyCaption(1250n, 1)).toBeNull()
  })

  it('formats a known value, including a genuine zero', () => {
    expect(perCopyCaption(1250n, 3)).toBe('12,50 NOK / card × 3')
    expect(perCopyCaption(0n, 2)).toBe('0,00 NOK / card × 2')
  })
})

describe('PriceStateMark: staleness and absence have a text alternative, not just a dot or a title', () => {
  it('stale: visible marker plus screen-reader text with the 4-30 day definition', () => {
    const html = render(PriceStateMark, { state: 'stale' })
    expect(html).toContain('sr-only')
    expect(html).toMatch(/4.30 days old/)
  })

  it('fresh and manual render nothing', () => {
    expect(render(PriceStateMark, { state: 'fresh' })).toBe('')
    expect(render(PriceStateMark, { state: 'manual' })).toBe('')
  })

  it('missing: screen-reader text says there is no price, the visible mark stays the em dash', () => {
    const html = render(PriceStateMark, { state: 'missing' })
    expect(html).toContain('—')
    expect(html).toMatch(/no price/i)
  })
})

describe('the Portfolio table keeps table semantics under virtualisation', () => {
  it('declares table / columnheader roles with scope, an accessible name and the row count', () => {
    const html = render(PortfolioTableView, {
      tiles: [],
      hasMore: false,
      onEndReached: () => undefined,
    })
    expect(html).toMatch(/<table[^>]*role="table"/)
    expect(html).toMatch(/<table[^>]*aria-label="Portfolio holdings"/)
    expect(html).toMatch(/<table[^>]*aria-rowcount=/)
    expect((html.match(/role="columnheader"/g) ?? []).length).toBe(6)
    expect((html.match(/scope="col"/g) ?? []).length).toBe(6)
    expect(html).toMatch(/<thead[^>]*role="rowgroup"/)
  })
})
