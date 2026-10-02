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
 * BUILD PROFILES (P188). The profile is a BUILD-time value (EXPO_PUBLIC_BUILD_PROFILE, inlined into
 * the bundle next to the URL and key; config/build-profile.cjs applies the matching native
 * configuration). LOCAL_DEV and LOCAL_RELEASE_TEST, and an unset profile, keep the rule above. Only
 * PRODUCTION_RELEASE accepts a hosted backend, and then ONLY a hosted one: an exact
 * `https://<20-character project ref>.supabase.co` origin and an `sb_publishable_` key, never a
 * local, private or loopback address and never a legacy JWT. The profile cannot be chosen at run
 * time and an unknown value is refused, so a local build cannot reach Production and a Production
 * build cannot be pointed at a developer machine by a stray environment value.
 */

export type BackendConfigErrorCode =
  | 'missing_url'
  | 'missing_key'
  | 'invalid_url'
  | 'production_backend_refused'
  | 'non_local_backend_refused'
  | 'secret_key_refused'
  | 'invalid_key'
  | 'invalid_build_profile'
  | 'non_hosted_backend_refused'

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

export type BuildProfile = 'LOCAL_DEV' | 'LOCAL_RELEASE_TEST' | 'PRODUCTION_RELEASE'

const BUILD_PROFILES: readonly BuildProfile[] = [
  'LOCAL_DEV',
  'LOCAL_RELEASE_TEST',
  'PRODUCTION_RELEASE',
]

/** Unset or empty is LOCAL_DEV (the profile that can only reach a local backend); unknown is refused. */
export function parseBuildProfile(raw: string | undefined): BuildProfile {
  if (raw === undefined || raw.trim() === '') return 'LOCAL_DEV'
  const value = raw.trim() as BuildProfile
  if (!BUILD_PROFILES.includes(value)) {
    throw new BackendConfigError(
      'invalid_build_profile',
      'EXPO_PUBLIC_BUILD_PROFILE is not a known build profile',
    )
  }
  return value
}

export interface EnvInput {
  /** The build profile (EXPO_PUBLIC_BUILD_PROFILE); see the header. */
  profile?: string | undefined
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

const HOSTED_ORIGIN = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/
const HOSTED_PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/

/** PRODUCTION_RELEASE: a hosted origin and a publishable key, nothing else. */
function loadHostedBackendConfig(env: EnvInput): BackendConfig {
  const url = env.url?.trim() ?? ''
  const key = env.publishableKey?.trim() ?? ''
  if (url === '') {
    throw new BackendConfigError('missing_url', 'EXPO_PUBLIC_SUPABASE_URL is not set')
  }
  if (key === '') {
    throw new BackendConfigError('missing_key', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set')
  }
  // A key in the URL slot, or a secret anywhere, is named for what it is before the shape check.
  if (/sb_secret_/i.test(key) || /sb_secret_/i.test(url)) {
    throw new BackendConfigError('secret_key_refused', 'a secret key must never be in the app')
  }
  const hosted = HOSTED_ORIGIN.exec(url)
  if (hosted === null) {
    throw new BackendConfigError(
      'non_hosted_backend_refused',
      'a production build accepts only a hosted Supabase origin',
    )
  }
  if (!HOSTED_PUBLISHABLE_KEY.test(key)) {
    // Not echoed: the key is not logged. A legacy anon JWT is not accepted either.
    assertPublishableKey(key)
    throw new BackendConfigError('invalid_key', 'a production build needs an sb_publishable_ key')
  }
  return { url, publishableKey: key, host: hosted[0].slice('https://'.length) }
}

export function loadBackendConfig(env: EnvInput, platform: Platform): BackendConfig {
  if (parseBuildProfile(env.profile) === 'PRODUCTION_RELEASE') return loadHostedBackendConfig(env)
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
