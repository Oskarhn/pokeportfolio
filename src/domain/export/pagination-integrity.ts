/**
 * Export completeness detection (M13, D-073) — the pure half of the page walker.
 *
 * The export reads each section as a sequence of PostgREST range pages ordered by the table's
 * primary key. That is OFFSET pagination with stable deterministic ordering — NOT keyset
 * pagination — and an offset walk has two silent failure modes when the source changes between
 * pages (a concurrent mutation re-soring rows, or rows appearing/disappearing):
 * truncation, gaps and duplicates can all hide inside pages that individually look healthy.
 * P37's independent oracle demonstrated exactly this with fault-injected sources.
 *
 * This module closes those holes for a self-export under RLS:
 *
 *   1. duplicate identity-key detection ACROSS pages (a re-sort or double-read names both
 *      indexes in the error);
 *   2. exact final received-count reconciliation against the table's own COUNT, taken once at
 *      the start of the walk (catches truncation, missing tails and gaps);
 *   3. the caller keeps its max-page loop guard and short-page stop.
 *
 * Honest scope (D-076): this is detection, not snapshot isolation. A multi-query client-side
 * export is not one PostgreSQL transaction; if rows mutate mid-export the count check or the
 * duplicate check will usually — not provably always — catch it, and the export FAILS LOUDLY
 * rather than writing a quietly incomplete backup. See backup-format.ts's header for what the
 * format promises.
 */

/** Raised when a section walk detects duplicates, truncation or a count mismatch. */
export class ExportIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportIntegrityError'
  }
}

export interface SectionWalk {
  /** Feed one landed page through the checks. Throws on a cross-page duplicate key. */
  observe(rows: readonly unknown[]): void
  /**
   * Reconcile the walk against the expected total row count. Throws on any mismatch.
   * `expectedTotal` may be null only when the source could not produce a count — never in
   * production paths.
   */
  finish(expectedTotal: number | null): void
  readonly received: number
}

/** Builds the identity key used for cross-page duplicate detection. */
function identityKey(row: unknown, keys: readonly string[]): string {
  if (typeof row !== 'object' || row === null) return String(row)
  const record = row as Record<string, unknown>
  return keys.map((key) => String(record[key])).join('\u0000')
}

/**
 * Starts one section's completeness bookkeeping. `identityKeys` are the section's primary-key
 * column(s) in the same order the fetch sorts by — single-column tables use ['id'], composite
 * join tables list both columns so the pair is what must stay unique.
 */
export function createSectionWalk(section: string, identityKeys: readonly string[]): SectionWalk {
  const seen = new Set<string>()
  let received = 0

  return {
    get received(): number {
      return received
    },
    observe(rows: readonly unknown[]): void {
      for (const row of rows) {
        const key = identityKey(row, identityKeys)
        if (seen.has(key)) {
          throw new ExportIntegrityError(
            `Export integrity: ${section} returned duplicate row ${JSON.stringify(key)} — ` +
              'the source reordered or repeated rows between pages. Re-run the export.',
          )
        }
        seen.add(key)
        received += 1
      }
    },
    finish(expectedTotal: number | null): void {
      if (expectedTotal === null) {
        throw new ExportIntegrityError(
          `Export integrity: ${section} produced no total count to reconcile against`,
        )
      }
      if (received !== expectedTotal) {
        throw new ExportIntegrityError(
          `Export integrity: ${section} received ${String(received)} of ${String(expectedTotal)} ` +
            'rows — the export would have been silently incomplete. Re-run the export.',
        )
      }
    },
  }
}
