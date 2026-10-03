/**
 * The erasure registry sink: the write side the delete-account Edge Function talks to (P189).
 *
 *   ERASURE_REGISTRY_KEY=<64+ hex> ERASURE_SINK_TOKEN=<random> \
 *     tsx scripts/restore-gate/registry-sink.ts --registry <file> [--port 8787] [--host 127.0.0.1]
 *
 * This is the REFERENCE implementation of the contract below, backed by a local file. It proves the
 * architecture and runs the test suites; it is NOT a production storage decision. Production needs
 * the same contract served from a system that is (a) not part of the database backups, (b) separately
 * backed up, (c) reachable from the Edge Function over HTTPS, and (d) append-only for the function's
 * credential. Where that runs — and what it costs — is an owner decision (docs/COST_POLICY.md); a
 * file on the machine you restore from satisfies "outside the backup domain" only if that machine's
 * disk is not what gets restored.
 *
 * Contract (version 1):
 *   POST /v1/erasures   Authorization: Bearer <token>
 *     body  {"deletion_id": uuid, "subject": hex64, "deleted_at": ISO8601 UTC, "scope": 1}
 *     200/201  {"status":"recorded","seq":n,"deletion_id":uuid,"subject":hex64}
 *     The record is on stable storage (fsync) BEFORE the answer is sent. Idempotent: repeating the
 *     request returns the same record. If the subject was already recorded under another deletion id
 *     the existing record (and its id) is returned. Anything else is an error status, never a 2xx.
 *   GET  /v1/head       {"seq":n,"mac":hex64,"records":n}
 *
 * The sink holds the HMAC key; the Edge Function holds only the bearer token, so a compromised
 * function can append (and nothing else), and cannot forge, rewrite or read the chain.
 */
import { createServer, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { RegistryError, RegistryStore, parseRegistryKey } from './erasure-registry'

const MAX_BODY = 2048

export interface SinkOptions {
  registryPath: string
  key: Buffer
  token: string
  host?: string
  port?: number
}

function tokenOk(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createSink(options: SinkOptions): Server {
  const store = new RegistryStore(options.registryPath, options.key)
  return createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!tokenOk(bearer, options.token)) {
      req.resume()
      send(401, { error: 'unauthorized' })
      return
    }
    if (req.method === 'GET' && req.url === '/v1/head') {
      try {
        send(200, store.read().head)
      } catch {
        send(500, { error: 'registry_unavailable' })
      }
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/erasures') {
      req.resume()
      send(404, { error: 'not_found' })
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) tooLarge = true
      else chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) {
        send(413, { error: 'too_large' })
        return
      }
      let body: Record<string, unknown> | null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> | null
      } catch {
        send(400, { error: 'bad_request' })
        return
      }
      if (
        body === null ||
        body.scope !== 1 ||
        typeof body.deletion_id !== 'string' ||
        typeof body.subject !== 'string' ||
        typeof body.deleted_at !== 'string'
      ) {
        send(400, { error: 'bad_request' })
        return
      }
      try {
        const { record, created } = store.append({
          deletion_id: body.deletion_id,
          subject: body.subject,
          deleted_at: body.deleted_at,
        })
        send(created ? 201 : 200, {
          status: 'recorded',
          seq: record.seq,
          deletion_id: record.deletion_id,
          subject: record.subject,
        })
      } catch (e) {
        if (e instanceof RegistryError && e.code === 'malformed_record') {
          send(400, { error: 'bad_request' })
          return
        }
        if (e instanceof RegistryError && e.code === 'conflicting_record') {
          send(409, { error: 'conflict' })
          return
        }
        // A registry that fails its own integrity check must stop accepting writes: appending to a
        // chain that does not verify would bury the damage.
        send(500, { error: 'registry_unavailable' })
      }
    })
  })
}

export function startSink(options: SinkOptions): Promise<Server> {
  const server = createSink(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      resolve(server)
    })
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const registry = arg('--registry')
  const token = process.env.ERASURE_SINK_TOKEN
  if (!registry || !token || token.length < 24) {
    console.error(
      'usage: registry-sink.ts --registry <file> [--port n] [--host h]  (env: ERASURE_REGISTRY_KEY, ERASURE_SINK_TOKEN >= 24 chars)',
    )
    process.exitCode = 64
    return
  }
  const key = parseRegistryKey(process.env.ERASURE_REGISTRY_KEY)
  const server = await startSink({
    registryPath: registry,
    key,
    token,
    host: arg('--host') ?? '127.0.0.1',
    port: Number(arg('--port') ?? '8787'),
  })
  const address = server.address()
  console.log(
    `erasure registry sink listening on ${typeof address === 'object' ? String(address?.port) : ''}`,
  )
}

if (process.argv[1] && /registry-sink\.ts$/.test(process.argv[1].replaceAll('\\', '/'))) {
  await main()
}
