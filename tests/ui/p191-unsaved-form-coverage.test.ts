import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirtyByDiffBaseline } from '../../src/platform/unsaved-work-registry'

/**
 * P130-09: an automatic stale-deployment reload must not discard a form the user is typing into.
 * The registry (platform/unsaved-work-registry.ts) already deferred the reload for the purchase and
 * sale forms and the scanner batch; P191 registers Add card, Add sealed, Manual card and the
 * Openings wizard. No draft persistence was invented: the reload is deferred while the form is
 * dirty and the user is offered the choice, exactly as for the forms that were already covered.
 */

const REQUIRED: [string, string][] = [
  ['purchase-form', 'src/features/purchases/PurchaseFormPage.tsx'],
  ['purchase-edit-form', 'src/features/purchases/PurchaseEditPage.tsx'],
  ['sale-form', 'src/features/sales/SaleFormPage.tsx'],
  ['sale-edit-form', 'src/features/sales/SaleEditPage.tsx'],
  ['add-card-form', 'src/features/collection/AddToCollectionPage.tsx'],
  ['add-sealed-form', 'src/features/collection/AddSealedProductPage.tsx'],
  ['manual-card-form', 'src/features/collection/ManualCardPage.tsx'],
  ['opening-wizard', 'src/features/openings/OpeningsWizardPage.tsx'],
]

describe('every form that holds typed input registers with the unsaved-work registry', () => {
  for (const [id, file] of REQUIRED) {
    it(`${id} is registered by ${file}`, () => {
      const text = readFileSync(file, 'utf8')
      expect(text).toMatch(new RegExp(`useUnsavedWorkSnapshot\\(\\s*'${id}'`))
    })
  }

  it('no money field is ever zero-filled to look unedited: blank and 0 are different snapshots', () => {
    const tracker = new DirtyByDiffBaseline()
    tracker.captureBaseline(JSON.stringify({ costPerCard: '' }))
    expect(tracker.isDirty(JSON.stringify({ costPerCard: '' }))).toBe(false)
    expect(tracker.isDirty(JSON.stringify({ costPerCard: '0' }))).toBe(true)
    // …and the exact typed string is what is compared, not a number.
    expect(tracker.isDirty(JSON.stringify({ costPerCard: '12.50' }))).toBe(true)
  })

  it('an identity switch resets the baseline (a different user never inherits a dirty form)', () => {
    const tracker = new DirtyByDiffBaseline()
    expect(tracker.observeResetKey('user-a|card-1')).toBe(true)
    tracker.captureBaseline('{"quantity":"1"}')
    expect(tracker.isDirty('{"quantity":"5"}')).toBe(true)
    expect(tracker.observeResetKey('user-b|card-1')).toBe(true)
    expect(tracker.isDirty('{"quantity":"5"}')).toBe(false)
  })
})

class FakeWindow extends EventTarget {
  location = { reload: vi.fn() }
}
class FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'hidden'
}
class FakeServiceWorkerContainer extends EventTarget {
  controller: object | null = {}
}

describe('the stale-deployment reload defers while a newly registered form is dirty', () => {
  let fakeWindow: FakeWindow
  let sw: FakeServiceWorkerContainer

  beforeEach(() => {
    vi.resetModules()
    fakeWindow = new FakeWindow()
    sw = new FakeServiceWorkerContainer()
    vi.stubGlobal('window', fakeWindow)
    vi.stubGlobal('document', new FakeDocument())
    vi.stubGlobal('navigator', { serviceWorker: sw })
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined })
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const id of ['add-card-form', 'add-sealed-form', 'manual-card-form', 'opening-wizard']) {
    it(`${id} dirty: no automatic reload, a prompt instead; clean: the reload proceeds`, async () => {
      const registry = await import('../../src/platform/unsaved-work-registry')
      const runtime = await import('../../src/platform/build-freshness-runtime')
      let dirty = true
      const unregister = registry.registerUnsavedWorkSource(id, () => dirty)
      runtime.initBuildFreshnessWatch()

      sw.dispatchEvent(new Event('controllerchange'))
      expect(runtime.getStaleDeploymentSnapshot().action).toBe('prompt')
      expect(fakeWindow.location.reload).not.toHaveBeenCalled()

      dirty = false
      runtime.retryStaleDeploymentAction()
      expect(fakeWindow.location.reload).toHaveBeenCalledOnce()
      unregister()
    })
  }

  it('mutation: with NO registered source the same controllerchange reloads straight away', async () => {
    const runtime = await import('../../src/platform/build-freshness-runtime')
    runtime.initBuildFreshnessWatch()
    sw.dispatchEvent(new Event('controllerchange'))
    expect(fakeWindow.location.reload).toHaveBeenCalledOnce()
  })
})
