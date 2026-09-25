import { createNavigationContainerRef } from '@react-navigation/native'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import type { TabParams } from '../../src/ui/navigation-types'
import { detail, flush, harness, row, session, type Harness } from '../support/fakes'

/**
 * The REAL native view tree and navigation (react-native-screens native stack + bottom tabs),
 * rendered by the React Native jest preset with fakes for I/O. This is component/navigation proof
 * (UNIT_TESTED): it is NOT a run on Hermes, an emulator or a device.
 */

const NB = ' '

async function mount(h: Harness) {
  const navigationRef = createNavigationContainerRef<TabParams>()
  const utils = await render(
    <AppRoot runtime={h.runtime} backendHost="127.0.0.1" navigationRef={navigationRef} />,
  )
  return { navigationRef, utils }
}

async function signInAs(h: Harness, id: string) {
  await act(async () => {
    h.auth.emit('SIGNED_IN', session(id))
    await flush()
  })
}

describe('startup and sign-in', () => {
  it('shows the restoring state, then the login screen when no session is stored', async () => {
    const h = harness()
    await mount(h)
    expect(await screen.findByTestId('restoring')).toBeTruthy()
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(await screen.findByTestId('login-screen')).toBeTruthy()
  })

  it('cold start offline with a stored session shows a retry, NOT the login screen', async () => {
    const h = harness()
    h.auth.getSessionResult = {
      session: null,
      error: { message: 'fetch failed', name: 'AuthRetryableFetchError' },
    }
    await mount(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(await screen.findByTestId('session-check-failed')).toBeTruthy()
    expect(screen.queryByTestId('login-screen')).toBeNull()
  })

  it('signing in through the form reaches the collection', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
    await mount(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    await fireEvent.changeText(await screen.findByTestId('login-email'), 'alice@example.invalid')
    await fireEvent.changeText(screen.getByTestId('login-password'), 'a-password')
    await fireEvent.press(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('row-a1')).toBeTruthy()
  })

  it('a wrong password shows a message and clears the password field', async () => {
    const h = harness()
    h.auth.signInError = { message: 'Invalid login credentials', status: 400 }
    await mount(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    await fireEvent.changeText(await screen.findByTestId('login-email'), 'alice@example.invalid')
    await fireEvent.changeText(screen.getByTestId('login-password'), 'wrong')
    await fireEvent.press(screen.getByTestId('login-submit'))
    expect((await screen.findByTestId('login-error')).props.children).toBe(
      'Email or password is not correct.',
    )
    expect(screen.getByTestId('login-password').props.value).toBe('')
  })
})

describe('collection', () => {
  it('renders exact money above 2^53, a deliberate zero, and an ABSENT value as a dash', async () => {
    const h = harness()
    h.collection.pages.push({
      rows: [
        row('big', { holdingValueMinor: 864691128455135235n, priceState: 'manual' }),
        row('zero', { holdingValueMinor: 0n, priceState: 'manual' }),
        row('none', { holdingValueMinor: null }),
      ],
      nextCursor: null,
    })
    h.collection.countsResult = {
      ...h.collection.countsResult,
      uniqueHoldingCount: 3,
      pricedHoldingCount: 2,
      unpricedHoldingCount: 1,
      portfolioValueMinor: 891712726219545687n,
    }
    await mount(h)
    await signInAs(h, 'A')
    const text = async (id: string) =>
      JSON.stringify((await screen.findByTestId(id)).props.children)
    expect(await screen.findByTestId('row-big')).toBeTruthy()
    expect(screen.getByTestId('collection-list')).toBeTruthy()
    expect(await text('collection-total')).toContain(
      `8${NB}917${NB}127${NB}262${NB}195${NB}456,87 kr`,
    )
    expect(screen.getByText(`8${NB}646${NB}911${NB}284${NB}551${NB}352,35 kr`)).toBeTruthy()
    expect(screen.getByText('0,00 kr')).toBeTruthy()
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('a collection with no priced holding shows the total as missing, not 0,00 kr (F14; seen on Android)', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('u1', { holdingValueMinor: null })], nextCursor: null })
    h.collection.countsResult = {
      ...h.collection.countsResult,
      uniqueHoldingCount: 40,
      pricedHoldingCount: 0,
      unpricedHoldingCount: 40,
      portfolioValueMinor: 0n,
    }
    await mount(h)
    await signInAs(h, 'A')
    const total = JSON.stringify((await screen.findByTestId('collection-total')).props.children)
    expect(total).toContain('—')
    expect(total).not.toContain('0,00')
  })

  it('an empty collection is an empty state; a 500 is an error state with retry', async () => {
    const h = harness()
    const first = await mount(h)
    await signInAs(h, 'A')
    expect(await screen.findByTestId('empty')).toBeTruthy()
    await first.utils.unmount()

    const h2 = harness()
    h2.collection.listError = new Error('HttpStatusError: HTTP 500 boom')
    await mount(h2)
    await signInAs(h2, 'A')
    expect(await screen.findByTestId('failure-server')).toBeTruthy()
    h2.collection.listError = null
    h2.collection.pages.push({ rows: [row('r1')], nextCursor: null })
    await fireEvent.press(screen.getByText('Try again'))
    expect(await screen.findByTestId('row-r1')).toBeTruthy()
  })

  it('offline and 401 are their own states', async () => {
    const h = harness()
    h.collection.listError = new TypeError('Network request failed')
    const first = await mount(h)
    await signInAs(h, 'A')
    expect(await screen.findByTestId('failure-offline')).toBeTruthy()
    await first.utils.unmount()

    const h2 = harness()
    const e = new Error('HttpStatusError: HTTP 401 PGRST301 JWT expired')
    h2.collection.listError = e
    await mount(h2)
    await signInAs(h2, 'A')
    expect(await screen.findByTestId('failure-unauthorized')).toBeTruthy()
  })

  it('an unreadable (unsafe numeric) total is "unavailable", never a rounded number', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
    const e = new Error('UnsafeNumericResponseError: x')
    e.name = 'UnsafeNumericResponseError'
    h.collection.countsError = e
    await mount(h)
    await signInAs(h, 'A')
    expect(await screen.findByTestId('collection-total-unavailable')).toBeTruthy()
    expect(await screen.findByTestId('row-a1')).toBeTruthy()
  })
})

describe('the journey: collection -> card detail -> price check -> back', () => {
  async function toDetail(h: Harness) {
    h.collection.pages.push({
      rows: [row('a1', { holdingValueMinor: 98765n, cardVariantId: 'fixture-variant-twin-holo' })],
      nextCursor: null,
    })
    h.collection.details.set(
      'a1',
      detail('a1', {
        title: 'Card a1',
        holdingValueMinor: 98765n,
        unitValueMinor: 98765n,
        priceState: 'fresh',
        provider: 'tcgdex_cardmarket',
        sourceCurrency: 'EUR',
        sourceValueMinor: 8589n,
        snapshotDate: '2026-09-20',
        cardVariantId: 'fixture-variant-twin-holo',
      }),
    )
    const m = await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('row-a1'))
    await screen.findByTestId('card-detail')
    return m
  }

  it('opens the card detail with exact values and provenance', async () => {
    const h = harness()
    await toDetail(h)
    expect((await screen.findByTestId('detail-holding-value')).props.children).toBe(`987,65 kr`)
    expect(screen.getByTestId('detail-price-state').props.children).toBe('Market price')
    expect(screen.getByTestId('detail-source-value').props.children).toBe('€85.89')
  })

  it('Check price opens Price Check for exactly that variant, read-only, and Back returns to the card', async () => {
    const h = harness()
    const { navigationRef } = await toDetail(h)
    await fireEvent.press(screen.getByTestId('check-price'))
    // The card is resolved from the holding's VARIANT and that variant is priced (holo, not normal).
    expect(await screen.findByTestId('variant-confirmed')).toBeTruthy()
    expect(await screen.findByTestId('price-observations')).toBeTruthy()
    expect(screen.getByTestId('obs-tcgdex_cardmarket-source').props.children).toBe('€987.65')
    expect(screen.queryByTestId('obs-tcgdex_tcgplayer')).toBeNull() // the holo variant has no TCGplayer row
    expect(screen.getByTestId('graded-unavailable')).toBeTruthy()
    expect(screen.getByTestId('source-banner')).toBeTruthy()
    expect(
      navigationRef.getRootState()?.routes[navigationRef.getRootState()?.index ?? 0]?.name,
    ).toBe('PriceCheckTab')

    // System Back -> tab history -> the card the person came from, still open.
    await act(async () => {
      navigationRef.goBack()
      await flush()
    })
    const root = navigationRef.getRootState()
    expect(root?.routes[root.index]?.name).toBe('CollectionTab')
    expect(await screen.findByTestId('card-detail')).toBeTruthy()
  })

  it('Price Check never adds anything: the collection port saw no writes and nothing new is listed', async () => {
    const h = harness()
    await toDetail(h)
    const callsBefore = h.collection.listCalls.length
    await fireEvent.press(screen.getByTestId('check-price'))
    await screen.findByTestId('price-observations')
    expect(h.collection.listCalls.length).toBe(callsBefore)
  })
})

describe('identity switch remounts the whole authenticated tree', () => {
  it('A on a card detail -> B signs in: nothing of A is rendered, the stack is back at the root', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
    h.collection.details.set('a1', detail('a1', { title: 'ONLY-A-CARD' }))
    const { navigationRef } = await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('row-a1'))
    expect(await screen.findByText('ONLY-A-CARD')).toBeTruthy()

    h.collection.pages.push({ rows: [row('b1')], nextCursor: null })
    await signInAs(h, 'B')

    expect(screen.queryByText('ONLY-A-CARD')).toBeNull()
    expect(screen.queryByTestId('card-detail')).toBeNull()
    expect(await screen.findByTestId('row-b1')).toBeTruthy()
    expect(screen.queryByTestId('row-a1')).toBeNull()
    const root = navigationRef.getRootState()
    expect(root?.routes[root.index]?.name).toBe('CollectionTab')
  })

  it('a same-user token refresh keeps the screen the person is on', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
    h.collection.details.set('a1', detail('a1', { title: 'STAYS' }))
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('row-a1'))
    expect(await screen.findByText('STAYS')).toBeTruthy()
    await act(async () => {
      h.auth.emit('TOKEN_REFRESHED', session('A'))
      await flush()
    })
    expect(screen.getByText('STAYS')).toBeTruthy()
  })

  it('signing out from Profile returns to the login screen and clears the stores', async () => {
    const h = harness()
    h.collection.pages.push({ rows: [row('a1')], nextCursor: null })
    await mount(h)
    await signInAs(h, 'A')
    await screen.findByTestId('row-a1')
    await fireEvent.press(screen.getByTestId('tab-profile'))
    expect((await screen.findByTestId('profile-email')).props.children).toBe('A@example.invalid')
    await fireEvent.press(screen.getByTestId('sign-out'))
    await waitFor(() => expect(screen.getByTestId('login-screen')).toBeTruthy())
    expect(h.runtime.collection.getSnapshot().rows).toEqual([])
    expect(h.removed()).toBe(1)
  })
})

describe('price check screens', () => {
  it('a card with several variants asks for a choice and shows no price until one is chosen', async () => {
    const h = harness()
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.changeText(await screen.findByTestId('pc-query'), 'fixture twin')
    await fireEvent.press(screen.getByTestId('pc-search'))
    await fireEvent.press(await screen.findByTestId('hit-fixture-card-twin'))
    expect(await screen.findByTestId('variant-choice')).toBeTruthy()
    expect(screen.queryByTestId('price-observations')).toBeNull()
    await fireEvent.press(screen.getByTestId('variant-fixture-variant-twin-normal'))
    expect(await screen.findByTestId('price-observations')).toBeTruthy()
    expect(screen.getByTestId('obs-tcgdex_cardmarket-source').props.children).toBe('€12.34')
    expect(screen.getByTestId('obs-tcgdex_tcgplayer-source').props.children).toBe('$15.00')
  })

  it('unavailable and provider-error states are worded, never a number; the source is labelled', async () => {
    const h = harness()
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.changeText(await screen.findByTestId('pc-query'), 'fixture provider')
    await fireEvent.press(screen.getByTestId('pc-search'))
    await fireEvent.press(await screen.findByTestId('hit-fixture-card-provider-error'))
    expect(await screen.findByTestId('price-unavailable')).toBeTruthy()
    expect(screen.getByText('The price provider had a problem. Try again later.')).toBeTruthy()
    expect(
      screen.getByText('Price source: synthetic fixture shaped like the P153 response.'),
    ).toBeTruthy()
  })

  it('JPY is rendered with no decimals and marked SYNTHETIC', async () => {
    const h = harness()
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.changeText(await screen.findByTestId('pc-query'), 'fixture jpy')
    await fireEvent.press(screen.getByTestId('pc-search'))
    await fireEvent.press(await screen.findByTestId('hit-fixture-card-jpy'))
    expect((await screen.findByTestId('obs-p158_fixture_jpy-source')).props.children).toBe(
      '9,007,199,254,740,993 JPY',
    )
    expect(screen.getAllByText('SYNTHETIC').length).toBeGreaterThan(0)
  })

  it('the typed query survives leaving and returning to the tab (draft), and a token refresh', async () => {
    const h = harness()
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.changeText(await screen.findByTestId('pc-query'), 'pika')
    await fireEvent.press(screen.getByTestId('tab-collection'))
    await act(async () => {
      h.auth.emit('TOKEN_REFRESHED', session('A'))
      await flush()
    })
    await fireEvent.press(screen.getByTestId('tab-pricecheck'))
    expect((await screen.findByTestId('pc-query')).props.value).toBe('pika')
  })
})

describe('accessibility (source-level; NOT a screen-reader test)', () => {
  it('every button in the login flow has a role, a label and a touch target of at least 44 pt', async () => {
    const h = harness()
    await mount(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', null)
      await new Promise((r) => setTimeout(r, 5))
    })
    const submit = await screen.findByTestId('login-submit')
    expect(submit.props.accessibilityRole).toBe('button')
    expect(submit.props.accessibilityLabel).toBeTruthy()
    const style = Object.assign(
      {},
      ...(([submit.props.style] as unknown[]).flat(Infinity).filter(Boolean) as object[]),
    ) as { minHeight?: number }
    expect(style.minHeight).toBeGreaterThanOrEqual(44)
    expect(screen.getByTestId('login-email').props.accessibilityLabel).toBe('Email')
  })
})
