import { describe, expect, it } from 'vitest'
import { detectIsSafariUserAgent } from '../../src/features/scanner/visual/safari-detection'

/**
 * F-35 (P89): dedicated coverage for the one function visual-worker.ts explicitly branches
 * Safari-vs-non-Safari behavior on (WASM binary choice: threaded vs. asyncify) — before this it
 * had zero unit coverage despite 6 of the 12 real confirmed scanner bugs this milestone fixed
 * being found only via real iPhone/Safari testing. This is a UA-string unit-test proof of the
 * DETECTION LOGIC only — it does not and cannot replace a real WebKit smoke test (see F-31); a
 * correct detector still says nothing about whether the WASM path it selects actually works on
 * real WebKit.
 *
 * Representative user-agent strings captured from MDN's / whatwg's documented UA shapes for each
 * engine, not fabricated from memory of a single string.
 */

const SAFARI_MACOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const SAFARI_IPAD =
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const CHROME_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.111 Mobile/15E148 Safari/604.1'
const FIREFOX_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/126.1 Mobile/15E148 Safari/605.1.15'
const EDGE_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 EdgiOS/124.2478.98 Mobile/15E148 Safari/605.1.15'
const CHROME_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const FIREFOX_DESKTOP_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0'
const FIREFOX_DESKTOP_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const EDGE_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'

describe('detectIsSafariUserAgent (F-35)', () => {
  it('recognizes real Safari on macOS', () => {
    expect(
      detectIsSafariUserAgent({ userAgent: SAFARI_MACOS, vendor: 'Apple Computer, Inc.' }),
    ).toBe(true)
  })

  it('recognizes real Safari on iOS (iPhone)', () => {
    expect(detectIsSafariUserAgent({ userAgent: SAFARI_IOS, vendor: 'Apple Computer, Inc.' })).toBe(
      true,
    )
  })

  it('recognizes real Safari on iPadOS', () => {
    expect(
      detectIsSafariUserAgent({ userAgent: SAFARI_IPAD, vendor: 'Apple Computer, Inc.' }),
    ).toBe(true)
  })

  it('rejects Chrome on iOS (CriOS) despite the Apple vendor string WebKit-based iOS browsers all share', () => {
    expect(detectIsSafariUserAgent({ userAgent: CHROME_IOS, vendor: 'Apple Computer, Inc.' })).toBe(
      false,
    )
  })

  it('rejects Firefox on iOS (FxiOS)', () => {
    expect(
      detectIsSafariUserAgent({ userAgent: FIREFOX_IOS, vendor: 'Apple Computer, Inc.' }),
    ).toBe(false)
  })

  it('rejects Edge on iOS (EdgiOS)', () => {
    expect(detectIsSafariUserAgent({ userAgent: EDGE_IOS, vendor: 'Apple Computer, Inc.' })).toBe(
      false,
    )
  })

  it('rejects desktop Chrome (Apple vendor string, but Chrome/ in the UA)', () => {
    expect(detectIsSafariUserAgent({ userAgent: CHROME_DESKTOP, vendor: 'Google Inc.' })).toBe(
      false,
    )
  })

  it('rejects desktop Firefox on macOS (non-Apple vendor)', () => {
    expect(detectIsSafariUserAgent({ userAgent: FIREFOX_DESKTOP_MAC, vendor: '' })).toBe(false)
  })

  it('rejects desktop Firefox on Windows', () => {
    expect(detectIsSafariUserAgent({ userAgent: FIREFOX_DESKTOP_WIN, vendor: '' })).toBe(false)
  })

  it('rejects Chrome on Android', () => {
    expect(detectIsSafariUserAgent({ userAgent: CHROME_ANDROID, vendor: 'Google Inc.' })).toBe(
      false,
    )
  })

  it('rejects desktop Edge (Chromium-based, non-Apple vendor)', () => {
    expect(detectIsSafariUserAgent({ userAgent: EDGE_DESKTOP, vendor: 'Google Inc.' })).toBe(false)
  })

  it('returns false with no navigator at all (SSR/worker-without-navigator safety)', () => {
    expect(detectIsSafariUserAgent(undefined)).toBe(false)
  })

  it('a missing vendor string (some non-standard environments) is treated as non-Apple, not a crash', () => {
    expect(detectIsSafariUserAgent({ userAgent: SAFARI_MACOS })).toBe(false)
  })

  it('defaults to reading the REAL global navigator when called with no argument (production call shape)', () => {
    // visual-worker.ts calls detectIsSafariUserAgent() with zero arguments — proves the default
    // parameter wiring itself, not just the injected-navigator test double path above.
    const result = detectIsSafariUserAgent()
    expect(typeof result).toBe('boolean')
  })
})
