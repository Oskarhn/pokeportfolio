export const HELDOUT_REGIMES: string[]

export function applyHeldoutRegime(
  regimeName: string,
  buffer: Buffer,
  cardId: string,
): Promise<Buffer>

export function buildAllHeldoutQueries(
  buffer: Buffer,
  cardId: string,
  regimes?: string[],
): Promise<Record<string, Buffer>>
