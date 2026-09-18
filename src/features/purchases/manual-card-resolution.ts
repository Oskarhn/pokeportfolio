/**
 * P138 fixed P130-05 (a manual-card line's definition was created fresh on every submit attempt,
 * defeating `create_purchase`'s own idempotency on retry) by caching each resolved id in a
 * `useRef(new Map())` directly inside `PurchaseFormPage`. P140 extracts that cache — and the
 * resolve-or-create step that reads/writes it — into this pure module so it is directly
 * unit-testable without a React renderer (this repository has none — see
 * `tests/ui/sale-form-entity-isolation.test.ts`'s own doc). `PurchaseFormPage.tsx` imports and
 * calls these exact functions; nothing here is a re-implementation the component might drift
 * from.
 *
 * Keyed by `${lineId}:${trimmedName}` — line id, not the card name alone, so two unrelated lines
 * that happen to share a name are never conflated (§6 "separate lines with identical name"); the
 * trimmed name is part of the key, not just the line id, so a genuine identity change — the user
 * editing the manual card's name before retrying — still resolves a new id rather than silently
 * reusing a stale one (§6 "name changed"). Mirrors `OpeningsWizardPage`'s existing
 * `resolvedManualCards` pattern (P56 §10).
 */

export class ManualCardResolutionCache {
  private readonly resolved = new Map<string, string>()

  private key(lineId: string, trimmedName: string): string {
    return `${lineId}:${trimmedName}`
  }

  get(lineId: string, trimmedName: string): string | undefined {
    return this.resolved.get(this.key(lineId, trimmedName))
  }

  set(lineId: string, trimmedName: string, manualCardId: string): void {
    this.resolved.set(this.key(lineId, trimmedName), manualCardId)
  }

  /** Discards every resolution this cache holds — called when the identity that resolved them is
   *  no longer the one that would submit them (P140 §6 "identity A -> B"): a `manual_card_id`
   *  created under A must never be reused for a line B goes on to submit, even though RLS would
   *  independently refuse B's purchase from referencing a card row it doesn't own (client state
   *  must be isolated correctly on its own — see `platform/entity-key-change-tracker.ts`'s doc). */
  clear(): void {
    this.resolved.clear()
  }

  /** Test/diagnostic only — not used by `PurchaseFormPage` itself. */
  size(): number {
    return this.resolved.size
  }
}

export interface ManualCardCreator {
  createManualCard(input: { name: string }): Promise<{ id: string }>
}

/**
 * Resolves the `manual_card_id` for one purchase line: reuses a previously resolved id for the
 * exact same `(lineId, trimmedName)` pair (same intent, retried), or creates a fresh manual card
 * definition and caches it (first attempt, or a genuinely edited name). Mirrors
 * `PurchaseFormPage.tsx`'s `mutationFn` line-processing loop exactly — that loop calls this
 * function instead of duplicating its body.
 */
export async function resolveManualCardId(
  cache: ManualCardResolutionCache,
  lineId: string,
  trimmedName: string,
  creator: ManualCardCreator,
): Promise<string> {
  const cached = cache.get(lineId, trimmedName)
  if (cached) return cached
  const created = await creator.createManualCard({ name: trimmedName })
  cache.set(lineId, trimmedName, created.id)
  return created.id
}
