import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundedPost, classifyHostileOutcome, type BoundedPostResult } from './lib/bounded-post'

/**
 * P196C: the harness that bounds hostile oversized-body requests must itself be trustworthy — it is
 * what lets a lost gateway response count as fail-closed evidence, so its classification is pinned
 * here without a Supabase stack (a local HTTP server stands in for the gateway).
 */

let server: http.Server
let url: string
let hang: Set<http.ServerResponse>

beforeAll(async () => {
  hang = new Set()
  server = http.createServer((req, res) => {
    if (req.url === '/refuse') {
      res.statusCode = 413
      res.end('{"error":"bad_request"}')
    } else if (req.url === '/ok') {
      res.statusCode = 200
      res.end('{}')
    } else {
      // Never answers: the measured gateway behaviour for a lost early refusal.
      hang.add(res)
      req.resume()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  for (const res of hang) res.destroy()
  server.closeAllConnections()
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve()
    }),
  )
})

const result = (overrides: Partial<BoundedPostResult>): BoundedPostResult => ({
  status: null,
  text: '',
  headers: {},
  bodyFlushed: false,
  transportFailed: false,
  elapsedMs: 0,
  ...overrides,
})

describe('classifyHostileOutcome', () => {
  it('413 is a refusal', () => {
    expect(classifyHostileOutcome(result({ status: 413 }))).toBe('refused')
  })

  it('no response after the whole body was handed over is a fail-closed transport failure', () => {
    expect(
      classifyHostileOutcome(result({ status: null, transportFailed: true, bodyFlushed: true })),
    ).toBe('fail-closed-transport')
  })

  it('a client that gave up BEFORE the body was sent proves nothing: violation', () => {
    expect(
      classifyHostileOutcome(result({ status: null, transportFailed: true, bodyFlushed: false })),
    ).toBe('violation')
  })

  it.each([200, 201, 204, 400, 401, 403, 500, 502])(
    'status %i is not a refusal of an oversize body',
    (status) => {
      expect(classifyHostileOutcome(result({ status, bodyFlushed: true }))).toBe('violation')
    },
  )
})

describe('boundedPost', () => {
  const headers = { 'Content-Type': 'application/json' }

  it('returns the status and body of a prompt refusal, for both framings', async () => {
    const withLength = await boundedPost(`${url}/refuse`, {
      headers,
      body: new Uint8Array(5000),
      deadlineMs: 5000,
    })
    const chunked = await boundedPost(`${url}/refuse`, {
      headers,
      chunks: [new Uint8Array(2500), new Uint8Array(2500)],
      deadlineMs: 5000,
    })
    for (const r of [withLength, chunked]) {
      expect(r.status).toBe(413)
      expect(r.transportFailed).toBe(false)
      expect(r.bodyFlushed).toBe(true)
      expect(classifyHostileOutcome(r)).toBe('refused')
    }
  })

  it('is bounded by its deadline when the server never answers, and records that the body was sent', async () => {
    const r = await boundedPost(`${url}/never`, {
      headers,
      body: new Uint8Array(24 * 1024),
      deadlineMs: 400,
    })
    expect(r.status).toBeNull()
    expect(r.transportFailed).toBe(true)
    expect(r.bodyFlushed).toBe(true)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(350)
    expect(r.elapsedMs).toBeLessThan(3000)
    expect(classifyHostileOutcome(r)).toBe('fail-closed-transport')
  })

  it('reports a 200 as a violation (an accepted oversize body is never a refusal)', async () => {
    const r = await boundedPost(`${url}/ok`, {
      headers,
      body: new Uint8Array(5000),
      deadlineMs: 5000,
    })
    expect(r.status).toBe(200)
    expect(classifyHostileOutcome(r)).toBe('violation')
  })
})
