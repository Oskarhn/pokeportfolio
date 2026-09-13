export function hashBuffer(buffer: Buffer): string

export function hashReferenceIngredients(
  ingredients: readonly { label: string; buffer: Buffer }[],
): Map<string, string>

export class LeakageError extends Error {}

export function assertNoLeakage(
  cardId: string,
  regimeLabel: string,
  queryBuffer: Buffer,
  referenceIngredientHashes: Map<string, string>,
): void

export function assertNoLeakageAll(
  cardId: string,
  referenceIngredients: readonly { label: string; buffer: Buffer }[],
  queriesByRegime: Record<string, Buffer>,
): void
