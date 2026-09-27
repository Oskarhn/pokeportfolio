export interface SizeBudget {
  readonly warnBytes: number
  readonly failBytes: number | null
  readonly label: string
}

export interface DocSizeBudgets {
  readonly HANDOVER: SizeBudget
  readonly PROJECT_STATE: SizeBudget
  readonly CURRENT_STATE_DOC: SizeBudget
}

export const BUDGETS: DocSizeBudgets

export interface DocSizeEvaluation {
  readonly label: string
  readonly bytes: number
  readonly level: 'ok' | 'warn' | 'fail'
  readonly message: string
}

export function evaluateDocSize(label: string, bytes: number, budget: SizeBudget): DocSizeEvaluation
