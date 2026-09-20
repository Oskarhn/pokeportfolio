import { describe, expect, it } from 'vitest'
import { initialScannerState, scannerReducer } from '../../src/features/scanner/state'

/**
 * P151 — a photo that could not be used (corrupt, oversized, a pixel bomb) must be reported wherever
 * the picker can be opened, and must not linger into the next attempt. Before P151 the message was
 * rendered only in the camera step, so choosing a bad file from the start screen (or from "no
 * match") produced no feedback at all.
 */

const error = { title: 'Photo is too large', message: 'Choose a smaller photo.' }

describe('P151 — capture errors', () => {
  it('a failed pick from the start screen keeps the step and records the error for the intro view to show', () => {
    const failed = scannerReducer(initialScannerState, { type: 'CAPTURE_FAILED', error })
    expect(failed.step).toBe('intro')
    expect(failed.captureError).toEqual(error)
  })

  it('a failed pick from the no-match screen keeps that step and records the error', () => {
    const noMatch = scannerReducer(initialScannerState, {
      type: 'ANALYSIS_COMPLETED',
      analysis: { confidence: 'NO_MATCH', candidates: [] },
    })
    const failed = scannerReducer(noMatch, { type: 'CAPTURE_FAILED', error })
    expect(failed.step).toBe('no-match')
    expect(failed.captureError).toEqual(error)
  })

  it('every new attempt clears the stale error: start camera, retake, scan next, and a successful capture', () => {
    const failed = scannerReducer(initialScannerState, { type: 'CAPTURE_FAILED', error })
    for (const action of [
      { type: 'START_CAMERA_PRESSED' },
      { type: 'RETAKE_PRESSED' },
      { type: 'SCAN_NEXT_PRESSED' },
      { type: 'CAPTURE_SUCCEEDED' },
    ] as const) {
      expect(scannerReducer(failed, action).captureError).toBeNull()
    }
  })

  it('a later failure replaces, never stacks, an earlier one', () => {
    const first = scannerReducer(initialScannerState, { type: 'CAPTURE_FAILED', error })
    const second = scannerReducer(first, {
      type: 'CAPTURE_FAILED',
      error: { title: 'Photo could not be read', message: 'Choose a different photo.' },
    })
    expect(second.captureError?.title).toBe('Photo could not be read')
  })
})
