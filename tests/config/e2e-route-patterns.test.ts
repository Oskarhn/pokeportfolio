import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P147 — a Playwright glob route that ends at an RPC name matches only the bare path. The data layer
 * calls its RPCs as `.rpc(name, args).select(<columns>)`, so the real URL is
 * `/rest/v1/rpc/name?select=...` and a route such as `page.route('**\/rest/v1/rpc/create_sale', …)`
 * never fires: the request is not held, the "slow response" never happens, and the spec passes or
 * fails on timing luck while claiming to test a race. Two specs did exactly that from P111/P125
 * until P147 found it (one 'Saving…' assertion failed in four combined runs; a probe showed the
 * request completing in 28 ms). Every such route must tolerate a query string, and the spec must
 * prove the request was held.
 */

const E2E = join(__dirname, '..', 'e2e')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : name.endsWith('.ts') ? [full] : []
  })
}

const files = walk(E2E).map((path) => ({ path, text: readFileSync(path, 'utf8') }))

/** A string-literal route pattern (quote or backtick) that ends exactly at `rpc/<name>`. */
const BARE_RPC_GLOB = /\.route\(\s*(['"`])[^'"`]*\/rest\/v1\/rpc\/[A-Za-z_]+\1/

describe('E2E route patterns for Supabase RPCs', () => {
  it('finds the specs it is meant to police (the rule is not vacuous)', () => {
    const routing = files.filter((f) => /\.route\(|holdRequest\(/.test(f.text))
    expect(routing.length).toBeGreaterThan(8)
    expect(files.some((f) => /rest\/v1\/rpc\//.test(f.text))).toBe(true)
  })

  it('no route is a bare-path glob for an RPC (it would never match the ?select=… URL)', () => {
    const offenders = files.filter((f) => BARE_RPC_GLOB.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('the rule itself catches the shape it forbids', () => {
    expect(BARE_RPC_GLOB.test("await page.route('**/rest/v1/rpc/create_sale', handler)")).toBe(true)
    expect(BARE_RPC_GLOB.test('await page.route(`**/rest/v1/rpc/update_purchase`, h)')).toBe(true)
    expect(BARE_RPC_GLOB.test("await page.route('**/rest/v1/rpc/create_sale*', handler)")).toBe(
      false,
    )
    expect(
      BARE_RPC_GLOB.test('page.route(/\\/rest\\/v1\\/rpc\\/create_sale(?:\\?.*)?$/, handler)'),
    ).toBe(false)
  })
})
