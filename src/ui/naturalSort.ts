/**
 * Client-side counterpart to the database's `natural_sort_key()` (M7.1 prompt §72) — used only for
 * re-sorting an already-fetched, already-honest result set (Search's card-number sort over
 * `search_cards` results, which return in relevance order server-side). Same approach: split into
 * alternating digit/non-digit runs, zero-pad digit runs, compare lexically. Not required to be
 * byte-identical to the SQL version — both just need to order "4" < "9" < "10" < "H31" consistently
 * within their own context.
 */
export function naturalCompare(a: string, b: string): number {
  const key = (value: string) =>
    (value.match(/[0-9]+|[^0-9]+/g) ?? []).map((run) =>
      /^[0-9]+$/.test(run) ? run.padStart(8, '0') : run.toLowerCase(),
    )
  const ka = key(a)
  const kb = key(b)
  const len = Math.max(ka.length, kb.length)
  for (let i = 0; i < len; i++) {
    const pa = ka[i] ?? ''
    const pb = kb[i] ?? ''
    if (pa !== pb) return pa < pb ? -1 : 1
  }
  return 0
}
