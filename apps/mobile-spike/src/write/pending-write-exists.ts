/**
 * P180 reconciliation read: "did the purchase/sale behind this idempotency key already commit".
 * A plain GET against `purchases`/`sales` filtered by `idempotency_key` — the same shape as
 * `fx-source.ts`'s `fxRateReaderFor`, over the SAME ambient read-only client (RLS already scopes
 * every row to its own owner; the read-only wire policy already allows a GET). This never uses the
 * write seam: reconciliation only needs to KNOW, never to write.
 */

export interface WriteExistsChecker {
  (idempotencyKey: string): Promise<boolean>
}

interface ExistsQueryClient {
  from(table: 'purchases' | 'sales'): unknown
}

interface ExistsChain {
  eq(column: string, value: string): ExistsChain
  maybeSingle(): PromiseLike<{
    data: { id: unknown } | null
    error: { message: string } | null
  }>
}

function checkerFor(client: ExistsQueryClient, table: 'purchases' | 'sales'): WriteExistsChecker {
  return async (idempotencyKey) => {
    const chain = (client.from(table) as { select(columns: string): ExistsChain }).select('id')
    const { data, error } = await chain.eq('idempotency_key', idempotencyKey).maybeSingle()
    if (error !== null) throw new Error(`reconciliation read failed: ${error.message}`)
    return data !== null
  }
}

export function purchaseExistsCheckerFor(client: ExistsQueryClient): WriteExistsChecker {
  return checkerFor(client, 'purchases')
}

export function saleExistsCheckerFor(client: ExistsQueryClient): WriteExistsChecker {
  return checkerFor(client, 'sales')
}
