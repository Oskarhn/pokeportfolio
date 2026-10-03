/**
 * Production erasure registry (P195): a Cloudflare Worker in front of one Durable Object that
 * holds the append-only, HMAC-chained ledger (SQLite storage, strongly consistent, one writer).
 *
 *   POST /v1/erasures   append token     the delete-account Edge Function's only capability
 *   GET  /v1/head       operator token   {"seq","mac","records"}
 *   GET  /v1/export     operator token   the whole chain, registry NDJSON, fully re-verified
 *
 * Everything else — including every unauthenticated request — answers 401/404 without detail.
 * There is no listing, no update and no delete route; the ledger table additionally aborts UPDATE
 * and DELETE in SQL. The HMAC root key lives only in this Worker's secrets: the Supabase function
 * holds the append token and nothing else, so it can add an erasure but cannot read, forge or
 * rewrite the chain.
 *
 * Secrets (never in the repository): ERASURE_REGISTRY_KEY (>= 64 hex), ERASURE_APPEND_TOKEN and
 * ERASURE_OPERATOR_TOKEN (>= 24 characters each, different from one another).
 *
 * Contract: scripts/restore-gate/registry-sink.ts. Design record: docs/security/P195_ERASURE_REGISTRY.md.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { Ledger, LedgerError, parseKey, type LedgerSql } from './ledger'

const MAX_BODY = 2048

/** The few workerd types this file touches; the full set is not a dependency of this repository. */
interface SqlCursor {
  toArray(): Record<string, unknown>[]
}
interface DurableObjectState {
  storage: {
    sql: { exec(query: string, ...bindings: unknown[]): SqlCursor }
    transactionSync<T>(fn: () => T): T
  }
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>
}
interface DurableObjectNamespace {
  idFromName(name: string): unknown
  get(id: unknown): DurableObjectStub
}
export interface Env {
  LEDGER: DurableObjectNamespace
  ERASURE_REGISTRY_KEY?: string
  ERASURE_APPEND_TOKEN?: string
  ERASURE_OPERATOR_TOKEN?: string
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

function tokenEquals(supplied: string, expected: string): boolean {
  // Hash first so the comparison is over equal-length digests whatever the input length.
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function configured(env: Env): { append: string; operator: string } | null {
  const append = env.ERASURE_APPEND_TOKEN?.trim()
  const operator = env.ERASURE_OPERATOR_TOKEN?.trim()
  if (!append || !operator || append.length < 24 || operator.length < 24) return null
  if (append === operator) return null
  try {
    parseKey(env.ERASURE_REGISTRY_KEY)
  } catch {
    return null
  }
  return { append, operator }
}

async function readLimited(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    all.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder().decode(all)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const tokens = configured(env)
    if (!tokens) return json(503, { error: 'not_configured' })

    const bearer = /^Bearer\s+(\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1]
    // Evaluate both so the time taken does not reveal which credential class matched.
    const isAppend = bearer ? tokenEquals(bearer, tokens.append) : false
    const isOperator = bearer ? tokenEquals(bearer, tokens.operator) : false
    if (!isAppend && !isOperator) {
      void request.body?.cancel()
      return json(401, { error: 'unauthorized' })
    }

    const { pathname } = new URL(request.url)
    const stub = env.LEDGER.get(env.LEDGER.idFromName('erasures'))

    if (request.method === 'POST' && pathname === '/v1/erasures') {
      if (!isAppend) return json(403, { error: 'forbidden' })
      const text = await readLimited(request, MAX_BODY)
      if (text === null) return json(413, { error: 'too_large' })
      return stub.fetch(new Request('https://ledger/append', { method: 'POST', body: text }))
    }
    if (request.method === 'GET' && (pathname === '/v1/head' || pathname === '/v1/export')) {
      if (!isOperator) return json(403, { error: 'forbidden' })
      return stub.fetch(new Request(`https://ledger/${pathname.slice(4)}`, { method: 'GET' }))
    }
    void request.body?.cancel()
    return json(404, { error: 'not_found' })
  },
}

export class ErasureLedger {
  private readonly ledger: Ledger | null
  constructor(state: DurableObjectState, env: Env) {
    const sql: LedgerSql = {
      all: (query, ...b) => state.storage.sql.exec(query, ...b).toArray(),
      run: (query, ...b) => {
        state.storage.sql.exec(query, ...b)
      },
      transaction: (fn) => state.storage.transactionSync(fn),
    }
    try {
      this.ledger = new Ledger(sql, parseKey(env.ERASURE_REGISTRY_KEY))
    } catch {
      this.ledger = null
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.ledger) return json(503, { error: 'not_configured' })
    const { pathname } = new URL(request.url)
    try {
      if (request.method === 'GET' && pathname === '/head') return json(200, this.ledger.head())
      if (request.method === 'GET' && pathname === '/export') {
        return new Response(this.ledger.exportNdjson(), {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' },
        })
      }
      if (request.method === 'POST' && pathname === '/append') {
        let body: Record<string, unknown> | null
        try {
          body = JSON.parse(await request.text()) as Record<string, unknown> | null
        } catch {
          return json(400, { error: 'bad_request' })
        }
        if (
          body === null ||
          typeof body !== 'object' ||
          body.scope !== 1 ||
          typeof body.deletion_id !== 'string' ||
          typeof body.subject !== 'string' ||
          typeof body.deleted_at !== 'string'
        ) {
          return json(400, { error: 'bad_request' })
        }
        const { record, created } = this.ledger.append({
          deletion_id: body.deletion_id,
          subject: body.subject,
          deleted_at: body.deleted_at,
        })
        return json(created ? 201 : 200, {
          status: 'recorded',
          seq: record.seq,
          deletion_id: record.deletion_id,
          subject: record.subject,
        })
      }
    } catch (e) {
      if (e instanceof LedgerError && e.code === 'malformed')
        return json(400, { error: 'bad_request' })
      if (e instanceof LedgerError && e.code === 'conflict') return json(409, { error: 'conflict' })
      return json(500, { error: 'registry_unavailable' })
    }
    return json(404, { error: 'not_found' })
  }
}
