import { describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import {
  SCANNER_DEFAULT_ORIGIN,
  SCANNER_ORIGINS,
  initialScannerDefaults,
  scannerCostBasisState,
  scannerSessionStore,
} from '../../src/features/scanner/session-store'
import { fixedCostBasisState } from '../../src/features/collection/origin-basis'
import { applyAuthIdentityBoundary } from '../../src/auth/query-cache-boundary'

/**
 * Session defaults discipline (prompt sections 25-27): user-scoped memory, cleared by BOTH auth
 * exit paths (D-093 sweep extension), a standalone origin set that structurally cannot fabricate
 * Opening provenance, and basis states derived ONLY through the shared add-flow mapping.
 */

describe('scanner origin guard (I10)', () => {
  it('the standalone origin set contains NO opening option — structurally', () => {
    expect(SCANNER_ORIGINS).not.toContain('opening')
    expect(Object.isFrozen(SCANNER_ORIGINS) || Array.isArray(SCANNER_ORIGINS)).toBe(true)
    expect(SCANNER_DEFAULT_ORIGIN).toBe('pre_tracking')
  })

  it('defaults initialise to pre_tracking / NM / English with today as acquired date', () => {
    const defaults = initialScannerDefaults()
    expect(defaults.origin).toBe('pre_tracking')
    expect(defaults.condition).toBe('NM')
    expect(defaults.language).toBe('en')
    expect(defaults.acquiredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Profile capture defaults override where they exist.
    const seeded = initialScannerDefaults({ condition: 'EX', storageLocationId: 'loc-9' })
    expect(seeded.condition).toBe('EX')
    expect(seeded.storageLocationId).toBe('loc-9')
  })
})

describe('origin → basis semantics via the SHARED helper (I11)', () => {
  it('scanner and add-flow agree through one mapping', () => {
    for (const origin of ['pre_tracking', 'gift', 'trade_in'] as const) {
      expect(scannerCostBasisState(origin)).toBe(fixedCostBasisState(origin))
    }
  })

  it('pre_tracking defaults to UNKNOWN basis correctly', () => {
    expect(scannerCostBasisState('pre_tracking')).toBe('unknown')
  })

  it('purchase resolves to unknown here — the scanner never collects amounts, never fabricates zero', () => {
    expect(fixedCostBasisState('purchase')).toBeNull()
    expect(scannerCostBasisState('purchase')).toBe('unknown')
  })
})

describe('user scoping and identity boundary (I9)', () => {
  it('a null owner loads and saves nothing', () => {
    scannerSessionStore.save(null, initialScannerDefaults())
    expect(scannerSessionStore.load(null)).toBeNull()
  })

  it("account B never sees account A's scanner session defaults", () => {
    scannerSessionStore.save('user-a', { ...initialScannerDefaults(), condition: 'PO' })
    expect(scannerSessionStore.load('user-a')?.condition).toBe('PO')
    expect(scannerSessionStore.load('user-b')).toBeNull()
  })

  it('applyAuthIdentityBoundary clears the scanner session store alongside opening drafts', () => {
    scannerSessionStore.save('user-a', initialScannerDefaults())
    const cancelQueries = vi.fn()
    const clear = vi.fn()
    const queryClient = { cancelQueries, clear } as unknown as QueryClient
    const fired = applyAuthIdentityBoundary(queryClient, 'user-a', 'user-b')
    expect(fired).toBe(true)
    expect(clear).toHaveBeenCalled()
    expect(scannerSessionStore.load('user-a')).toBeNull()

    // Same-user refreshes keep everything.
    scannerSessionStore.save('user-b', initialScannerDefaults())
    const sameUser = applyAuthIdentityBoundary(queryClient, 'user-b', 'user-b')
    expect(sameUser).toBe(false)
    expect(scannerSessionStore.load('user-b')).not.toBeNull()
  })
})
