import http from 'node:http'

/**
 * P196C: a POST whose lifetime is bounded by an explicit deadline and whose outcome records HOW
 * the body left the client, for hostile oversized-body tests against the local Supabase gateway.
 *
 * Why this exists instead of `fetch`: measured against the local stack (Kong -> Edge Runtime 1.74.3,
 * docs/TESTING.md "Request-body bound over the local gateway"), a request whose body is larger than
 * about 16 KiB, answered early by the function without consuming the body, intermittently never gets
 * its response back (10-20 % per request at 24-48 KiB; 0 of ~600 at <= 16 KiB). The Edge Runtime
 * logs `user body write aborted`, Kong logs 499 once the client gives up, and Kong never logs an
 * upstream error. `fetch` has no deadline, so the vitest 20 s timeout was the only bound.
 *
 * Properties this helper guarantees:
 * - the request is bounded by `deadlineMs` (AbortController semantics, not a global timeout);
 * - `bodyFlushed` is true only when every body byte was handed to the socket, so a deadline that
 *   fires BEFORE the body was sent can never be mistaken for a server-side refusal;
 * - a fresh connection per request (`agent: false`): a hostile request never shares a pooled
 *   keep-alive socket with an unrelated test. Measured: this isolates, it does not cure the hang.
 */

export interface BoundedPostResult {
  /** HTTP status, or null when no response arrived before the deadline. */
  status: number | null
  text: string
  headers: http.IncomingHttpHeaders
  /** Every body byte was handed to the socket before the request ended. */
  bodyFlushed: boolean
  /** The deadline fired (or the connection failed) before a complete response arrived. */
  transportFailed: boolean
  elapsedMs: number
}

export interface BoundedPostInit {
  headers: Record<string, string>
  /** Sent as one buffer with an explicit Content-Length. */
  body?: Uint8Array
  /** Sent as separate chunks with Transfer-Encoding: chunked and NO Content-Length. */
  chunks?: Uint8Array[]
  deadlineMs: number
}

export function boundedPost(url: string, init: BoundedPostInit): Promise<BoundedPostResult> {
  const target = new URL(url)
  const started = Date.now()
  const headers: Record<string, string> = { ...init.headers }
  if (init.body) headers['Content-Length'] = String(init.body.byteLength)

  return new Promise((resolve) => {
    let bodyFlushed = false
    let settled = false
    const finish = (
      partial: Pick<BoundedPostResult, 'status' | 'text' | 'headers'>,
      failed: boolean,
    ) => {
      if (settled) return
      settled = true
      resolve({
        ...partial,
        bodyFlushed,
        transportFailed: failed,
        elapsedMs: Date.now() - started,
      })
    }

    const req = http.request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'POST',
        headers,
        agent: false,
        signal: AbortSignal.timeout(init.deadlineMs),
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (part: Buffer) => parts.push(part))
        res.on('end', () => {
          finish(
            {
              status: res.statusCode ?? null,
              text: Buffer.concat(parts).toString('utf8'),
              headers: res.headers,
            },
            false,
          )
        })
        res.on('error', () => {
          finish({ status: null, text: '', headers: {} }, true)
        })
      },
    )
    req.on('finish', () => {
      bodyFlushed = true
    })
    req.on('error', () => {
      finish({ status: null, text: '', headers: {} }, true)
    })

    if (init.body) {
      req.end(init.body)
    } else {
      for (const chunk of init.chunks ?? []) req.write(chunk)
      req.end()
    }
  })
}

export type HostileOutcome = 'refused' | 'fail-closed-transport' | 'violation'

/**
 * Classifies the outcome of an oversized/untrusted request against the trust-boundary invariant.
 *
 * - `refused`: the server answered 413 (the intended assertion).
 * - `fail-closed-transport`: no response arrived, but the whole body had been handed over, so the
 *   server had every chance to act on it. This is only evidence of fail-closed behaviour when the
 *   caller ALSO proves the protected state is unchanged; a client that gave up before sending the
 *   body proves nothing and is a violation of the test, not a refusal.
 * - `violation`: anything else, including any 2xx.
 */
export function classifyHostileOutcome(result: BoundedPostResult): HostileOutcome {
  if (result.status === 413) return 'refused'
  if (result.status === null && result.transportFailed && result.bodyFlushed) {
    return 'fail-closed-transport'
  }
  return 'violation'
}
