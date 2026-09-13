export function extractInlineScripts(html: string): string[]
export function hashScriptForCsp(scriptText: string): string
export function parseCspDirectives(csp: string): Map<string, string[]>

export interface LiveCspHashVerifyInput {
  readonly html: string
  readonly cspHeader: string | null | undefined
}

export interface LiveCspHashVerifyResult {
  readonly pass: boolean
  readonly reason: string
  readonly hashes: string[]
}

export function verifyLiveCspHash(input: LiveCspHashVerifyInput): LiveCspHashVerifyResult

export function fetchAndVerifyLiveCspHash(
  url: string,
  options?: { readonly timeoutMs?: number },
): Promise<LiveCspHashVerifyResult>
