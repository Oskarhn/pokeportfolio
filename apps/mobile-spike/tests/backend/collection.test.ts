import { createChunkedSessionStorage } from '../../src/auth/chunked-session-storage'
import { AUTH_STORAGE_KEY, createNativeClient } from '../../src/auth/create-client'
import { createSharedCollectionPort } from '../../src/collection/shared-data-adapter'
import { CollectionStore } from '../../src/state/collection-store'
import { classifyFailure } from '../../src/net/failure'
import { formatMoney } from '../../src/money/format-money'
import { MemoryKeyValueStore } from '../support/fakes'
import { setBackendClient } from '../support/backend-supabase-client'
import {
  backendDescribe,
  fixture,
  newSession,
  psql,
  publicEnv,
  realRuntime,
  until,
} from './support'

backendDescribe(
  'collection read against the real local backend (A: 10,006 synthetic holdings)',
  () => {
    const { a } = fixture().users

    async function signedIn() {
      const session = newSession()
      const runtime = realRuntime(session)
      await runtime.auth.signIn(a.email, a.password)
      await until(() => runtime.auth.getSnapshot().userId === a.id)
      return { session, runtime }
    }

    it('walks ALL 10,006 holdings by keyset pages: unique keys, no duplicates, bounded memory', async () => {
      const { runtime } = await signedIn()
      const store = new CollectionStore(createSharedCollectionPort(), runtime.authority, 100)
      if (typeof globalThis.gc === 'function') globalThis.gc()
      const before = process.memoryUsage().heapUsed
      const started = Date.now()
      await store.load()
      let pages = 1
      while (!store.getSnapshot().done) {
        await store.loadMore()
        expect(store.getSnapshot().failure).toBeNull()
        pages += 1
      }
      const ms = Date.now() - started
      const rows = store.getSnapshot().rows
      const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024
      console.log(
        `MEASURED 10k walk: ${String(rows.length)} rows, ${String(pages)} pages of 100, ${String(ms)} ms, heap growth ~${growthMb.toFixed(1)} MB (Node, not Hermes)`,
      )
      expect(rows).toHaveLength(10006)
      expect(new Set(rows.map((r) => r.holdingId)).size).toBe(10006)
      expect(growthMb).toBeLessThan(80)
    })

    it('reads exact money above 2^53 from the real database; NULL is not zero; a deliberate manual zero is zero', async () => {
      const { runtime } = await signedIn()
      const store = new CollectionStore(createSharedCollectionPort(), runtime.authority, 100)
      await store.load()
      while (!store.getSnapshot().done) await store.loadMore()
      const byTitle = new Map(store.getSnapshot().rows.map((r) => [r.title, r]))

      // Three copies of a 288230376151711745 (2^58+1) manual valuation.
      expect(byTitle.get('P158 Astronomical')?.holdingValueMinor).toBe(3n * 288230376151711745n)
      expect(byTitle.get('P158 Above Safe Integer')?.holdingValueMinor).toBe(3n * 9007199254740993n)
      expect(byTitle.get('P158 Manual Zero')?.holdingValueMinor).toBe(0n)
      expect(byTitle.get('P158 No Prices')?.holdingValueMinor).toBeNull()
      expect(byTitle.get('Synthetic Card 00001')?.holdingValueMinor).toBeNull()

      expect(formatMoney({ minorUnits: 864691128455135235n, currency: 'NOK' })).toBe(
        '8 646 911 284 551 352,35 kr',
      )
      const counts = store.getSnapshot().counts
      expect(counts?.unpricedHoldingCount).toBe(10001)
      expect(counts?.pricedHoldingCount).toBe(5)
      // The portfolio total is the exact sum of what is shown.
      const sum = [...byTitle.values()].reduce((acc, r) => acc + (r.holdingValueMinor ?? 0n), 0n)
      expect(counts?.portfolioValueMinor).toBe(sum)
    })

    it('value_desc: page one is exact; paging PAST an above-2^53 cursor value fails closed (DB 104 limitation)', async () => {
      const { runtime } = await signedIn()
      const store = new CollectionStore(createSharedCollectionPort(), runtime.authority, 2)
      await store.setSort('value_desc')
      const first = store.getSnapshot()
      expect(first.rows[0]?.title).toBe('P158 Astronomical')
      expect(first.rows[0]?.holdingValueMinor).toBe(864691128455135235n)
      // The cursor of page one carries 864691128455135235 > 2^53: the released wrapper would send
      // Number(cursor) = a rounded value. The adapter refuses instead of returning a wrong next page.
      await store.loadMore()
      const after = store.getSnapshot()
      expect(after.failure?.kind).toBe('unsafe_numeric')
      expect(after.rows).toHaveLength(2) // rows already shown are intact; nothing wrong was appended
    })

    it('EXPLORATORY: the server accepts the cursor value as a decimal STRING (what an exact-money client will send)', async () => {
      const { session } = await signedIn()
      const token = (
        JSON.parse((await session.storage.getItem(AUTH_STORAGE_KEY)) as string) as {
          access_token: string
        }
      ).access_token
      const env = publicEnv()
      const call = async (value: string | number) => {
        const res = await fetch(`${env.apiUrl}/rest/v1/rpc/list_portfolio`, {
          method: 'POST',
          headers: {
            apikey: env.publishableKey,
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: `{"p_sort":"value_desc","p_limit":3,"p_cursor_holding_id":"00000000-0000-0000-0000-000000000000","p_cursor_name":"","p_cursor_set_name":"","p_cursor_quantity":0,"p_cursor_added_at":"2026-01-01T00:00:00Z","p_cursor_has_value":true,"p_cursor_number_key":"","p_cursor_value_minor":${typeof value === 'string' ? `"${value}"` : String(value)}}`,
        })
        return {
          status: res.status,
          rows: (await res.json()) as {
            holding_value_nok_minor: string | null
            card_name: string
          }[],
        }
      }
      // Cursor value = astronomical + 1. Sent as a decimal STRING the server keeps every digit, so the
      // astronomical holding (…235) is still strictly below the cursor and leads the page.
      const asString = await call('864691128455135236')
      expect(asString.status).toBe(200)
      expect(asString.rows[0]?.card_name).toBe('P158 Astronomical')
      // Sent as the JSON number a JS client would produce (Number(…236n) prints as …200), the cursor is
      // rounded DOWN below the astronomical holding, which then silently drops out of the next page.
      const rounded = String(Number(864691128455135236n))
      expect(rounded).toBe('864691128455135200')
      const asNumber = await call(rounded)
      expect(asNumber.status).toBe(200)
      expect(asNumber.rows.some((r) => r.card_name === 'P158 Astronomical')).toBe(false)
    })

    it('the adapter never asks for more than the server page cap, so a list is not cut after page one', async () => {
      const { runtime } = await signedIn()
      const calls: number[] = []
      const inner = createSharedCollectionPort()
      const spy = {
        ...inner,
        listPage: (i: Parameters<typeof inner.listPage>[0]) => (
          calls.push(i.limit),
          inner.listPage({ ...i, limit: i.limit })
        ),
      }
      const store = new CollectionStore(spy, runtime.authority, 500) // asks for 500; the server caps at 100
      await store.load()
      expect(store.getSnapshot().rows).toHaveLength(100)
      expect(store.getSnapshot().done).toBe(false) // NOT mistaken for the end of the list
    })

    it('card detail: provenance (source currency, snapshot date) is exact and equals the shared domain conversion', async () => {
      const { runtime } = await signedIn()
      const store = new CollectionStore(createSharedCollectionPort(), runtime.authority, 100)
      await store.load()
      while (!store.getSnapshot().done) await store.loadMore()
      const rows = store.getSnapshot().rows
      const holdingId = (title: string) => rows.find((r) => r.title === title)?.holdingId as string

      await runtime.holdingDetail.load(holdingId('P158 Priced Both Providers'))
      const priced = runtime.holdingDetail.getSnapshot()
      expect(priced.status).toBe('ready')
      expect(priced.detail?.quantity).toBe(3)
      // FINANCIAL_MODEL §6 / resolver: a snapshot is 'fresh' up to 3 days old, else 'stale' (the seed is dated
      // when it was created, and this test may run days later, so the expectation is computed from the age).
      const ageDays = Number(
        psql(
          "select current_date - max(snapshot_date) from public.price_snapshots s join public.card_variants v on v.id = s.card_variant_id join public.cards c on c.id = v.card_id where c.local_id = 'S06'",
        ),
      )
      expect(priced.detail?.priceState).toBe(ageDays <= 3 ? 'fresh' : 'stale')
      expect(priced.detail?.provider).toBeTruthy()
      expect(priced.detail?.sourceValueMinor).toBeDefined()
      expect(priced.detail?.holdingValueMinor).toBe(3n * (priced.detail?.unitValueMinor as bigint))

      await runtime.holdingDetail.load(holdingId('P158 Astronomical'))
      const astro = runtime.holdingDetail.getSnapshot().detail
      expect(astro?.priceState).toBe('manual')
      expect(astro?.unitValueMinor).toBe(288230376151711745n)
      expect(astro?.holdingValueMinor).toBe(864691128455135235n)

      await runtime.holdingDetail.load(holdingId('P158 No Prices'))
      expect(runtime.holdingDetail.getSnapshot().detail).toMatchObject({
        priceState: 'missing',
        unitValueMinor: null,
        holdingValueMinor: null,
      })
    })

    it('a garbage session token is a real 401 -> "unauthorized" (not "offline", not "server")', async () => {
      const env = publicEnv()
      const store = new MemoryKeyValueStore(2048)
      const storage = createChunkedSessionStorage(store)
      await storage.setItem(
        AUTH_STORAGE_KEY,
        JSON.stringify({
          access_token: 'not.a.jwt',
          refresh_token: 'x',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: {
            id: a.id,
            aud: 'authenticated',
            app_metadata: {},
            user_metadata: {},
            created_at: 't',
          },
        }),
      )
      const client = createNativeClient(
        { url: env.apiUrl, publishableKey: env.publishableKey, host: '127.0.0.1' },
        { storage },
      )
      setBackendClient(client)
      let failure
      try {
        await createSharedCollectionPort().listPage({
          sort: 'added_newest',
          cursor: null,
          limit: 5,
        })
      } catch (e) {
        failure = classifyFailure(e)
      }
      expect(failure).toMatchObject({ kind: 'unauthorized', retryable: false })
    })

    it('an unreachable backend is "offline"; a bad request is "request_rejected" (a real 4xx)', async () => {
      const dead = newSession({ url: 'http://127.0.0.1:55999' })
      setBackendClient(dead.client)
      await expect(createSharedCollectionPort().counts()).rejects.toBeDefined()
      const failure = await createSharedCollectionPort().counts().catch(classifyFailure)
      expect(failure).toMatchObject({ kind: 'offline' })

      const { session } = await signedIn()
      setBackendClient(session.client)
      const bad = await session.client.rpc(
        'list_portfolio' as never,
        { p_sort: 'not_a_sort_order', p_limit: 1 } as never,
      )
      expect(classifyFailure(bad.error).kind).toBe('request_rejected')
    })
  },
)
