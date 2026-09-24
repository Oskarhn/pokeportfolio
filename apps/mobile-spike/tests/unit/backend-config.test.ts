import {
  BackendConfigError,
  isLocalHost,
  loadBackendConfig,
  resolvePlatformUrl,
} from '../../src/config/backend-config'

const PUBLISHABLE = 'sb_publishable_' + 'x'.repeat(24)

function b64url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}
const jwt = (role: string) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ role })}.sig`

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof BackendConfigError) return e.code
    throw e
  }
  return 'no-error'
}

describe('loadBackendConfig refuses Production and non-local backends', () => {
  it.each([
    'https://abcdefghijklmnop.supabase.co',
    'https://pokeportfolio-dev.pages.dev',
    'https://api.pokeportfolio.app',
    'https://foo.supabase.in',
  ])('production-looking origin %s', (url) => {
    expect(code(() => loadBackendConfig({ url, publishableKey: PUBLISHABLE }, 'ios'))).toBe(
      'production_backend_refused',
    )
  })

  it.each(['https://example.com', 'http://8.8.8.8:54321', 'http://192.169.1.1', 'http://11.0.0.1'])(
    'any other non-local host %s',
    (url) => {
      expect(code(() => loadBackendConfig({ url, publishableKey: PUBLISHABLE }, 'ios'))).toBe(
        'non_local_backend_refused',
      )
    },
  )

  it.each([
    'http://127.0.0.1:55321',
    'http://localhost:55321',
    'http://10.0.2.2:55321',
    'http://192.168.1.20:55321',
    'http://172.20.0.5',
    'http://mybox.local:1',
  ])('accepts local host %s', (url) => {
    expect(loadBackendConfig({ url, publishableKey: PUBLISHABLE }, 'ios').host).toBeTruthy()
  })

  it('rejects a lookalike that only ENDS with a local-looking label', () => {
    expect(isLocalHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLocalHost('localhost.evil.com')).toBe(false)
    expect(isLocalHost('999.0.0.1')).toBe(false)
  })

  it('refuses missing values and malformed urls', () => {
    expect(code(() => loadBackendConfig({ publishableKey: PUBLISHABLE }, 'ios'))).toBe(
      'missing_url',
    )
    expect(code(() => loadBackendConfig({ url: 'http://127.0.0.1:1' }, 'ios'))).toBe('missing_key')
    expect(
      code(() => loadBackendConfig({ url: 'ftp://127.0.0.1', publishableKey: PUBLISHABLE }, 'ios')),
    ).toBe('invalid_url')
    expect(
      code(() => loadBackendConfig({ url: 'not a url', publishableKey: PUBLISHABLE }, 'ios')),
    ).toBe('invalid_url')
  })
})

describe('loadBackendConfig refuses privileged keys (the native bundle is public)', () => {
  const url = 'http://127.0.0.1:55321'
  it('accepts a publishable key and an anon-role JWT', () => {
    expect(loadBackendConfig({ url, publishableKey: PUBLISHABLE }, 'ios').publishableKey).toBe(
      PUBLISHABLE,
    )
    expect(loadBackendConfig({ url, publishableKey: jwt('anon') }, 'ios')).toBeTruthy()
  })
  it('refuses a secret key and a service_role JWT', () => {
    expect(
      code(() => loadBackendConfig({ url, publishableKey: 'sb_secret_' + 'y'.repeat(20) }, 'ios')),
    ).toBe('secret_key_refused')
    expect(code(() => loadBackendConfig({ url, publishableKey: jwt('service_role') }, 'ios'))).toBe(
      'secret_key_refused',
    )
    expect(code(() => loadBackendConfig({ url, publishableKey: jwt('postgres') }, 'ios'))).toBe(
      'secret_key_refused',
    )
  })
  it('refuses something that is neither', () => {
    expect(code(() => loadBackendConfig({ url, publishableKey: 'hello' }, 'ios'))).toBe(
      'invalid_key',
    )
    expect(code(() => loadBackendConfig({ url, publishableKey: 'a.b.c' }, 'ios'))).toBe(
      'invalid_key',
    )
  })
})

describe('Android emulator routing is derived from configuration, not hard-coded', () => {
  const url = 'http://127.0.0.1:55321'
  it('rewrites host loopback to the emulator alias (default 10.0.2.2), keeping the port', () => {
    expect(resolvePlatformUrl(url, 'android', {})).toBe('http://10.0.2.2:55321')
    expect(resolvePlatformUrl('http://localhost:55321', 'android', {})).toBe(
      'http://10.0.2.2:55321',
    )
  })
  it('honours a configured alias and the adb-reverse opt-out', () => {
    expect(resolvePlatformUrl(url, 'android', { androidEmulatorHost: '10.0.3.2' })).toBe(
      'http://10.0.3.2:55321',
    )
    expect(resolvePlatformUrl(url, 'android', { androidLoopback: 'adb-reverse' })).toBe(url)
  })
  it('leaves iOS, web and non-loopback hosts unchanged', () => {
    expect(resolvePlatformUrl(url, 'ios', {})).toBe(url)
    expect(resolvePlatformUrl('http://192.168.1.20:55321', 'android', {})).toBe(
      'http://192.168.1.20:55321',
    )
  })
  it('the rewritten URL still passes the local-only guard', () => {
    expect(loadBackendConfig({ url, publishableKey: PUBLISHABLE }, 'android').url).toBe(
      'http://10.0.2.2:55321',
    )
  })
})
