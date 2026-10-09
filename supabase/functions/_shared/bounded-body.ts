/**
 * Reads at most `maxBytes` of a request body and reports an oversize body as `null`.
 *
 * `Content-Length` is only a hint (a chunked request has none), so the limit is enforced on the
 * stream itself and the read stops the moment it is exceeded instead of buffering an arbitrarily
 * large body first. Same behaviour as delete-account's reader (P152), shared so a public endpoint
 * that parses JSON never calls `request.json()` on an unbounded stream (P200).
 */
export async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** True when a declared `Content-Length` already exceeds the limit (no body needs reading). */
export function declaredLengthExceeds(request: Request, maxBytes: number): boolean {
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  return Number.isFinite(declared) && declared > maxBytes
}
