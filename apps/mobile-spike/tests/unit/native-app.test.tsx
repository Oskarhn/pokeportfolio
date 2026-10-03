import { createNavigationContainerRef } from '@react-navigation/native'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { AppRoot } from '../../src/ui/AppRoot'
import type { TabParams } from '../../src/ui/navigation-types'
import { detail, flush, harness, row, session, type Harness } from '../support/fakes'
import { body, card, hit, obs, p169Harness, variant } from '../support/p169-fakes'

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
    // The total may wrap: its visible text breaks only between digit groups (P167 F4), while what a
    // screen reader announces is the exact formatted amount.
    const exactTotal = `8${NB}917${NB}127${NB}262${NB}195${NB}456,87 kr`
    const total = await screen.findByTestId('collection-total')
    expect(total.props.accessibilityLabel).toBe(exactTotal)
    expect(await text('collection-total')).toContain(exactTotal.replace(/[\u00A0\u202F]/g, ' '))
    expect(await text('collection-total')).not.toMatch(/[\u00A0\u202F]/)
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

  it('Check price opens the card screen for exactly that printing, read-only, and Back returns to the card', async () => {
    const h = p169Harness()
    const twin = card('fixture-card-twin', { name: 'Twin Card', collectorNumber: '007' })
    const holo = variant('fixture-variant-twin-holo', { finish: 'holo' })
    const normal = variant('fixture-variant-twin-normal', { finish: 'normal' })
    h.cards.set(twin.cardId, { card: twin, variants: [normal, holo] })
    h.invoker.answer(twin.cardId, body({ [holo.variantId]: [obs('tcgdex_cardmarket', '98765')] }))
    const { navigationRef } = await toDetail(h)
    await fireEvent.press(screen.getByTestId('check-price'))
    // The card is resolved from the holding's PRINTING, and that printing (holo, not normal) is the
    // confirmed one: the person is not asked to choose again for a card they own.
    expect(await screen.findByTestId('p169-printing-confirmed')).toBeTruthy()
    expect(screen.queryByTestId('p169-printing-choice')).toBeNull()
    expect(await screen.findByTestId('p169-obs-tcgdex_cardmarket')).toBeTruthy()
    expect(screen.getByTestId('p169-obs-tcgdex_cardmarket-source').props.children).toBe('€987.65')
    expect(screen.queryByTestId('p169-obs-tcgdex_tcgplayer')).toBeNull() // the holo printing has no TCGplayer row
    expect(screen.getByText(/No verified graded market data available/)).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(1)
    const root0 = navigationRef.getRootState()
    expect(root0?.routes[root0.index]?.name).toBe('SearchTab')

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
    const h = p169Harness()
    const twin = card('fixture-card-twin')
    const holo = variant('fixture-variant-twin-holo', { finish: 'holo' })
    h.cards.set(twin.cardId, { card: twin, variants: [holo] })
    h.invoker.answer(twin.cardId, body({ [holo.variantId]: [obs('tcgdex_cardmarket', '98765')] }))
    await toDetail(h)
    const callsBefore = h.collection.listCalls.length
    await fireEvent.press(screen.getByTestId('check-price'))
    await screen.findByTestId('p169-obs-tcgdex_cardmarket')
    expect(h.collection.listCalls.length).toBe(callsBefore)
  })

  it('a printing that is not in the catalog is "card not found", never a guessed card', async () => {
    const h = p169Harness()
    await toDetail(h) // the fixture port resolves the printing, but the card cannot be read
    await fireEvent.press(screen.getByTestId('check-price'))
    expect(await screen.findByTestId('p169-card-not-found')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(0)
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

describe('search and price check tabs', () => {
  const PIKA_A = card('pika-a', {
    name: 'P170 Pikachu',
    setName: 'P170 Base',
    collectorNumber: '025',
  })
  const PIKA_B = card('pika-b', {
    name: 'P170 Pikachu',
    setName: 'P170 Reprint',
    collectorNumber: '025',
  })
  const NORMAL = variant('pika-a-normal', { finish: 'normal' })
  const REVERSE = variant('pika-a-reverse', { finish: 'reverse' })

  async function openSearch(h: ReturnType<typeof p169Harness>) {
    h.catalog.corpus = [
      hit('pika-a', {
        name: 'P170 Pikachu',
        setName: 'P170 Base',
        collectorNumber: '025',
        activeVariantCount: 2,
      }),
      hit('pika-b', { name: 'P170 Pikachu', setName: 'P170 Reprint', collectorNumber: '025' }),
    ]
    h.cards.set(PIKA_A.cardId, { card: PIKA_A, variants: [NORMAL, REVERSE] })
    h.cards.set(PIKA_B.cardId, { card: PIKA_B, variants: [variant('pika-b-normal')] })
    const m = await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-search'))
    return m
  }
  async function search(text: string) {
    await act(async () => {
      await fireEvent.changeText(await screen.findByTestId('p169-search-input'), text)
      await flush(10)
    })
  }

  it('the Search tab is real catalog search: same-name cards are flagged, nothing is selected, several printings need a choice and no price is requested before it', async () => {
    const h = p169Harness()
    await openSearch(h)
    await search('Pikachu')
    expect(await screen.findByTestId('p169-hit-pika-a')).toBeTruthy()
    expect(screen.getByTestId('p169-hit-shared-pika-a')).toBeTruthy()
    expect(screen.getByTestId('p169-hit-shared-pika-b')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(0) // searching never prices anything

    await fireEvent.press(screen.getByTestId('p169-hit-pika-a'))
    expect(await screen.findByTestId('p169-printing-choice')).toBeTruthy()
    expect(screen.queryByTestId('p169-obs-tcgdex_cardmarket')).toBeNull()
    expect(h.invoker.calls).toHaveLength(0) // ... and neither does opening a card with several printings

    h.invoker.answer(
      PIKA_A.cardId,
      body({ [REVERSE.variantId]: [obs('tcgdex_cardmarket', '420')] }),
    )
    await act(async () => {
      await fireEvent.press(screen.getByTestId('p169-variant-pika-a-reverse'))
      await flush(10)
    })
    expect(await screen.findByTestId('p169-obs-tcgdex_cardmarket')).toBeTruthy()
    expect(screen.getByTestId('p169-obs-tcgdex_cardmarket-source').props.children).toBe('€4.20')
    expect(h.invoker.calls).toHaveLength(1)
  })

  it('the Price Check tab is a read-only landing that opens search and the photo entry', async () => {
    const h = p169Harness()
    await mount(h)
    await signInAs(h, 'A')
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    expect(await screen.findByTestId('price-check-read-only')).toBeTruthy()
    expect(screen.getByTestId('pc-home-photo-note').props.children).toBe(
      'A photo does not currently identify the card automatically.',
    )

    await fireEvent.press(screen.getByTestId('pc-home-photo'))
    expect(await screen.findByTestId('p169-photo-entry')).toBeTruthy()
    expect(screen.getByTestId('p169-recognition-unavailable')).toBeTruthy()
    expect(
      screen.getByText(/A photo does not currently identify the card automatically/),
    ).toBeTruthy()
    // "Choose the card manually" ends in the search screen.
    await fireEvent.press(screen.getByTestId('p169-choose-manually'))
    expect(await screen.findByTestId('p169-search')).toBeTruthy()

    await fireEvent.press(screen.getByTestId('tab-pricecheck'))
    await fireEvent.press(await screen.findByTestId('pc-home-search'))
    expect(await screen.findByTestId('p169-search')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(0)
  })

  it('the typed query and results survive leaving the tab and a token refresh; A -> B starts empty', async () => {
    const h = p169Harness()
    await openSearch(h)
    await search('Pikachu')
    expect(await screen.findByTestId('p169-hit-pika-a')).toBeTruthy()
    await fireEvent.press(screen.getByTestId('tab-collection'))
    await act(async () => {
      h.auth.emit('TOKEN_REFRESHED', session('A'))
      await flush()
    })
    await fireEvent.press(screen.getByTestId('tab-search'))
    expect((await screen.findByTestId('p169-search-input')).props.value).toBe('Pikachu')
    expect(screen.getByTestId('p169-hit-pika-a')).toBeTruthy()

    await signInAs(h, 'B')
    await fireEvent.press(await screen.findByTestId('tab-search'))
    expect((await screen.findByTestId('p169-search-input')).props.value).toBe('')
    expect(screen.queryByTestId('p169-hit-pika-a')).toBeNull()
  })

  it('Add to collection is only navigation: opening the hub sends no request and writes nothing (P175)', async () => {
    const h = p169Harness()
    await openSearch(h)
    await search('Pikachu')
    h.invoker.answer(PIKA_B.cardId, body({ 'pika-b-normal': [obs('tcgdex_cardmarket', '3000')] }))
    await fireEvent.press(await screen.findByTestId('p169-hit-pika-b')) // one printing: confirmed
    await act(async () => {
      await flush(10)
    })
    const calls = h.invoker.calls.length
    const listCalls = h.collection.listCalls.length
    await fireEvent.press(await screen.findByTestId('p169-add-to-collection'))
    expect(await screen.findByTestId('p170-add-intent')).toBeTruthy()
    expect(JSON.stringify(screen.getByTestId('p170-add-intent-text').props.children)).toContain(
      'Nothing is saved until you confirm',
    )
    expect(screen.getByTestId('p170-add-intent-card')).toBeTruthy()
    // The two P175 write forms are one navigation away, not reachable by merely opening this hub.
    expect(screen.getByTestId('p175-go-add-acquisition')).toBeTruthy()
    expect(screen.getByTestId('p175-go-record-purchase')).toBeTruthy()
    expect(screen.queryByTestId('p175-add-acquisition')).toBeNull()
    expect(screen.queryByTestId('p175-record-purchase')).toBeNull()
    expect(h.invoker.calls).toHaveLength(calls)
    expect(h.collection.listCalls).toHaveLength(listCalls)
  })

  it('opening the P175 acquisition or purchase form makes no write RPC call (mutation #17)', async () => {
    // h's write client is fakeWriteDbBinder() (tests/support/fakes.ts): any accidental `.rpc()`
    // call on it throws synchronously, so merely reaching either screen proves nothing was sent.
    const h = p169Harness()
    await openSearch(h)
    await search('Pikachu')
    h.invoker.answer(PIKA_B.cardId, body({ 'pika-b-normal': [obs('tcgdex_cardmarket', '3000')] }))
    await fireEvent.press(await screen.findByTestId('p169-hit-pika-b'))
    await act(async () => {
      await flush(10)
    })
    await fireEvent.press(await screen.findByTestId('p169-add-to-collection'))
    await screen.findByTestId('p170-add-intent')

    await fireEvent.press(await screen.findByTestId('p175-go-add-acquisition'))
    expect(await screen.findByTestId('p175-add-acquisition')).toBeTruthy()
    expect(screen.getByTestId('p175-confirm-acquisition')).toBeTruthy() // reachable, not yet pressed
    await act(async () => {
      await flush(10)
    })
    // The store's own status is the precise signal: 'editing' means submit() was never called.
    expect(h.runtime.writeForms.acquisition.getSnapshot().status).toBe('editing')
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
