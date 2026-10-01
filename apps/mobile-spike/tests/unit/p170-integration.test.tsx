import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createNavigationContainerRef } from '@react-navigation/native'
import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { createChunkedSessionStorage } from '../../src/auth/chunked-session-storage'
import { createNativeClient } from '../../src/auth/create-client'
import { fxRateReaderFor } from '../../src/features/price-check/fx-source'
import { formatMoney } from '../../src/money/format-money'
import { PriceLookupError } from '../../src/features/price-check/model'
import type { SearchPage } from '../../src/features/catalog-search/catalog-search-port'
import type { PhotoOutcome } from '../../src/photo/photo-store'
import { createFixturePriceCheckPort } from '../../src/price-check/fixture-adapter'
import { createReleasedPriceCheckPort } from '../../src/price-check/released-adapter'
import { AppRoot } from '../../src/ui/AppRoot'
import type { TabParams } from '../../src/ui/navigation-types'
import { restorableNavigationState } from '../../src/state/navigation-memory'
import {
  purchaseExistsCheckerFor,
  saleExistsCheckerFor,
} from '../../src/write/pending-write-exists'
import { PendingWriteJournal } from '../../src/write/pending-write-journal'
import { createRuntime, type Runtime } from '../../src/wiring/runtime'
import { FakeAuth, FakeCollectionPort, FakePhotoPort, MemoryKeyValueStore } from '../support/fakes'
import { deferred, fakeWriteDbBinder, flush, session } from '../support/fakes'
import { FakeCatalog, body, card, hit, obs, p169Harness, variant } from '../support/p169-fakes'
import type { P169Harness } from '../support/p169-fakes'

/**
 * P170: the P167 runtime (identity authority, scoped registry, navigation memory, Activity
 * recreation, photo store) and the P169 Search / Price Check feature, integrated. These tests exist
 * because each track was verified alone: what could break is the SEAM between them. UNIT_TESTED in the
 * React Native jest preset (component/navigation proof, NOT Hermes, NOT a device); the same behaviour
 * is exercised on the emulator by scripts/p170/android-check.mjs.
 */

const appRoot = join(__dirname, '..', '..')
const C = card('c1', { name: 'Card c1', setName: 'Set c1', collectorNumber: '025' })
const V1 = variant('v1', { finish: 'normal' })
const V2 = variant('v2', { finish: 'reverse' })
const PICKED: PhotoOutcome = {
  status: 'picked',
  image: {
    kind: 'local_image',
    uri: 'file:///data/cache/ImagePicker/one.png',
    width: 100,
    height: 140,
    source: 'library',
    acquiredAt: '2026-09-26T10:00:00.000Z',
  },
}

/** Everything a person could have built up under identity A. */
async function primeA(h: P169Harness) {
  h.auth.emit('SIGNED_IN', session('A'))
  h.cards.set(C.cardId, { card: C, variants: [V1, V2] })
  h.catalog.corpus = [hit('c1', { name: 'Card c1', activeVariantCount: 2 })]
  h.invoker.answer(C.cardId, body({ v1: [obs('tcgdex_cardmarket', '1000')] }))
  h.feature.search.setQuery('Card c1')
  await act(async () => {
    await flush(10)
  })
  await h.feature.priceCheck.enter(C.cardId)
  await h.feature.priceCheck.chooseVariant('v1')
  h.photo.outcome = PICKED
  await h.runtime.photo.acquire('library')
}

function snapshots(h: P169Harness) {
  return {
    search: h.feature.search.getSnapshot(),
    flow: h.feature.priceCheck.getSnapshot(),
    photo: h.runtime.photo.getSnapshot(),
  }
}

describe('one identity system', () => {
  it('the feature stores live in the runtime registry (5 shell stores + 3 feature stores + 5 P175 write forms + 1 P180 pending-writes store)', () => {
    const h = p169Harness()
    expect(h.runtime.registry.size).toBe(14)
    expect(h.feature).toBe(h.runtime.feature)
  })

  it('the shell has ONE identity authority, ONE shared Supabase client and ONE feature composition', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.(ts|tsx)$/.test(name)) files.push(path)
      }
    }
    walk(join(appRoot, 'src'))
    const users = (needle: RegExp) =>
      files
        .filter((f) => needle.test(readFileSync(f, 'utf8')))
        .map((f) => relative(appRoot, f).replaceAll('\\', '/'))
    expect(users(/new IdentityAuthority\(/)).toEqual(['src/wiring/runtime.ts'])
    expect(users(/new ScopedRegistry\(/)).toEqual(['src/wiring/runtime.ts'])
    expect(users(/createP169Feature\(/)).toEqual([
      'src/features/feature.ts',
      'src/wiring/runtime.ts',
    ])
    // P175: a second, deliberate `createClient` call site. `leased-write-client.ts` builds an
    // EPHEMERAL client per identity lease for the finance write seam (own accessToken provider,
    // own write-only fetch policy) — never the shared reading client this app has always had one
    // of. The two are structurally distinct (LeasedWriteDb vs the ambient `supabase` singleton).
    expect(users(/\bcreateClient(<[^>(]*>)?\(/)).toEqual([
      'src/auth/create-client.ts',
      'src/write/leased-write-client.ts',
    ])
    expect(users(/(?<!function )\bcreateNativeClient\(/)).toEqual(['src/seam/supabase-client.ts'])
    expect(users(/new AuthController\(/)).toEqual(['src/wiring/runtime.ts'])
  })
})

describe('the identity boundary reaches the feature', () => {
  it('a same-user token refresh keeps the draft, the results, the printing, the price and the photo', async () => {
    const h = p169Harness()
    await primeA(h)
    const before = snapshots(h)
    expect(before.search.query).toBe('Card c1')
    expect(before.search.hits).toHaveLength(1)
    expect(before.flow.resolution?.status).toBe('confirmed')
    expect(before.flow.lookup.status).toBe('ready')
    expect(before.photo.status).toBe('ready')

    await act(async () => {
      h.auth.emit('TOKEN_REFRESHED', session('A'))
      await flush()
    })
    const after = snapshots(h)
    expect(after.search).toBe(before.search)
    expect(after.flow).toBe(before.flow)
    expect(after.photo).toBe(before.photo)
    expect(h.photo.deleted).toEqual([])
  })

  it('A -> B clears the draft, results, card, printing, price, cache and photo SYNCHRONOUSLY', async () => {
    const h = p169Harness()
    await primeA(h)
    const before = h.invoker.calls.length

    h.auth.emit('SIGNED_IN', session('B')) // no await: the reset must not wait for anything
    const s = snapshots(h)
    expect(s.search.query).toBe('')
    expect(s.search.hits).toEqual([])
    expect(s.search.status).toBe('idle')
    expect(s.flow.card.cardId).toBeNull()
    expect(s.flow.card.data).toBeNull()
    expect(s.flow.resolution).toBeNull()
    expect(s.flow.requestedVariantId).toBeNull()
    expect(s.flow.lookup.status).toBe('idle')
    expect(s.flow.lookup.result).toBeNull()
    expect(s.photo.status).toBe('idle')
    expect(s.photo.image).toBeNull()

    // The price cache went with it: B asking for the same card and printing is a NEW request.
    await h.feature.priceCheck.enter(C.cardId)
    await h.feature.priceCheck.chooseVariant('v1')
    expect(h.invoker.calls.length).toBe(before + 1)
    const result = h.feature.priceCheck.getSnapshot().lookup.result
    expect(result?.raw.fromCache).toBe(false)
    await act(async () => {
      await flush(10)
    })
    expect(h.photo.deleted).toEqual([PICKED.status === 'picked' ? PICKED.image.uri : ''])
  })

  it('A -> B -> A does not resurrect anything of the first A session', async () => {
    const h = p169Harness()
    await primeA(h)
    const before = h.invoker.calls.length
    h.auth.emit('SIGNED_IN', session('B'))
    h.auth.emit('SIGNED_IN', session('A'))
    const s = snapshots(h)
    expect(s.search.query).toBe('')
    expect(s.search.hits).toEqual([])
    expect(s.flow.card.cardId).toBeNull()
    expect(s.flow.resolution).toBeNull()
    expect(s.photo.image).toBeNull()
    await h.feature.priceCheck.enter(C.cardId)
    await h.feature.priceCheck.chooseVariant('v1')
    expect(h.invoker.calls.length).toBe(before + 1)
    expect(h.feature.priceCheck.getSnapshot().lookup.result?.raw.fromCache).toBe(false)
  })

  it('signing out clears them too', async () => {
    const h = p169Harness()
    await primeA(h)
    await act(async () => {
      h.auth.emit('SIGNED_OUT', null)
      await flush()
    })
    const s = snapshots(h)
    expect(s.search.query).toBe('')
    expect(s.flow.card.cardId).toBeNull()
    expect(s.photo.image).toBeNull()
  })

  it('a price answer for A that arrives after B signed in is never published', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    h.cards.set(C.cardId, { card: C, variants: [V1, V2] })
    const held = h.invoker.hold()
    await h.feature.priceCheck.enter(C.cardId)
    void h.feature.priceCheck.chooseVariant('v1')
    await act(async () => {
      await flush(10)
    })
    expect(h.feature.priceCheck.getSnapshot().lookup.status).toBe('loading')

    h.auth.emit('SIGNED_IN', session('B'))
    await act(async () => {
      held.resolve({
        data: body({ v1: [obs('tcgdex_cardmarket', '999999')] }),
        error: null,
      })
      await flush(20)
    })
    const flow = h.feature.priceCheck.getSnapshot()
    expect(flow.lookup.status).toBe('idle')
    expect(flow.lookup.result).toBeNull()
    expect(flow.card.cardId).toBeNull()
    expect(h.feature.priceCheck.droppedLate).toBeGreaterThan(0)
  })

  it('a search answer for A that arrives after B signed in is never published', async () => {
    const h = p169Harness()
    h.auth.emit('SIGNED_IN', session('A'))
    const held = deferred<SearchPage>()
    h.catalog.pending.push(held)
    h.feature.search.setQuery('Card c1')
    void h.feature.search.submit()
    h.auth.emit('SIGNED_IN', session('B'))
    await act(async () => {
      held.resolve({ hits: [hit('c1', { name: 'Card c1' })], totalCount: 1 })
      await flush(20)
    })
    const search = h.feature.search.getSnapshot()
    expect(search.hits).toEqual([])
    expect(search.query).toBe('')
    expect(search.status).toBe('idle')
  })
})

describe('Activity recreation with the feature mounted', () => {
  async function mountRoot(h: P169Harness) {
    return render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
  }

  it('a new root reuses the same stores (none are duplicated) and restores the Search tab with its draft', async () => {
    const h = p169Harness()
    h.catalog.corpus = [hit('c1', { name: 'Card c1' })]
    const stores = h.runtime.registry.size
    const first = await mountRoot(h)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-search'))
    await act(async () => {
      await fireEvent.changeText(await screen.findByTestId('p169-search-input'), 'Card c1')
      await flush(10)
    })
    expect(await screen.findByTestId('p169-hit-c1')).toBeTruthy()
    await first.unmount() // the old Activity's root goes away

    const second = await mountRoot(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', session('A'))
      await flush()
    })
    expect(h.runtime.registry.size).toBe(stores)
    expect(h.runtime.feature).toBe(h.feature)
    expect((await screen.findByTestId('p169-search-input')).props.value).toBe('Card c1')
    expect(screen.getByTestId('p169-hit-c1')).toBeTruthy()
    await second.unmount()
  })

  it('a price request in flight survives the recreation and is NOT sent a second time', async () => {
    const h = p169Harness()
    h.cards.set(C.cardId, { card: C, variants: [V1, V2] })
    h.catalog.corpus = [hit('c1', { name: 'Card c1', activeVariantCount: 2 })]
    const first = await mountRoot(h)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-search'))
    await act(async () => {
      await fireEvent.changeText(await screen.findByTestId('p169-search-input'), 'Card c1')
      await flush(10)
    })
    await fireEvent.press(await screen.findByTestId('p169-hit-c1'))
    const held = h.invoker.hold()
    await act(async () => {
      await fireEvent.press(await screen.findByTestId('p169-variant-v1'))
      await flush(10)
    })
    expect(h.invoker.calls).toHaveLength(1)
    expect(h.feature.priceCheck.getSnapshot().lookup.status).toBe('loading')

    await first.unmount()
    // Unmounting is not leaving: the request must still be alive and unaborted.
    expect(h.invoker.calls[0]?.signal?.aborted).toBe(false)
    const second = await mountRoot(h)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', session('A'))
      await flush(10)
    })
    expect(await screen.findByTestId('p169-card')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(1) // adopted, not repeated
    expect(screen.getByTestId('p169-printing-confirmed')).toBeTruthy() // the choice was not forgotten

    await act(async () => {
      held.resolve({ data: body({ v1: [obs('tcgdex_cardmarket', '1000')] }), error: null })
      await flush(20)
    })
    expect(await screen.findByTestId('p169-obs-tcgdex_cardmarket')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(1)
    await second.unmount()
  })

  it('leaving the card for real (Back) cancels the request, and coming back asks for the printing again', async () => {
    const h = p169Harness()
    h.cards.set(C.cardId, { card: C, variants: [V1, V2] })
    h.catalog.corpus = [hit('c1', { name: 'Card c1', activeVariantCount: 2 })]
    const navigationRef = createNavigationContainerRef<TabParams>()
    await render(
      <AppRoot runtime={h.runtime} backendHost="127.0.0.1" navigationRef={navigationRef} />,
    )
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-search'))
    await act(async () => {
      await fireEvent.changeText(await screen.findByTestId('p169-search-input'), 'Card c1')
      await flush(10)
    })
    await fireEvent.press(await screen.findByTestId('p169-hit-c1'))
    h.invoker.hold()
    await act(async () => {
      await fireEvent.press(await screen.findByTestId('p169-variant-v1'))
      await flush(10)
    })
    expect(h.invoker.calls[0]?.signal?.aborted).toBe(false)

    await act(async () => {
      navigationRef.goBack() // pops the card screen: a real exit
      await flush(10)
    })
    expect(h.invoker.calls[0]?.signal?.aborted).toBe(true)
    const flow = h.feature.priceCheck.getSnapshot()
    expect(flow.card.cardId).toBeNull()
    expect(flow.resolution).toBeNull()
    expect(await screen.findByTestId('p169-search')).toBeTruthy()

    await fireEvent.press(await screen.findByTestId('p169-hit-c1'))
    expect(await screen.findByTestId('p169-printing-choice')).toBeTruthy() // asked again
    expect(h.invoker.calls).toHaveLength(1) // and nothing was requested meanwhile
  })
})

describe('photo entry on the integrated shell', () => {
  async function toPhotoEntry(h: P169Harness) {
    const utils = await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.press(await screen.findByTestId('pc-home-photo'))
    await screen.findByTestId('p169-photo-entry')
    return utils
  }

  it('a chosen photo is shown, is not analysed, and is deleted when the person leaves the tab', async () => {
    const h = p169Harness()
    h.photo.outcome = PICKED
    await toPhotoEntry(h)
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    expect(await screen.findByTestId('p169-photo-ready')).toBeTruthy()
    expect(await screen.findByTestId('p169-photo-not-recognised')).toBeTruthy()
    expect(h.invoker.calls).toHaveLength(0) // a photo is never sent anywhere
    expect(h.photo.deleted).toEqual([])
    await fireEvent.press(screen.getByTestId('tab-collection'))
    await act(async () => {
      await flush(10)
    })
    expect(h.photo.deleted).toEqual(['file:///data/cache/ImagePicker/one.png'])
    expect(h.runtime.photo.getSnapshot().image).toBeNull()
  })

  it('the picker keeps working after a recreation of the root (a new acquire on the same store)', async () => {
    const h = p169Harness()
    h.photo.outcome = PICKED
    const acquire = jest.spyOn(h.photo, 'acquire')
    const first = await toPhotoEntry(h)
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    await screen.findByTestId('p169-photo-ready')
    expect(acquire).toHaveBeenCalledTimes(1)
    await first.unmount()

    await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', session('A'))
      await flush(10)
    })
    await screen.findByTestId('p169-photo-entry') // restored to the photo screen
    await fireEvent.press(await screen.findByTestId('p169-photo-library'))
    expect(await screen.findByTestId('p169-photo-ready')).toBeTruthy()
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  it('a photo of A is deleted when B signs in, and a cancelled pick or a denial is worded', async () => {
    const h = p169Harness()
    h.photo.outcome = PICKED
    await toPhotoEntry(h)
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    await screen.findByTestId('p169-photo-ready')
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('B'))
      await flush(10)
    })
    expect(h.photo.deleted).toContain('file:///data/cache/ImagePicker/one.png')
    expect(screen.queryByTestId('p169-photo-ready')).toBeNull()

    // (B is back at the tab root after the remount)
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.press(await screen.findByTestId('pc-home-photo'))
    h.photo.outcome = { status: 'cancelled' }
    await fireEvent.press(await screen.findByTestId('p169-photo-camera'))
    expect(await screen.findByTestId('p169-photo-cancelled')).toBeTruthy()
    h.photo.outcome = { status: 'permission_denied', canAskAgain: false }
    await fireEvent.press(screen.getByTestId('p169-photo-camera'))
    expect(await screen.findByTestId('p169-photo-denied')).toBeTruthy()
    h.photo.outcome = { status: 'unavailable', reason: 'restart_required' }
    await fireEvent.press(screen.getByTestId('p169-photo-library'))
    expect(await screen.findByText(/Close and reopen the app/)).toBeTruthy()
  })

  it('the photo code has no network or encoding path (no upload, no base64, no EXIF)', () => {
    for (const file of [
      'src/features/price-check/PhotoEntryScreen.tsx',
      'src/features/price-check/recognition.ts',
      'src/photo/photo-store.ts',
    ]) {
      const source = readFileSync(join(appRoot, file), 'utf8')
      expect(source).not.toMatch(
        /\bfetch\(|FormData|XMLHttpRequest|supabase|\.upload|readAsStringAsync/,
      )
    }
    const port = readFileSync(join(appRoot, 'src/photo/expo-photo-port.ts'), 'utf8')
    expect(port).toMatch(/base64:\s*false/)
    expect(port).toMatch(/exif:\s*false/)
  })
})

describe('the integrated client: what Price Check can and cannot send', () => {
  const CONFIG = {
    url: 'http://127.0.0.1:55321',
    publishableKey: 'sb_publishable_' + 'k'.repeat(20),
    host: '127.0.0.1',
  }

  /** The REAL native client (read-only policy + exact-transport guard) over a scripted network. */
  function integrated(searchPricesBody: string) {
    const network: { method: string; path: string }[] = []
    const seen: { method: string; path: string }[] = []
    const client = createNativeClient(CONFIG, {
      storage: createChunkedSessionStorage(new MemoryKeyValueStore()),
      baseFetch: (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url
        const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] as string
        network.push({ method: init?.method ?? 'GET', path })
        if (path === '/functions/v1/search-prices') {
          return Promise.resolve(
            new Response(searchPricesBody, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        if (path === '/rest/v1/fx_rates') {
          return Promise.resolve(
            new Response(JSON.stringify({ rate: '11.5', rate_date: '2026-09-25' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )
        }
        return Promise.resolve(new Response('{}', { status: 200 }))
      },
      fetchOptions: { onRequest: (e) => seen.push(e) },
    })
    const auth = new FakeAuth()
    const catalog = new FakeCatalog()
    const runtime: Runtime = createRuntime({
      auth,
      removeStoredSession: () => Promise.resolve(),
      collection: new FakeCollectionPort(),
      priceCheck: {
        released: createReleasedPriceCheckPort(),
        fixture: createFixturePriceCheckPort(),
      },
      priceFeature: {
        invoke: (name, options) => client.functions.invoke(name, options),
        readFx: fxRateReaderFor(client),
        catalog,
        readCard: () => Promise.resolve({ card: C, variants: [V1, V2] }),
        readSnapshots: () => Promise.resolve([]),
      },
      readFx: fxRateReaderFor(client),
      photo: new FakePhotoPort(),
      writeDb: fakeWriteDbBinder(),
      pendingWrites: {
        journal: new PendingWriteJournal(new MemoryKeyValueStore()),
        existsCheckers: {
          create_purchase: purchaseExistsCheckerFor(client),
          create_sale: saleExistsCheckerFor(client),
        },
      },
    })
    runtime.auth.start()
    auth.emit('SIGNED_IN', session('A'))
    return { client, runtime, network, seen }
  }

  const observation = (value: string) =>
    `{"ok":true,"providerErrorCount":0,"results":[{"cardVariantId":"v1","observations":[{"provider":"tcgdex_cardmarket","priceKind":"cm_trend","sourceCurrency":"EUR","valueMinor":${value},"providerUpdatedAt":null}]}]}`

  it('a full Price Check journey sends only the search-prices function, GETs and the FX read', async () => {
    const t = integrated(observation('"1000"'))
    await t.runtime.feature.priceCheck.enter(C.cardId)
    await t.runtime.feature.priceCheck.chooseVariant('v1')
    const result = t.runtime.feature.priceCheck.getSnapshot().lookup.result
    expect(result?.raw.status).toBe('observations')
    const posts = t.network.filter((r) => r.method !== 'GET')
    expect(posts).toEqual([{ method: 'POST', path: '/functions/v1/search-prices' }])
    expect(t.network.map((r) => r.path).sort()).toEqual([
      '/functions/v1/search-prices',
      '/rest/v1/fx_rates',
    ])
  })

  it('no financial write can be sent through the integrated client: each is refused BEFORE the network', async () => {
    const t = integrated(observation('"1000"'))
    const before = t.network.length
    const refused = async (work: () => PromiseLike<{ error: unknown }>): Promise<string> => {
      try {
        const { error } = await work()
        return JSON.stringify(error)
      } catch (error) {
        return String(error)
      }
    }
    const results = [
      await refused(() => t.client.rpc('add_card_acquisition' as never, {} as never)),
      await refused(() => t.client.rpc('create_purchase' as never, {} as never)),
      await refused(() => t.client.rpc('create_sale' as never, {} as never)),
      await refused(() => t.client.from('holdings').insert({} as never)),
      await refused(() =>
        t.client
          .from('acquisition_lots')
          .update({} as never)
          .eq('id', 'x'),
      ),
      await refused(() => t.client.from('manual_valuations').delete().eq('id', 'x')),
      await refused(() => t.client.functions.invoke('ingest-prices', { body: {} })),
      await refused(() => t.client.functions.invoke('redeem-invitation', { body: {} })),
    ]
    for (const r of results) expect(r).toMatch(/write_refused|read-only|WriteRefused/i)
    expect(t.network.length).toBe(before) // nothing left the device
    expect(
      t.seen.every((r) => r.method === 'GET' || r.path.startsWith('/functions/v1/search-')),
    ).toBe(true)
  })

  it('an unsafe integer literal in the provider answer is refused by the integrated client', async () => {
    const t = integrated(observation('9007199254740993'))
    await t.runtime.feature.priceCheck.enter(C.cardId)
    await t.runtime.feature.priceCheck.chooseVariant('v1')
    const lookup = t.runtime.feature.priceCheck.getSnapshot().lookup
    expect(lookup.status).toBe('error')
    expect(lookup.failure).toBe('malformed_response')
    expect(lookup.result).toBeNull()
  })

  it('the same value as a decimal string stays exact through the integrated client (2^53+1, 2^58)', async () => {
    for (const [value, shown] of [
      ['9007199254740993', '€90,071,992,547,409.93'],
      ['288230376151711744', '€2,882,303,761,517,117.44'],
    ] as const) {
      const t = integrated(observation(`"${value}"`))
      await t.runtime.feature.priceCheck.enter(C.cardId)
      await t.runtime.feature.priceCheck.chooseVariant('v1')
      const raw = t.runtime.feature.priceCheck.getSnapshot().lookup.result?.raw
      expect(raw?.status).toBe('observations')
      if (raw?.status !== 'observations') return
      expect(raw.rows[0]?.observation.price?.minorUnits).toBe(BigInt(value))
      expect(formatMoney(raw.rows[0]?.observation.price ?? null)).toBe(shown)
    }
  })

  it('PriceLookupError carries the reason the UI words (not a number)', () => {
    expect(new PriceLookupError('malformed_response').reason).toBe('malformed_response')
  })
})

describe('touch targets on the integrated screens (48 dp floor)', () => {
  // P185: the sweep used to query role="button" only, so radios (printing and currency choices) were
  // never measured. Every interactive role an app-owned control can have is swept now.
  const SWEPT_ROLES = ['button', 'radio', 'checkbox', 'switch'] as const
  function undersized(): string[] {
    expect(SWEPT_ROLES).toEqual(expect.arrayContaining(['button', 'radio']))
    const bad: string[] = []
    // The tab bar buttons are sized by the bar (tabBarHeight, pinned in p167-platform.test.tsx).
    const nodes = SWEPT_ROLES.flatMap((role) => screen.queryAllByRole(role)).filter(
      (n) => !String(n.props.testID ?? '').startsWith('tab-'),
    )
    for (const node of nodes) {
      const style = Object.assign(
        {},
        ...(([node.props.style] as unknown[]).flat(Infinity).filter(Boolean) as object[]),
      ) as { minHeight?: number; height?: number }
      const h = style.minHeight ?? style.height ?? 0
      if (h < 48) bad.push(String(node.props.testID ?? node.props.accessibilityLabel))
    }
    expect(nodes.length).toBeGreaterThan(0)
    return bad
  }

  it('Search, card (choice + confirmed), Price Check landing, photo entry and the add intent', async () => {
    const h = p169Harness()
    h.cards.set(C.cardId, { card: C, variants: [V1, V2] })
    h.catalog.corpus = [hit('c1', { name: 'Card c1', activeVariantCount: 2 })]
    h.invoker.answer(C.cardId, body({ v1: [obs('tcgdex_cardmarket', '1000')] }))
    await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await screen.findByTestId('price-check-home')
    expect(undersized()).toEqual([])
    await fireEvent.press(screen.getByTestId('pc-home-photo'))
    await screen.findByTestId('p169-photo-entry')
    expect(undersized()).toEqual([])
    await fireEvent.press(screen.getByTestId('p169-choose-manually'))
    await act(async () => {
      await fireEvent.changeText(await screen.findByTestId('p169-search-input'), 'Card c1')
      await flush(10)
    })
    await screen.findByTestId('p169-hit-c1')
    expect(undersized()).toEqual([])
    await fireEvent.press(screen.getByTestId('p169-hit-c1'))
    await screen.findByTestId('p169-printing-choice')
    expect(screen.queryAllByRole('radio').length).toBeGreaterThanOrEqual(2) // the sweep really saw them
    expect(undersized()).toEqual([])
    await act(async () => {
      await fireEvent.press(screen.getByTestId('p169-variant-v1'))
      await flush(10)
    })
    await screen.findByTestId('p169-add-to-collection')
    expect(undersized()).toEqual([])
    await fireEvent.press(screen.getByTestId('p169-add-to-collection'))
    await screen.findByTestId('p170-add-intent')
  })
})

describe('restoring the navigation after an Activity recreation', () => {
  it('drops the transient cross-navigator instruction and keeps the reached screen', () => {
    const saved = {
      index: 1,
      routes: [
        { name: 'CollectionTab' },
        {
          name: 'SearchTab',
          params: { screen: 'P169PhotoEntry', initial: true, extra: 'kept' },
          state: {
            index: 1,
            routes: [
              { name: 'P169PhotoEntry' },
              { name: 'P169Card', params: { cardId: 'c1', variantId: 'v1' } },
            ],
          },
        },
        { name: 'PriceCheckTab', params: { state: { routes: [] } } },
      ],
    }
    const restored = restorableNavigationState(saved)
    expect(restored.routes[1]?.params).toEqual({ extra: 'kept' })
    expect(restored.routes[2]).toEqual({ name: 'PriceCheckTab' })
    // real screen params are untouched, and the input is not mutated
    expect(restored.routes[1]?.state?.routes[1]?.params).toEqual({ cardId: 'c1', variantId: 'v1' })
    expect(saved.routes[1]?.params?.screen).toBe('P169PhotoEntry')
    expect(restorableNavigationState(undefined)).toBeUndefined()
  })

  it('Price Check landing -> photo entry -> "choose manually" -> recreation shows the SEARCH screen', async () => {
    const h = p169Harness()
    const first = await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('SIGNED_IN', session('A'))
      await flush()
    })
    await fireEvent.press(await screen.findByTestId('tab-pricecheck'))
    await fireEvent.press(await screen.findByTestId('pc-home-photo'))
    await fireEvent.press(await screen.findByTestId('p169-choose-manually'))
    await screen.findByTestId('p169-search')
    await first.unmount()

    await render(<AppRoot runtime={h.runtime} backendHost="127.0.0.1" />)
    await act(async () => {
      h.auth.emit('INITIAL_SESSION', session('A'))
      await flush(10)
    })
    expect(await screen.findByTestId('p169-search-input')).toBeTruthy()
    expect(screen.queryByTestId('p169-photo-entry')).toBeNull()
  })
})
