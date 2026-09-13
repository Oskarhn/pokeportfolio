import { describe, expect, it, vi } from 'vitest'
import {
  isChunkLoadFailure,
  resolveStaleDeploymentAction,
  RELOAD_LOOP_GUARD_MS,
  type BuildFreshnessDeps,
} from '../../src/platform/build-freshness'

/**
 * Pure decision logic (P83, D-100) — no DOM/Worker/ServiceWorker involved, matching the
 * dependency-injection style domain/scanner/visual-backend-selection.ts already established.
 * Covers the prompt's S5/S6/S7/S9 test list: classifying a stale-chunk failure, reloading when
 * safe, refusing to reload over unsaved scanner work, and not looping.
 */

function deps(overrides: Partial<BuildFreshnessDeps> = {}): BuildFreshnessDeps {
  return {
    hasUnsavedWork: () => false,
    now: () => 1_000_000,
    readLastReloadAt: () => null,
    writeLastReloadAt: vi.fn(),
    reload: vi.fn(),
    ...overrides,
  }
}

describe('isChunkLoadFailure (P83 S5)', () => {
  it('recognizes the exact MIME-type message the real iPhone report showed', () => {
    expect(isChunkLoadFailure(new Error("'text/html' is not a valid JavaScript MIME type"))).toBe(
      true,
    )
  })

  it("recognizes Vite's own dynamic-import failure wording", () => {
    expect(
      isChunkLoadFailure(new Error('Failed to fetch dynamically imported module: /assets/x.js')),
    ).toBe(true)
    expect(isChunkLoadFailure(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadFailure(new Error('Importing a module script failed'))).toBe(true)
  })

  it('accepts a plain string reason (e.g. an unhandledrejection payload) the same way', () => {
    expect(isChunkLoadFailure('failed to fetch dynamically imported module')).toBe(true)
  })

  it('never matches an unrelated application error', () => {
    expect(isChunkLoadFailure(new Error('insufficient funds'))).toBe(false)
    expect(isChunkLoadFailure(new TypeError('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadFailure(null)).toBe(false)
    expect(isChunkLoadFailure(undefined)).toBe(false)
    expect(isChunkLoadFailure({})).toBe(false)
  })
})

describe('resolveStaleDeploymentAction (P83 S6/S7/S9)', () => {
  it('S6: reloads immediately when there is no unsaved work and no recent reload', () => {
    const d = deps()
    const action = resolveStaleDeploymentAction(d)
    expect(action).toBe('reload')
    expect(d.reload).toHaveBeenCalledOnce()
    expect(d.writeLastReloadAt).toHaveBeenCalledWith(1_000_000)
  })

  it('S7: never reloads while a nonempty scanner batch (unsaved work) exists', () => {
    const d = deps({ hasUnsavedWork: () => true })
    const action = resolveStaleDeploymentAction(d)
    expect(action).toBe('prompt')
    expect(d.reload).not.toHaveBeenCalled()
    expect(d.writeLastReloadAt).not.toHaveBeenCalled()
  })

  it('S9: does not reload again inside the loop-guard window after a very recent reload', () => {
    const d = deps({ readLastReloadAt: () => 1_000_000 - 1000, now: () => 1_000_000 })
    expect(RELOAD_LOOP_GUARD_MS).toBeGreaterThan(1000)
    const action = resolveStaleDeploymentAction(d)
    expect(action).toBe('prompt')
    expect(d.reload).not.toHaveBeenCalled()
  })

  it('S9: reloads again once the loop-guard window has fully elapsed', () => {
    const d = deps({
      readLastReloadAt: () => 1_000_000 - RELOAD_LOOP_GUARD_MS - 1,
      now: () => 1_000_000,
    })
    const action = resolveStaleDeploymentAction(d)
    expect(action).toBe('reload')
    expect(d.reload).toHaveBeenCalledOnce()
  })
})
