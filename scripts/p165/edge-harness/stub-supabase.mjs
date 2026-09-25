/**
 * Stand-in for `npm:@supabase/supabase-js` when the search-prices Edge Function runs under the
 * harness (harness.mjs). It answers exactly the two read shapes that function issues, from the
 * scenario the harness installed on globalThis:
 *   db.from('card_variants').select(...).in('card_id', ids)          -> scenario.variantRows
 *   db.from('fx_rates').select('rate').eq('base_currency', c)... .maybeSingle() -> scenario.fx[c]
 * It is a data source, not logic under test: everything the function does WITH the rows (provider
 * mapping, headline choice, wire building, JSON encoding) is the function's own code.
 */
class Query {
  constructor(table) {
    this.table = table
    this.filters = {}
  }
  select() {
    return this
  }
  in() {
    return this
  }
  eq(column, value) {
    this.filters[column] = value
    return this
  }
  lte() {
    return this
  }
  order() {
    return this
  }
  limit() {
    return this
  }
  maybeSingle() {
    const rate = globalThis.__scenario.fx?.[this.filters.base_currency]
    return Promise.resolve({ data: rate === undefined ? null : { rate }, error: null })
  }
  // `await db.from('card_variants').select().in()` — the builder itself is awaited.
  then(resolve, reject) {
    return Promise.resolve({ data: globalThis.__scenario.variantRows, error: null }).then(
      resolve,
      reject,
    )
  }
}

export function createClient() {
  return { from: (table) => new Query(table) }
}
