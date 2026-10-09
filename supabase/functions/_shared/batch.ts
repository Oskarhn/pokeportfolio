/**
 * Bounded-concurrency batch helper shared by sync-catalog, ingest-prices and search-prices (each
 * used to carry its own copy), plus the stop rule that keeps a failing provider from being hammered.
 *
 * `shouldStop` is consulted before every item is started. Items that were never started settle as
 * `rejected` with a `BatchSkippedError`, so a caller can tell "the provider failed for this item"
 * from "we chose not to ask" and must not treat the second as evidence about the card.
 */
import { ProviderError } from './provider-http.ts'

export class BatchSkippedError extends Error {
  constructor(reason: string) {
    super(`skipped: ${reason}`)
    this.name = 'BatchSkippedError'
  }
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  options: { shouldStop?: () => string | null } = {},
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      const stopReason = options.shouldStop?.() ?? null
      if (stopReason !== null) {
        results[i] = { status: 'rejected', reason: new BatchSkippedError(stopReason) }
        continue
      }
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) }
      } catch (error) {
        results[i] = { status: 'rejected', reason: error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export interface ProviderFailureTally {
  total: number
  byKind: Record<string, number>
  skipped: number
}

/** Counts a rejected result by failure class: `ProviderError.kind`, `skipped`, or `unexpected`. */
export function classifyFailure(reason: unknown): string {
  if (reason instanceof BatchSkippedError) return 'skipped'
  if (reason instanceof ProviderError) return reason.kind
  if (reason instanceof Error && reason.name === 'TcgdexNotFoundError') return 'not_found'
  if (reason instanceof Error && reason.name === 'TcgdexShapeError') return 'invalid_shape'
  return 'unexpected'
}

/**
 * Stop rule for one batch. Trips when the shared deadline has passed, or when the provider has
 * answered `rate_limited` / `server_error` / `timeout` too many times in total — at that point more
 * requests only add load to a provider that is already refusing us, and the rest of the batch
 * stays queued for the next scheduled tick (the queue is oldest-first, so nothing is lost).
 */
export function createBatchGuard(options: {
  deadlineMs: number
  now: () => number
  maxProviderFailures?: number
}) {
  const maxProviderFailures = options.maxProviderFailures ?? 5
  let providerFailures = 0
  let tripped: string | null = null
  return {
    shouldStop(): string | null {
      if (tripped !== null) return tripped
      if (options.now() >= options.deadlineMs) tripped = 'deadline'
      return tripped
    },
    record(reason: unknown): void {
      if (
        reason instanceof ProviderError &&
        (reason.kind === 'rate_limited' ||
          reason.kind === 'server_error' ||
          reason.kind === 'timeout' ||
          reason.kind === 'network')
      ) {
        providerFailures++
        if (providerFailures >= maxProviderFailures && tripped === null)
          tripped = 'provider_unhealthy'
      }
    },
    get tripReason(): string | null {
      return tripped
    },
  }
}
