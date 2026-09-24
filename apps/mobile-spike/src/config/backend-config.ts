/**
 * Backend configuration for the spike, and the guard that keeps it away from Production.
 *
 * The spike may talk to an ISOLATED LOCAL stack only. `loadBackendConfig` therefore accepts a URL
 * whose host is loopback, a private (RFC 1918) address, the Android emulator's host alias, or a
 * `.local` name, and refuses everything else (with a specific code when the host looks like the
 * hosted Supabase or the Cloudflare Pages Production origin). It also refuses a service-role / secret
 * key: the native client ships a PUBLISHABLE key only (SECURITY.md: the service_role key never
 * reaches a client bundle). Because Expo inlines `EXPO_PUBLIC_*` values into the JS bundle, anything
 * placed there is readable by whoever holds the app.
 *
 * SPIKE_ONLY: a production build path (an explicit, reviewed opt-in) is a later, owner-approved
 * decision; nothing here can be flipped to Production by an environment variable.
 */

export type BackendConfigErrorCode =
  | 'missing_url'
  | 'missing_key'
  | 'invalid_url'
  | 'production_backend_refused'
  | 'non_local_backend_refused'
  | 'secret_key_refused'
  | 'invalid_key'

export class BackendConfigError extends Error {
  readonly code: BackendConfigErrorCode
  constructor(code: BackendConfigErrorCode, message: string) {
    super(message)
    this.name = 'BackendConfigError'
    this.code = code
  }
}

export interface BackendConfig {
  /** Origin the client talks to (already rewritten for the Android emulator when applicable). */
  url: string
  publishableKey: string
  host: string
}

export type Platform = 'ios' | 'android' | 'web'

export interface EnvInput {
  url?: string | undefined
  publishableKey?: string | undefined
  /** Android emulator only: the host alias for the developer machine's loopback. Default 10.0.2.2. */
  androidEmulatorHost?: string | undefined
  /** "adb-reverse": the device already reaches the host via `adb reverse`, so keep the URL as is. */
  androidLoopback?: string | undefined
}

const PRODUCTION_HOSTS: readonly RegExp[] = [
  /\.supabase\.(co|in|net)$/i,
  /(^|\.)pages\.dev$/i,
  /pokeportfolio/i,
]

function parseOrigin(raw: string): { scheme: string; host: string; port: string; rest: string } {
  const match = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?$/i.exec(raw.trim())
  if (match === null) {
    throw new BackendConfigError('invalid_url', 'the Supabase URL is not a valid http(s) origin')
  }
  return {
    scheme: (match[1] as string).toLowerCase(),
    host: (match[2] as string).toLowerCase(),
    port: match[3] ?? '',
    rest: match[4] ?? '',
  }
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const m = IPV4.exec(host)
  if (m === null) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function base64UrlToString(segment: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = ''
  for (const ch of segment) {
    const v = alphabet.indexOf(ch)
    if (v === -1) throw new Error('not base64url')
    bits += v.toString(2).padStart(6, '0')
  }
  let out = ''
  for (let i = 0; i + 8 <= bits.length; i += 8)
    out += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2))
  return out
}

/** Throws unless the key is a publishable key or an anon-role JWT. Never logs the key. */
export function assertPublishableKey(key: string): void {
  const trimmed = key.trim()
  if (trimmed === '') throw new BackendConfigError('missing_key', 'the publishable key is empty')
  if (/^sb_secret_/i.test(trimmed)) {
    throw new BackendConfigError('secret_key_refused', 'a secret key must never be in the app')
  }
  if (/^sb_publishable_/i.test(trimmed)) return
  const parts = trimmed.split('.')
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(base64UrlToString(parts[1] as string)) as { role?: unknown }
      if (payload.role === 'anon') return
      throw new BackendConfigError(
        'secret_key_refused',
        `a "${String(payload.role)}" key must never be in the app`,
      )
    } catch (error) {
      if (error instanceof BackendConfigError) throw error
    }
  }
  throw new BackendConfigError(
    'invalid_key',
    'the key is neither a publishable key nor an anon JWT',
  )
}

/** Rewrites a host-loopback URL to what an Android emulator must dial. Other platforms: unchanged. */
export function resolvePlatformUrl(url: string, platform: Platform, env: EnvInput): string {
  if (platform !== 'android' || env.androidLoopback === 'adb-reverse') return url
  const { scheme, host, port, rest } = parseOrigin(url)
  if (host !== '127.0.0.1' && host !== 'localhost') return url
  const alias = env.androidEmulatorHost?.trim() || '10.0.2.2'
  return `${scheme}://${alias}${port === '' ? '' : `:${port}`}${rest === '/' ? '' : rest}`
}

export function loadBackendConfig(env: EnvInput, platform: Platform): BackendConfig {
  if (!env.url?.trim())
    throw new BackendConfigError('missing_url', 'EXPO_PUBLIC_SUPABASE_URL is not set')
  if (!env.publishableKey?.trim()) {
    throw new BackendConfigError('missing_key', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set')
  }
  const { host } = parseOrigin(env.url)
  if (PRODUCTION_HOSTS.some((pattern) => pattern.test(host))) {
    throw new BackendConfigError(
      'production_backend_refused',
      'this spike never talks to a hosted or Production backend',
    )
  }
  if (!isLocalHost(host)) {
    throw new BackendConfigError(
      'non_local_backend_refused',
      'the spike accepts only a local (loopback / private network) backend',
    )
  }
  assertPublishableKey(env.publishableKey)
  const url = resolvePlatformUrl(env.url.trim().replace(/\/+$/, ''), platform, env)
  return { url, publishableKey: env.publishableKey.trim(), host: parseOrigin(url).host }
}
