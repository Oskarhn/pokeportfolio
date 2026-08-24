import { describe, expect, it } from 'vitest'

import type { ExportArtifact } from '../../src/features/export/contract'
import {
  describeReady,
  reduceExportFlow,
  type ExportFlowState,
} from '../../src/features/export/exportFlow'

/**
 * The two-step export flow (D-077): generation completes FIRST, delivery happens under a fresh
 * tap. These tests pin the state transitions, including that a failed delivery RETAINS the
 * artifacts (retry delivery / download instead must not regenerate), and that nothing ever
 * leaves memory-only state.
 */

function artifact(name: string): ExportArtifact {
  return { filename: name, blob: new Blob(['synthetic'], { type: 'text/csv' }) }
}

const IDLE: ExportFlowState = { phase: 'idle' }

describe('export two-step flow', () => {
  it('idle → preparing → ready holds the generated artifacts in memory only', () => {
    let state = reduceExportFlow(IDLE, { type: 'PREPARE', kind: 'backup' })
    expect(state.phase).toBe('preparing')

    const artifacts = [artifact('pokeportfolio-backup-2026-08-24.json')]
    state = reduceExportFlow(state, { type: 'PREPARED', kind: 'backup', artifacts })
    expect(state.phase).toBe('ready')
    if (state.phase === 'ready') expect(state.artifacts).toBe(artifacts)
  })

  it('ready → delivering → success records the delivery outcome', () => {
    const artifacts = [artifact('holdings.csv')]
    let state: ExportFlowState = {
      phase: 'ready',
      kind: 'csv',
      artifacts,
    }
    state = reduceExportFlow(state, { type: 'DELIVER' })
    expect(state.phase).toBe('delivering')
    state = reduceExportFlow(state, {
      type: 'DELIVERED',
      outcome: { method: 'share', filenames: ['holdings.csv'] },
    })
    expect(state.phase).toBe('success')
  })

  it('a dismissed sheet is cancellation — quiet, not an error', () => {
    let state: ExportFlowState = { phase: 'delivering', kind: 'backup', artifacts: [] }
    state = reduceExportFlow(state, { type: 'DELIVERED', outcome: { method: 'cancelled' } })
    expect(state.phase).toBe('cancelled')
  })

  it('a failed delivery KEEPS the artifacts so retry/download need no regeneration', () => {
    const artifacts = [artifact('holdings.csv'), artifact('sales.csv')]
    let state: ExportFlowState = { phase: 'delivering', kind: 'csv', artifacts }
    state = reduceExportFlow(state, {
      type: 'DELIVERY_FAILED',
      message: 'Your browser refused to open sharing for these files.',
    })
    expect(state.phase).toBe('delivery-failed')
    if (state.phase === 'delivery-failed') {
      expect(state.artifacts).toBe(artifacts)
      expect(state.message).toMatch(/refused to open sharing/)
    }

    // Retry delivery from the retained set.
    state = reduceExportFlow(state, { type: 'DELIVER' })
    expect(state.phase).toBe('delivering')
    state = reduceExportFlow(state, {
      type: 'DELIVERED',
      outcome: { method: 'download', filenames: ['holdings.csv', 'sales.csv'] },
    })
    expect(state.phase).toBe('success')
  })

  it('a failed generation produces no artifacts; retry regenerates from preparing', () => {
    let state = reduceExportFlow(IDLE, { type: 'PREPARE', kind: 'csv' })
    state = reduceExportFlow(state, { type: 'PREPARE_FAILED', kind: 'csv', message: 'offline' })
    expect(state.phase).toBe('prepare-failed')

    state = reduceExportFlow(state, { type: 'PREPARE', kind: 'csv' })
    expect(state.phase).toBe('preparing')
  })

  it('discard drops everything and returns to idle', () => {
    let state: ExportFlowState = {
      phase: 'ready',
      kind: 'backup',
      artifacts: [artifact('backup.json')],
    }
    state = reduceExportFlow(state, { type: 'DISCARD' })
    expect(state).toEqual({ phase: 'idle' })
  })

  it('stray events cannot move a mismatched state (e.g. PREPARED after failure)', () => {
    let state = reduceExportFlow({ ...IDLE }, { type: 'PREPARE', kind: 'backup' })
    state = reduceExportFlow(state, { type: 'PREPARE_FAILED', kind: 'backup', message: 'x' })
    state = reduceExportFlow(state, { type: 'PREPARED', kind: 'backup', artifacts: [] })
    expect(state.phase).toBe('prepare-failed')
  })

  it('labels are honest per kind', () => {
    expect(describeReady('csv')).toBe('CSV export')
    expect(describeReady('backup')).toBe('backup')
  })
})
