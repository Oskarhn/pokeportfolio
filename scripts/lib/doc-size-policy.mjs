/**
 * Size budget policy for the P176 current-state documentation set (HANDOVER.md,
 * docs/PROJECT_STATE.json, docs/CURRENT_STATE/*.md).
 *
 * WHY IT EXISTS. HANDOVER.md grew past 260 KB / 3,400 lines before P176 (docs/handover/README.md
 * has the history) — too large for a fresh session to read whole. This module encodes the size
 * discipline that is meant to keep it from happening again, as pure, independently testable
 * functions (`scripts/check-doc-size.mjs` is a thin CLI wrapper over this).
 *
 * Only HANDOVER.md and PROJECT_STATE.json are hard gates. Pre-existing canonical docs
 * (DECISIONS.md, PROJECT_JOURNAL.md, etc.) are already large for legitimate historical reasons —
 * this policy does not retroactively fail CI for them; CURRENT_STATE/*.md gets a warning only.
 */

export const BUDGETS = {
  HANDOVER: { warnBytes: 35_000, failBytes: 50_000, label: 'HANDOVER.md' },
  PROJECT_STATE: { warnBytes: 8_000, failBytes: 15_000, label: 'docs/PROJECT_STATE.json' },
  CURRENT_STATE_DOC: { warnBytes: 30_000, failBytes: null, label: 'docs/CURRENT_STATE/*.md' },
}

/**
 * @param {string} label
 * @param {number} bytes
 * @param {{ warnBytes: number, failBytes: number | null }} budget
 * @returns {{ label: string, bytes: number, level: 'ok' | 'warn' | 'fail', message: string }}
 */
export function evaluateDocSize(label, bytes, budget) {
  if (budget.failBytes != null && bytes > budget.failBytes) {
    return {
      label,
      bytes,
      level: 'fail',
      message: `${label} is ${bytes} bytes, over the ${budget.failBytes}-byte hard limit`,
    }
  }
  if (bytes > budget.warnBytes) {
    return {
      label,
      bytes,
      level: 'warn',
      message: `${label} is ${bytes} bytes, over the ${budget.warnBytes}-byte warning threshold`,
    }
  }
  return { label, bytes, level: 'ok', message: `${label} is ${bytes} bytes (within budget)` }
}
