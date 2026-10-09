/**
 * Recording stand-in for `npm:@supabase/supabase-js` for the P201 edge harness (harness.mjs).
 *
 * It is a data source and a flight recorder, not logic under test: every operation the Edge
 * Function issues (table, operation, payload, filters) is appended to `globalThis.__ops`, and the
 * answer comes from the scenario installed on `globalThis.__scenario.db`:
 *
 *   db.rows[table]            rows a plain select resolves to (filters ignored)
 *   db.data[table]            rows a select is evaluated AGAINST: eq / neq / in / lte / gte filters are
 *                             applied, so a cache lookup returns what the real query would
 *   db.single[table]          row `.single()` / `.maybeSingle()` resolves to (default: a synthetic id)
 *   db.counts[table]          `count` for a `{ count: 'exact', head: true }` select
 *   db.rpc[name]              { data } or { error } for `rpc(name)`
 *   db.fail["table:op"]       { message, code } -> that operation answers with an error
 *   db.failFirst["table:op"]  number -> only the first N matching calls fail (a transient fault)
 *
 * Nothing here talks to a network or to Postgres, so a scenario can reproduce a partially failed
 * batch, a rejected chunk, or a database outage deterministically.
 */
const ops = (globalThis.__ops = [])
const failedSoFar = new Map()
let idCounter = 0

function scenarioDb() {
  return globalThis.__scenario?.db ?? {}
}

function failureFor(table, op) {
  const key = `${table}:${op}`
  const db = scenarioDb()
  const limit = db.failFirst?.[key]
  if (limit !== undefined) {
    const used = failedSoFar.get(key) ?? 0
    if (used < limit) {
      failedSoFar.set(key, used + 1)
      return { message: `injected transient failure for ${key}`, code: 'XX000' }
    }
    return null
  }
  return db.fail?.[key] ?? null
}

class Query {
  constructor(table) {
    this.table = table
    this.op = 'select'
    this.payload = undefined
    this.filters = []
    this.opts = {}
    this.wantSingle = false
  }
  select(_columns, opts) {
    this.opts = { ...this.opts, ...(opts ?? {}) }
    return this
  }
  insert(payload) {
    this.op = 'insert'
    this.payload = payload
    return this
  }
  upsert(payload, opts) {
    this.op = 'upsert'
    this.payload = payload
    this.opts = { ...this.opts, ...(opts ?? {}) }
    return this
  }
  update(payload) {
    this.op = 'update'
    this.payload = payload
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }
  _filter(kind, column, value) {
    this.filters.push([kind, column, value])
    return this
  }
  eq(column, value) {
    return this._filter('eq', column, value)
  }
  neq(column, value) {
    return this._filter('neq', column, value)
  }
  in(column, value) {
    return this._filter('in', column, value)
  }
  not(column, operator, value) {
    return this._filter(`not.${operator}`, column, value)
  }
  lte(column, value) {
    return this._filter('lte', column, value)
  }
  gte(column, value) {
    return this._filter('gte', column, value)
  }
  order() {
    return this
  }
  limit() {
    return this
  }
  single() {
    this.wantSingle = true
    return this
  }
  maybeSingle() {
    this.wantSingle = true
    return this
  }
  _matches(row) {
    return this.filters.every(([kind, column, value]) => {
      const cell = row[column]
      if (kind === 'eq') return cell === value
      if (kind === 'neq') return cell !== value
      if (kind === 'in') return Array.isArray(value) && value.includes(cell)
      if (kind === 'lte') return cell <= value
      if (kind === 'gte') return cell >= value
      return true
    })
  }
  _settle() {
    const failure = failureFor(this.table, this.op)
    ops.push({
      table: this.table,
      op: this.op,
      payload: this.payload,
      filters: this.filters,
      failed: failure !== null,
    })
    if (failure !== null) return { data: null, error: failure, count: null }
    const db = scenarioDb()
    if (this.opts.head === true) {
      return { data: null, error: null, count: db.counts?.[this.table] ?? 0 }
    }
    if (this.op === 'select' && db.data?.[this.table] !== undefined) {
      const matching = db.data[this.table].filter((row) => this._matches(row))
      return this.wantSingle
        ? { data: matching[0] ?? null, error: null, count: null }
        : { data: matching, error: null, count: matching.length }
    }
    if (this.wantSingle) {
      const configured = db.single?.[this.table]
      if (configured !== undefined) return { data: configured, error: null, count: null }
      if (this.op === 'upsert' || this.op === 'insert') {
        return { data: { id: `${this.table}-${++idCounter}` }, error: null, count: null }
      }
      return { data: null, error: null, count: null }
    }
    if (this.op === 'upsert' || this.op === 'insert') {
      const n = Array.isArray(this.payload) ? this.payload.length : 1
      return { data: null, error: null, count: this.opts.count === 'exact' ? n : null }
    }
    return { data: db.rows?.[this.table] ?? [], error: null, count: null }
  }
  then(resolve, reject) {
    return Promise.resolve(this._settle()).then(resolve, reject)
  }
}

export function createClient() {
  return {
    from: (table) => new Query(table),
    rpc(name, args) {
      const failure = failureFor(`rpc:${name}`, 'call')
      ops.push({
        table: `rpc:${name}`,
        op: 'call',
        payload: args,
        filters: [],
        failed: failure !== null,
      })
      const configured = scenarioDb().rpc?.[name]
      const result =
        failure !== null
          ? { data: null, error: failure }
          : configured !== undefined
            ? { error: null, data: null, ...configured }
            : { data: null, error: null }
      return Promise.resolve(result)
    },
  }
}
