import { describe, expect, it } from 'vitest'
import { hasUnsavedScannerWork, setScannerBatchSize } from '../../src/features/scanner/unsaved-work'

describe('scanner unsaved-work registry (P83, D-100)', () => {
  it('reports no unsaved work by default and once cleared back to zero', () => {
    setScannerBatchSize(0)
    expect(hasUnsavedScannerWork()).toBe(false)
  })

  it('reports unsaved work while the batch is nonempty', () => {
    setScannerBatchSize(1)
    expect(hasUnsavedScannerWork()).toBe(true)
    setScannerBatchSize(3)
    expect(hasUnsavedScannerWork()).toBe(true)
    setScannerBatchSize(0)
    expect(hasUnsavedScannerWork()).toBe(false)
  })
})
