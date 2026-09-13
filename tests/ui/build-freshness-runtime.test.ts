import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Browser wiring for build-freshness.ts (P83, D-100). The test environment runs under Node
 * (`environment: 'node'` in vite.config.ts, same reason tests/ui/scanner-visual-client.test.ts
 * documents) — `window`/`navigator.serviceWorker`/`sessionStorage`/`fetch` are stubbed with real
 * `EventTarget` instances rather than a real browser, following this suite's existing convention.
 *
 * Covers P83 §16 S8 (a controllerchange exposes new-version state) plus the runtime glue around
 * the pure S6/S7/S9 policy tests/ui/build-freshness.test.ts already covers directly.
 */

class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null = null
}

class FakeWindow extends EventTarget {
  location = { reload: vi.fn() }
}

/** F-41 (P89): the visibilitychange checkpoint lives on `document`, not `window` — a separate
 *  fake with its own mutable `visibilityState`, matching the real DOM shape. */
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'hidden'
}

class FakeSessionStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

let fakeWindow: FakeWindow
let fakeDocument: FakeDocument
let fakeServiceWorker: FakeServiceWorkerContainer
let fakeSessionStorage: FakeSessionStorage
let fetchMock: ReturnType<typeof vi.fn>

async function loadModules() {
  const runtime = await import('../../src/platform/build-freshness-runtime')
  const unsavedWork = await import('../../src/features/scanner/unsaved-work')
  return { runtime, unsavedWork }
}

beforeEach(() => {
  vi.resetModules()
  fakeWindow = new FakeWindow()
  fakeDocument = new FakeDocument()
  fakeServiceWorker = new FakeServiceWorkerContainer()
  fakeSessionStorage = new FakeSessionStorage()
  fetchMock = vi.fn()
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('navigator', { serviceWorker: fakeServiceWorker })
  vi.stubGlobal('sessionStorage', fakeSessionStorage)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('initBuildFreshnessWatch (P83 S8)', () => {
  it('S8: a controllerchange REPLACING an existing controller exposes new-version state', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    // Simulates a page that loaded already controlled by a previous Service Worker (a normal
    // repeat visit) — a controllerchange from here on is a genuinely newer deployment taking
    // over, not first-ever activation.
    fakeServiceWorker.controller = {}
    const stop = runtime.initBuildFreshnessWatch()

    expect(runtime.getStaleDeploymentSnapshot()).toEqual({ trigger: null, action: null })

    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))

    const snapshot = runtime.getStaleDeploymentSnapshot()
    expect(snapshot.trigger).toBe('controllerchange')
    expect(snapshot.action).toBe('reload')
    expect(fakeWindow.location.reload).toHaveBeenCalledOnce()

    stop()
  })

  it('ignores the FIRST controllerchange when no controller existed yet (first install is not staleness)', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fakeServiceWorker.controller = null
    runtime.initBuildFreshnessWatch()

    // The very first activation of this tab's own Service Worker — must NOT be treated as "a
    // newer deployment exists" (this exact bug reloaded two unrelated E2E specs mid-test before
    // being caught and fixed).
    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))
    expect(runtime.getStaleDeploymentSnapshot()).toEqual({ trigger: null, action: null })
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()

    // A SECOND controllerchange during the same page lifetime — a genuinely different Service
    // Worker replacing the one that just took over — IS real staleness.
    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))
    expect(runtime.getStaleDeploymentSnapshot().trigger).toBe('controllerchange')
    expect(fakeWindow.location.reload).toHaveBeenCalledOnce()
  })

  it('notifies subscribers when state changes', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fakeServiceWorker.controller = {}
    const listener = vi.fn()
    const unsubscribe = runtime.subscribeStaleDeployment(listener)
    runtime.initBuildFreshnessWatch()

    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))

    expect(listener).toHaveBeenCalled()
    unsubscribe()
  })

  it('a chunk-load failure via vite:preloadError is classified, prevented, and recovered', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    runtime.initBuildFreshnessWatch()

    const event = new Event('vite:preloadError', { cancelable: true })
    Object.assign(event, {
      payload: new Error("'text/html' is not a valid JavaScript MIME type"),
    })
    fakeWindow.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(runtime.getStaleDeploymentSnapshot().trigger).toBe('chunk-load-failure')
    expect(fakeWindow.location.reload).toHaveBeenCalledOnce()
  })

  it('a nonempty scanner batch blocks the automatic reload and surfaces a prompt instead', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(2)
    fakeServiceWorker.controller = {}
    runtime.initBuildFreshnessWatch()

    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))

    expect(runtime.getStaleDeploymentSnapshot().action).toBe('prompt')
    expect(fakeWindow.location.reload).not.toHaveBeenCalled()

    // Saving/discarding the batch, then retrying, now succeeds.
    unsavedWork.setScannerBatchSize(0)
    runtime.retryStaleDeploymentAction()
    expect(fakeWindow.location.reload).toHaveBeenCalledOnce()
  })

  it('an unrelated unhandledrejection is ignored', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    runtime.initBuildFreshnessWatch()

    const event = new Event('unhandledrejection')
    Object.assign(event, { reason: new Error('insufficient funds') })
    fakeWindow.dispatchEvent(event)

    expect(runtime.getStaleDeploymentSnapshot()).toEqual({ trigger: null, action: null })
  })

  it('unsubscribing stops further reactions', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    const stop = runtime.initBuildFreshnessWatch()
    stop()

    fakeServiceWorker.dispatchEvent(new Event('controllerchange'))

    expect(runtime.getStaleDeploymentSnapshot()).toEqual({ trigger: null, action: null })
  })
})

describe('checkForNewDeployment', () => {
  it('detects a newer deployed build via build-meta.json and is rate-limited', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sha: 'a-different-sha' }),
    })

    await runtime.checkForNewDeployment()
    expect(fetchMock).toHaveBeenCalledWith('/build-meta.json', { cache: 'no-store' })
    expect(runtime.getStaleDeploymentSnapshot().trigger).toBe('newer-deployment-detected')

    // A second call inside the cooldown window does not fetch again.
    await runtime.checkForNewDeployment()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does nothing when the deployed sha matches this bundle', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    const { APP_BUILD_SHA } = await import('../../src/platform/build-info')
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ sha: APP_BUILD_SHA }) })

    await runtime.checkForNewDeployment()
    expect(runtime.getStaleDeploymentSnapshot()).toEqual({ trigger: null, action: null })
  })

  it('a network failure is swallowed, never thrown', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fetchMock.mockRejectedValue(new Error('offline'))

    await expect(runtime.checkForNewDeployment()).resolves.toBeUndefined()
  })
})

describe('F-41 (P89): checkForNewDeployment is actually invoked, not merely callable', () => {
  it('a tab becoming visible triggers checkForNewDeployment via initBuildFreshnessWatch', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sha: 'a-different-sha' }),
    })
    const stop = runtime.initBuildFreshnessWatch()

    expect(fetchMock).not.toHaveBeenCalled()
    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    // checkForNewDeployment is async; let its microtask/fetch chain settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith('/build-meta.json', { cache: 'no-store' })
    expect(runtime.getStaleDeploymentSnapshot().trigger).toBe('newer-deployment-detected')
    stop()
  })

  it('a tab going hidden does NOT trigger a check', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sha: 'a-different-sha' }),
    })
    const stop = runtime.initBuildFreshnessWatch()

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
    stop()
  })

  it('stopping the watch removes the visibilitychange listener', async () => {
    const { runtime, unsavedWork } = await loadModules()
    unsavedWork.setScannerBatchSize(0)
    fetchMock.mockResolvedValue({ ok: true, json: () => Promise.resolve({ sha: 'x' }) })
    const stop = runtime.initBuildFreshnessWatch()
    stop()

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
