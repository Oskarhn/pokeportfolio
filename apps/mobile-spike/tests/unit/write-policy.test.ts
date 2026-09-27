import { assertWriteRequest, WriteNotAllowedError, WRITE_RPCS } from '../../src/write/write-policy'

const BASE = 'http://127.0.0.1:54321'

/**
 * The write seam's allow-list (mutations #17/#18 in output_175.txt: Add screen / Price Check must
 * never be able to reach a write RPC). Every one of the six finance write RPCs is allowed; nothing
 * else is — not a read RPC, not a table write, not a GET, not an auth endpoint.
 */
describe('assertWriteRequest', () => {
  it('allows exactly the finance write RPCs', () => {
    for (const rpc of WRITE_RPCS) {
      expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/rpc/${rpc}`)).not.toThrow()
    }
  })

  it('has exactly the six RPCs this phase implements — no more, no less', () => {
    expect([...WRITE_RPCS].sort()).toEqual(
      [
        'add_card_acquisition',
        'clear_manual_valuation',
        'create_opening',
        'create_purchase',
        'create_sale',
        'set_manual_valuation',
      ].sort(),
    )
  })

  it('refuses a read-only RPC (the reading client stays read-only; this client stays write-only)', () => {
    expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/rpc/list_portfolio`)).toThrow(
      WriteNotAllowedError,
    )
    expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/rpc/search_cards`)).toThrow(
      WriteNotAllowedError,
    )
  })

  it('refuses an unimplemented write RPC (update_purchase / void_sale / create_opening_from_provisional)', () => {
    for (const rpc of [
      'update_purchase',
      'void_purchase',
      'update_sale',
      'void_sale',
      'create_opening_from_provisional',
    ]) {
      expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/rpc/${rpc}`)).toThrow(
        WriteNotAllowedError,
      )
    }
  })

  it('refuses a direct table write', () => {
    expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/purchases`)).toThrow(
      WriteNotAllowedError,
    )
    expect(() => assertWriteRequest('PATCH', `${BASE}/rest/v1/holdings?id=eq.1`)).toThrow(
      WriteNotAllowedError,
    )
    expect(() => assertWriteRequest('DELETE', `${BASE}/rest/v1/acquisition_lots?id=eq.1`)).toThrow(
      WriteNotAllowedError,
    )
  })

  it('refuses every GET (this client is write-only; reads go through the shared client)', () => {
    expect(() => assertWriteRequest('GET', `${BASE}/rest/v1/rpc/create_purchase`)).toThrow(
      WriteNotAllowedError,
    )
  })

  it('refuses the auth endpoints (a leased write client has no usable auth subsystem)', () => {
    expect(() => assertWriteRequest('POST', `${BASE}/auth/v1/token`)).toThrow(WriteNotAllowedError)
    expect(() => assertWriteRequest('POST', `${BASE}/auth/v1/logout`)).toThrow(WriteNotAllowedError)
  })

  it('is case-insensitive on the method and exact on the path', () => {
    expect(() => assertWriteRequest('post', `${BASE}/rest/v1/rpc/create_purchase`)).not.toThrow()
    expect(() => assertWriteRequest('POST', `${BASE}/rest/v1/rpc/create_purchase_evil`)).toThrow(
      WriteNotAllowedError,
    )
  })
})
