/**
 * Cloudflare Web Analytics route-gating and one-shot injection (P110, D-119). The test environment
 * runs under Node (`environment: 'node'` in vite.config.ts) — `document` is stubbed with a real
 * `EventTarget`-free fake rather than a real browser, following this suite's existing convention
 * (tests/ui/build-freshness-runtime.test.ts). A DUMMY token only — never a real Cloudflare token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  initCloudflareWebAnalytics,
  resetCloudflareWebAnalyticsStateForTests,
} from '../../src/analytics/cloudflareWebAnalytics'

const DUMMY_TOKEN = 'test-dummy-token-not-real'

class FakeScriptElement {
  defer = false
  src = ''
  private attrs = new Map<string, string>()
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
}

class FakeHead {
  children: FakeScriptElement[] = []
  appendChild(el: FakeScriptElement): void {
    this.children.push(el)
  }
}

class FakeDocument {
  head = new FakeHead()
  createElement(): FakeScriptElement {
    return new FakeScriptElement()
  }
}

let fakeDocument: FakeDocument

beforeEach(() => {
  resetCloudflareWebAnalyticsStateForTests()
  fakeDocument = new FakeDocument()
  vi.stubGlobal('document', fakeDocument)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('initCloudflareWebAnalytics — token gating (unchanged from D-118)', () => {
  it('does nothing when no token is configured, even on an eligible public page', () => {
    initCloudflareWebAnalytics({ pathname: '/faq', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })
})

describe('initCloudflareWebAnalytics — route gating (P110, D-119)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_CF_ANALYTICS_TOKEN', DUMMY_TOKEN)
  })

  it('public FAQ page: initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/faq', search: '' })
    expect(fakeDocument.head.children).toHaveLength(1)
    const script = fakeDocument.head.children[0]!
    expect(script.src).toBe('https://static.cloudflareinsights.com/beacon.min.js')
    const beacon = JSON.parse(script.getAttribute('data-cf-beacon')!) as {
      token: string
      spa: boolean
    }
    expect(beacon.token).toBe(DUMMY_TOKEN)
    // P110: spa:false disables Cloudflare's own automatic SPA history-change tracking — this
    // script must never auto-report a later navigation on its own.
    expect(beacon.spa).toBe(false)
  })

  it('privacy page: initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/privacy', search: '' })
    expect(fakeDocument.head.children).toHaveLength(1)
  })

  it('portfolio UUID path: never initializes', () => {
    initCloudflareWebAnalytics({
      pathname: '/portfolio/8f14e45f-ceea-467e-9c1e-1234567890ab',
      search: '',
    })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('holding detail (any private entity-id route): never initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/purchases/some-purchase-id', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('scanner route: never initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/scan', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('invite token route: never initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/invite/a-live-secret-token', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('reset-password token route: never initializes', () => {
    initCloudflareWebAnalytics({ pathname: '/reset-password', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('a query string on an otherwise-eligible page is never transmitted — the script is not even injected', () => {
    initCloudflareWebAnalytics({ pathname: '/faq', search: '?ref=some-tracking-id' })
    expect(fakeDocument.head.children).toHaveLength(0)
  })

  it('public -> private SPA navigation: the already-tracked public pageview stands, but the private page is never emitted (verified as "no additional injection", which is the only mechanism that could emit one)', () => {
    initCloudflareWebAnalytics({ pathname: '/faq', search: '' })
    expect(fakeDocument.head.children).toHaveLength(1)
    initCloudflareWebAnalytics({ pathname: '/portfolio', search: '' })
    // No SECOND script injected for the private route, and (since spa:false was set on the first
    // and only injection) Cloudflare's own script has no history hook that could report it either.
    expect(fakeDocument.head.children).toHaveLength(1)
  })

  it('private -> public SPA navigation: initializes only once the public page is reached (safe timing)', () => {
    initCloudflareWebAnalytics({ pathname: '/portfolio', search: '' })
    expect(fakeDocument.head.children).toHaveLength(0)
    initCloudflareWebAnalytics({ pathname: '/faq', search: '' })
    expect(fakeDocument.head.children).toHaveLength(1)
  })

  it('is idempotent: a second eligible call in the same session never injects a second script', () => {
    initCloudflareWebAnalytics({ pathname: '/faq', search: '' })
    initCloudflareWebAnalytics({ pathname: '/privacy', search: '' })
    expect(fakeDocument.head.children).toHaveLength(1)
  })
})
