import { FunctionsHttpError } from '@supabase/supabase-js'
import {
  AccountRequestRefusedError,
  assertAccountRequest,
  createAccountDeletionPorts,
} from '../../src/account/account-request-client'
import { READ_ONLY_RPCS, READ_ONLY_FUNCTIONS } from '../../src/net/spike-fetch'
import { WRITE_RPCS } from '../../src/write/write-policy'

/**
 * P189: the account-lifecycle wire seam. Its allow-list is ONE request, and it shares nothing with the
 * read-only client or the finance write client (the three policies must never merge). The emulator
 * found that routing delete-account through the read-only client was refused on the wire.
 */

const BASE = 'http://10.0.2.2:55721'

describe('the allow-list', () => {
  it('allows exactly POST /functions/v1/delete-account', () => {
    expect(() => {
      assertAccountRequest('POST', `${BASE}/functions/v1/delete-account`)
    }).not.toThrow()
    expect(() => {
      assertAccountRequest('post', `${BASE}/functions/v1/delete-account?x=1`)
    }).not.toThrow() // a query string is not part of the path
  })

  it.each([
    ['GET', '/functions/v1/delete-account'],
    ['DELETE', '/functions/v1/delete-account'],
    ['POST', '/functions/v1/search-prices'],
    ['POST', '/functions/v1/fetch-fx-rate'],
    ['POST', '/functions/v1/delete-account/extra'],
    ['POST', '/rest/v1/rpc/reset_my_portfolio_data'],
    ['POST', '/rest/v1/rpc/create_purchase'],
    ['POST', '/rest/v1/profiles'],
    ['POST', '/auth/v1/token'],
    ['GET', '/rest/v1/holdings'],
  ])('refuses %s %s', (method, path) => {
    expect(() => {
      assertAccountRequest(method, `${BASE}${path}`)
    }).toThrow(AccountRequestRefusedError)
  })

  it('shares no endpoint with the read-only client or the finance write client', () => {
    expect(READ_ONLY_FUNCTIONS.has('delete-account')).toBe(false)
    expect(READ_ONLY_RPCS.has('delete-account')).toBe(false)
    expect(WRITE_RPCS.has('delete-account')).toBe(false)
  })
})

describe('the client', () => {
  const session = { access_token: 'tok-A', user: { id: 'A' } }

  function ports(fetchImpl: typeof fetch) {
    return createAccountDeletionPorts({
      url: BASE,
      publishableKey: 'sb_publishable_test',
      getSession: () => Promise.resolve({ data: { session } }),
      baseFetch: fetchImpl,
      accountIsGone: () => Promise.resolve(false),
    })
  }

  it('sends the deletion request with the LIVE session token as the bearer', async () => {
    const seen: { url: string; auth: string | null; body: string }[] = []
    const fetchImpl = ((input: string, init: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init.headers).get('Authorization'),
        body: typeof init.body === 'string' ? init.body : '',
      })
      return Promise.resolve(new Response(JSON.stringify({ status: 'deleted' }), { status: 200 }))
    }) as unknown as typeof fetch
    const result = await ports(fetchImpl).invoke('delete-account', {
      body: { expectedUserId: 'A', password: 'p', confirm: true },
    })
    expect(result.error).toBeNull()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${BASE}/functions/v1/delete-account`)
    expect(seen[0]?.auth).toBe('Bearer tok-A')
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      expectedUserId: 'A',
      password: 'p',
      confirm: true,
    })
  })

  it('maps a server refusal to an HTTP error the shared contract understands', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'reauthentication_failed' }), { status: 403 }),
      )) as unknown as typeof fetch
    const result = await ports(fetchImpl).invoke('delete-account', { body: { x: 1 } })
    expect(result.error).toBeInstanceOf(FunctionsHttpError)
  })

  it('refuses any OTHER function at the wire, before the network', async () => {
    let called = 0
    const fetchImpl = (() => {
      called += 1
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch
    const result = await ports(fetchImpl).invoke('search-prices', { body: {} })
    expect(result.error).not.toBeNull()
    expect(called).toBe(0)
  })
})
