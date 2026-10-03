import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraAcquisitionGuard } from '../../src/features/scanner/camera-acquisition-guard'
import { CaptureStore, type CapturedFrame } from '../../src/features/scanner/capture'
import { runGuardedCapture } from '../../src/features/scanner/guarded-capture'

/**
 * P151 — capture completing after a reset. The handlers below mirror ScannerPage's exactly (store
 * the frame, which allocates the object URL; report the error), so "live object URLs" here is the
 * same resource the page leaked when a frame finished encoding after unmount / Close / tab-hide.
 * Deferred promises are the barriers: no timing.
 */

let live: Set<string>
let counter = 0

beforeEach(() => {
  live = new Set()
  counter = 0
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => {
      counter += 1
      const url = `blob:cap-${String(counter)}`
      live.add(url)
      return url
    }),
    configurable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn((url: string) => {
      live.delete(url)
    }),
    configurable: true,
  })
})

afterEach(() => {
  delete (URL as unknown as Record<string, unknown>).createObjectURL
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL
})

function frame(tag: string): CapturedFrame {
  return {
    blob: new Blob([tag]),
    width: 100,
    height: 140,
    cardRect: { left: 0, top: 0, width: 100, height: 140 },
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The page's own wiring: frames go into the single-owner store, errors into a list. */
function pageWiring() {
  const store = new CaptureStore()
  const applied: string[] = []
  const errors: string[] = []
  return {
    store,
    applied,
    errors,
    handlers: {
      onFrame: (f: CapturedFrame) => {
        store.set(f)
        applied.push('frame')
      },
      onError: (e: unknown) => {
        errors.push(e instanceof Error ? e.message : 'unknown')
      },
    },
  }
}

describe('P151 — a capture that completes after a reset never reaches the store', () => {
  it('shutter frame finishing AFTER unmount/exit/hide (guard invalidated) is dropped: no object URL, no state change', async () => {
    const guard = new CameraAcquisitionGuard()
    const { store, applied, handlers } = pageWiring()
    const encode = deferred<CapturedFrame>()

    const run = runGuardedCapture(guard, () => encode.promise, handlers)
    guard.invalidate() // unmount cleanup / Close scanner / tab hidden
    store.clear() // the page's cleanup already emptied the store
    encode.resolve(frame('late'))
    await run

    expect(applied).toHaveLength(0)
    expect(store.get()).toBeNull()
    expect(live.size).toBe(0)
  })

  it('a failed capture that settles after the reset raises no error over the screen that moved on', async () => {
    const guard = new CameraAcquisitionGuard()
    const { errors, handlers } = pageWiring()
    const encode = deferred<CapturedFrame>()
    const run = runGuardedCapture(guard, () => encode.promise, handlers)
    guard.invalidate()
    encode.reject(new Error('encode failed'))
    await run
    expect(errors).toHaveLength(0)
  })

  it('an un-invalidated capture still applies exactly once (the ordinary path is unchanged)', async () => {
    const guard = new CameraAcquisitionGuard()
    const { store, applied, errors, handlers } = pageWiring()
    await runGuardedCapture(guard, () => Promise.resolve(frame('ok')), handlers)
    expect(applied).toHaveLength(1)
    expect(errors).toHaveLength(0)
    expect(live.size).toBe(1)
    store.clear()
    expect(live.size).toBe(0)

    await runGuardedCapture(guard, () => Promise.reject(new Error('boom')), handlers)
    expect(errors).toEqual(['boom'])
  })

  it('two overlapping file picks: the LAST one started wins even if the FIRST finishes decoding last', async () => {
    for (const order of ['first-decodes-last', 'first-decodes-first'] as const) {
      const guard = new CameraAcquisitionGuard()
      const { store, handlers } = pageWiring()
      const a = deferred<CapturedFrame>()
      const b = deferred<CapturedFrame>()
      const runA = runGuardedCapture(guard, () => a.promise, handlers)
      const runB = runGuardedCapture(guard, () => b.promise, handlers)
      if (order === 'first-decodes-last') {
        b.resolve(frame('B'))
        a.resolve(frame('A'))
      } else {
        a.resolve(frame('A'))
        b.resolve(frame('B'))
      }
      await Promise.all([runA, runB])
      expect(store.get()?.blob.size).toBe(1) // 'B'
      expect(await store.get()?.blob.text()).toBe('B')
      expect(live.size).toBe(1)
      store.clear()
      expect(live.size).toBe(0)
    }
  })

  it('a stale failure of the older pick cannot clobber the newer pick', async () => {
    const guard = new CameraAcquisitionGuard()
    const { errors, applied, handlers } = pageWiring()
    const a = deferred<CapturedFrame>()
    const b = deferred<CapturedFrame>()
    const runA = runGuardedCapture(guard, () => a.promise, handlers)
    const runB = runGuardedCapture(guard, () => b.promise, handlers)
    b.resolve(frame('B'))
    a.reject(new Error('A is corrupt'))
    await Promise.all([runA, runB])
    expect(applied).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })

  it('200 randomized capture/invalidate/complete interleavings leave zero live object URLs once the store is cleared', async () => {
    let seed = 0x151
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let round = 0; round < 200; round += 1) {
      const guard = new CameraAcquisitionGuard()
      const { store, handlers } = pageWiring()
      const pending: { d: ReturnType<typeof deferred<CapturedFrame>>; run: Promise<void> }[] = []
      const steps = 3 + Math.floor(random() * 8)
      for (let step = 0; step < steps; step += 1) {
        const roll = random()
        if (roll < 0.4) {
          const d = deferred<CapturedFrame>()
          pending.push({ d, run: runGuardedCapture(guard, () => d.promise, handlers) })
        } else if (roll < 0.6) {
          guard.invalidate()
        } else {
          const target = pending[Math.floor(random() * pending.length)]
          if (target !== undefined) {
            if (random() < 0.8) target.d.resolve(frame(`f${String(step)}`))
            else target.d.reject(new Error('x'))
          }
        }
      }
      guard.invalidate() // unmount
      store.clear()
      for (const item of pending) item.d.resolve(frame('after-unmount'))
      await Promise.all(pending.map((item) => item.run))
      // Anything that settled after the final invalidate must not have re-created a URL.
      expect(live.size).toBe(0)
    }
  })
})
