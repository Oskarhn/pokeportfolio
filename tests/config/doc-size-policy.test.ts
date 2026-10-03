/**
 * Unit tests for the P176 doc-size budget policy (scripts/lib/doc-size-policy.mjs), which backs
 * scripts/check-doc-size.mjs. HANDOVER.md grew past 260 KB before this existed — these tests pin
 * the exact thresholds so the budget can't silently drift.
 */
import { describe, expect, it } from 'vitest'
import { BUDGETS, evaluateDocSize } from '../../scripts/lib/doc-size-policy.mjs'

describe('evaluateDocSize', () => {
  it('reports ok well under budget', () => {
    const result = evaluateDocSize('HANDOVER.md', 20_000, BUDGETS.HANDOVER)
    expect(result.level).toBe('ok')
  })

  it('reports warn once past the warn threshold but under the fail threshold', () => {
    const result = evaluateDocSize('HANDOVER.md', 36_000, BUDGETS.HANDOVER)
    expect(result.level).toBe('warn')
  })

  it('reports fail once past the hard limit', () => {
    const result = evaluateDocSize('HANDOVER.md', 50_001, BUDGETS.HANDOVER)
    expect(result.level).toBe('fail')
  })

  it('the historical HANDOVER.md size (268,674 bytes) would fail under this policy', () => {
    const result = evaluateDocSize('HANDOVER.md', 268_674, BUDGETS.HANDOVER)
    expect(result.level).toBe('fail')
  })

  it('PROJECT_STATE.json fails past its 15 KB hard limit', () => {
    const result = evaluateDocSize('docs/PROJECT_STATE.json', 15_001, BUDGETS.PROJECT_STATE)
    expect(result.level).toBe('fail')
  })

  it('CURRENT_STATE docs have no hard fail threshold — only warn', () => {
    const result = evaluateDocSize(
      'docs/CURRENT_STATE/NATIVE_MOBILE.md',
      1_000_000,
      BUDGETS.CURRENT_STATE_DOC,
    )
    expect(result.level).toBe('warn')
  })

  it('boundary: exactly at the warn threshold is still ok (strictly greater-than triggers warn)', () => {
    const result = evaluateDocSize('HANDOVER.md', BUDGETS.HANDOVER.warnBytes, BUDGETS.HANDOVER)
    expect(result.level).toBe('ok')
  })

  it('boundary: exactly at the fail threshold is warn, not fail (strictly greater-than triggers fail)', () => {
    const result = evaluateDocSize('HANDOVER.md', BUDGETS.HANDOVER.failBytes ?? 0, BUDGETS.HANDOVER)
    expect(result.level).toBe('warn')
  })
})
