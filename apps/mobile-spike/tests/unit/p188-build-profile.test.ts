/**
 * @jest-environment node
 */
// P188: build profiles. LOCAL_DEV / LOCAL_RELEASE_TEST keep today's placeholder identity and local
// backend; PRODUCTION_RELEASE takes its identity from the environment and FAILS CLOSED. Every value
// below is a synthetic literal: no real identifier, URL, key or password exists in this file.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BackendConfigError,
  loadBackendConfig,
  parseBuildProfile,
} from '../../src/config/backend-config'

const appRoot = join(__dirname, '..', '..')
/* eslint-disable @typescript-eslint/no-require-imports */
const profile = require('../../config/build-profile.cjs') as {
  PROFILES: string[]
  PRODUCTION_VALUE_VARIABLES: string[]
  PRODUCTION_SIGNING_VARIABLES: string[]
  PRODUCTION_FORBIDDEN_VARIABLES: string[]
  BuildProfileError: new (...args: never[]) => Error & { problems: string[] }
  resolveBuildProfile: (env: Record<string, string | undefined>) => string
  productionProblems: (env: Record<string, string | undefined>) => string[]
  missingSigningVariables: (env: Record<string, string | undefined>) => string[]
  applyBuildProfile: (base: AppExpo, env: Record<string, string | undefined>) => AppExpo
}
const signing = require('../../plugins/with-release-signing') as {
  applyReleaseSigning: (contents: string) => string
  MARKER: string
  VARIABLES: string[]
}
const appConfig = require('../../app.config.js') as (input: { config: AppExpo }) => AppExpo
/* eslint-enable @typescript-eslint/no-require-imports */

type AppExpo = {
  name: string
  version: string
  extra?: { buildProfile?: string }
  plugins: (string | [string, Record<string, unknown>])[]
  android: { package: string; versionCode?: number; blockedPermissions: string[] }
  ios: {
    bundleIdentifier: string
    buildNumber?: string
    appleTeamId?: string
    infoPlist: Record<string, unknown>
  }
}

const base = (JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as { expo: AppExpo }).expo

// Synthetic, obviously fake, but shaped like real values so the validators are exercised.
const REF = 'abcdefghij0123456789'
const PRODUCTION_ENV: Record<string, string> = {
  EXPO_PUBLIC_BUILD_PROFILE: 'PRODUCTION_RELEASE',
  EXPO_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_' + 'Q'.repeat(24),
  POKEPORTFOLIO_ANDROID_APPLICATION_ID: 'no.acme.portfolio',
  POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER: 'no.acme.portfolio',
  POKEPORTFOLIO_APPLE_TEAM_ID: 'ABCDE12345',
  POKEPORTFOLIO_APP_VERSION: '1.2.3',
  POKEPORTFOLIO_ANDROID_VERSION_CODE: '42',
  POKEPORTFOLIO_IOS_BUILD_NUMBER: '42',
}
const SIGNING_SENTINELS = {
  POKEPORTFOLIO_ANDROID_KEYSTORE_PATH: 'SENTINEL-keystore-path-p188',
  POKEPORTFOLIO_ANDROID_KEYSTORE_PASSWORD: 'SENTINEL-store-password-p188',
  POKEPORTFOLIO_ANDROID_KEY_ALIAS: 'SENTINEL-alias-p188',
  POKEPORTFOLIO_ANDROID_KEY_PASSWORD: 'SENTINEL-key-password-p188',
}

const without = (env: Record<string, string>, name: string): Record<string, string> => {
  const copy = { ...env }
  delete copy[name]
  return copy
}

describe('the profile is read from one variable; unset is the safest profile, unknown is refused', () => {
  it('lists exactly the three profiles', () => {
    expect(profile.PROFILES).toEqual(['LOCAL_DEV', 'LOCAL_RELEASE_TEST', 'PRODUCTION_RELEASE'])
  })

  it.each([undefined, '', '   '])('%j is LOCAL_DEV', (value) => {
    expect(profile.resolveBuildProfile({ EXPO_PUBLIC_BUILD_PROFILE: value })).toBe('LOCAL_DEV')
    expect(parseBuildProfile(value)).toBe('LOCAL_DEV')
  })

  it.each(['LOCAL_DEV', 'LOCAL_RELEASE_TEST', 'PRODUCTION_RELEASE'])('accepts %s', (value) => {
    expect(profile.resolveBuildProfile({ EXPO_PUBLIC_BUILD_PROFILE: value })).toBe(value)
    expect(parseBuildProfile(value)).toBe(value)
  })

  it.each(['production', 'PRODUCTION', 'release', 'LOCAL', 'PRODUCTION_RELEASE ;'])(
    'refuses %j rather than falling back',
    (value) => {
      expect(() => profile.resolveBuildProfile({ EXPO_PUBLIC_BUILD_PROFILE: value })).toThrow()
      expect(() => parseBuildProfile(value)).toThrow(BackendConfigError)
    },
  )
})

describe('LOCAL profiles keep the placeholder identity and the local-only plumbing', () => {
  it.each(['LOCAL_DEV', 'LOCAL_RELEASE_TEST'])(
    '%s equals app.json plus extra.buildProfile',
    (p) => {
      const before = JSON.stringify(base)
      const out = profile.applyBuildProfile(base, { EXPO_PUBLIC_BUILD_PROFILE: p })
      expect(JSON.stringify(base)).toBe(before) // the input is never mutated
      expect(out.extra?.buildProfile).toBe(p)
      expect({ ...out, extra: undefined }).toEqual({ ...base, extra: undefined })
      expect(out.android.package).toBe('invalid.pokeportfolio.spike')
      expect(out.ios.bundleIdentifier).toBe('invalid.pokeportfolio.spike')
      expect(out.plugins).toContain('./plugins/with-local-cleartext')
      expect(out.plugins).not.toContain('./plugins/with-release-signing')
      expect(out.ios.infoPlist.NSAppTransportSecurity).toBeDefined()
    },
  )

  it('an unset profile gives the same configuration as LOCAL_DEV', () => {
    expect(profile.applyBuildProfile(base, {})).toEqual(
      profile.applyBuildProfile(base, { EXPO_PUBLIC_BUILD_PROFILE: 'LOCAL_DEV' }),
    )
  })

  it('does not require any production variable', () => {
    expect(() =>
      profile.applyBuildProfile(base, { EXPO_PUBLIC_BUILD_PROFILE: 'LOCAL_RELEASE_TEST' }),
    ).not.toThrow()
  })
})

describe('PRODUCTION_RELEASE takes its identity from the environment', () => {
  const out = profile.applyBuildProfile(base, { ...PRODUCTION_ENV, ...SIGNING_SENTINELS })

  it('replaces the placeholder identity and version', () => {
    expect(out.android.package).toBe('no.acme.portfolio')
    expect(out.android.versionCode).toBe(42)
    expect(out.ios.bundleIdentifier).toBe('no.acme.portfolio')
    expect(out.ios.buildNumber).toBe('42')
    expect(out.ios.appleTeamId).toBe('ABCDE12345')
    expect(out.version).toBe('1.2.3')
    expect(out.name).toBe('PokePortfolio')
    expect(out.extra?.buildProfile).toBe('PRODUCTION_RELEASE')
    expect(JSON.stringify(out)).not.toContain('invalid.pokeportfolio')
  })

  it('drops everything that exists only for a local backend', () => {
    expect(out.plugins).not.toContain('./plugins/with-local-cleartext')
    expect(out.ios.infoPlist.NSAppTransportSecurity).toBeUndefined()
    expect(out.ios.infoPlist.NSLocalNetworkUsageDescription).toBeUndefined()
    expect(JSON.stringify(out)).not.toMatch(
      /localhost|127\.0\.0\.1|10\.0\.2\.2|NSAllowsLocalNetworking/,
    )
  })

  it('keeps the rest of the configuration, and adds release signing', () => {
    expect(out.plugins).toContain('./plugins/with-release-signing')
    expect(out.plugins).toContain('./plugins/with-release-packaging')
    expect(out.plugins).toContain('./plugins/with-ios-dark-splash')
    expect(out.android.blockedPermissions).toEqual(base.android.blockedPermissions)
  })

  it('never copies a signing value into the Expo config (it is embedded in the app manifest)', () => {
    const text = JSON.stringify(out)
    for (const sentinel of Object.values(SIGNING_SENTINELS)) expect(text).not.toContain(sentinel)
    expect(text).not.toContain('KEYSTORE')
  })

  it('honours an explicit display name', () => {
    const named = profile.applyBuildProfile(base, {
      ...PRODUCTION_ENV,
      POKEPORTFOLIO_APP_NAME: 'Binder',
    })
    expect(named.name).toBe('Binder')
  })

  it('does not mutate the base configuration', () => {
    expect(base.android.package).toBe('invalid.pokeportfolio.spike')
    expect(base.plugins).toContain('./plugins/with-local-cleartext')
  })
})

describe('PRODUCTION_RELEASE fails closed, naming the variable and never a value', () => {
  it.each(profile.PRODUCTION_VALUE_VARIABLES)('refuses a build without %s', (name) => {
    let message = ''
    try {
      profile.applyBuildProfile(base, without(PRODUCTION_ENV, name))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain(name)
    expect(message).toContain('is not set')
    expect(message).not.toContain(REF)
    expect(message).not.toContain('sb_publishable_')
  })

  it('treats an all-blank value as absent', () => {
    expect(
      profile.productionProblems({ ...PRODUCTION_ENV, POKEPORTFOLIO_APP_VERSION: '   ' }),
    ).toEqual(['POKEPORTFOLIO_APP_VERSION is not set'])
  })

  it('reports every missing variable at once', () => {
    const problems = profile.productionProblems({ EXPO_PUBLIC_BUILD_PROFILE: 'PRODUCTION_RELEASE' })
    expect(problems).toHaveLength(profile.PRODUCTION_VALUE_VARIABLES.length)
  })

  it.each([
    ['invalid.pokeportfolio.spike', 'a placeholder identifier'],
    ['com.example.app', 'a placeholder identifier'],
    ['no.acme.spike', 'a placeholder identifier'],
    ['no.acme.placeholder', 'a placeholder identifier'],
    ['singlesegment', 'not a valid'],
    ['no.acme.1leading', 'not a valid'],
  ])('refuses the application id %s', (id, why) => {
    const problems = profile.productionProblems({
      ...PRODUCTION_ENV,
      POKEPORTFOLIO_ANDROID_APPLICATION_ID: id,
    })
    expect(problems.join()).toContain(why)
    expect(problems.join()).not.toContain(id)
  })

  it('refuses a placeholder iOS bundle identifier', () => {
    expect(
      profile.productionProblems({
        ...PRODUCTION_ENV,
        POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER: 'invalid.pokeportfolio.spike',
      }),
    ).toEqual(['POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER is a placeholder identifier'])
  })

  it.each([
    'http://127.0.0.1:55321',
    'http://10.0.2.2:55321',
    `http://${REF}.supabase.co`,
    `https://${REF}.supabase.co/`,
    `https://${REF}.supabase.co/rest/v1`,
    `https://${REF}.supabase.co:443`,
    'https://short.supabase.co',
    `https://${REF}.pages.dev`,
    'https://pokeportfolio-dev.pages.dev',
    `https://user:pw@${REF}.supabase.co`,
  ])('refuses the backend URL %s', (url) => {
    const problems = profile.productionProblems({
      ...PRODUCTION_ENV,
      EXPO_PUBLIC_SUPABASE_URL: url,
    })
    expect(problems).toEqual([
      'EXPO_PUBLIC_SUPABASE_URL is not https://<20-character project ref>.supabase.co',
    ])
  })

  it.each([
    ['sb_secret_' + 'x'.repeat(24), 'is secret-shaped'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln', 'is not an sb_publishable_ key'],
    ['sb_publishable_short', 'is not an sb_publishable_ key'],
    ['hello', 'is not an sb_publishable_ key'],
  ])('refuses the key %#', (key, why) => {
    const problems = profile.productionProblems({
      ...PRODUCTION_ENV,
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key,
    })
    expect(problems.join()).toContain(why)
    expect(problems.join()).not.toContain(key)
  })

  it.each([
    ['POKEPORTFOLIO_APP_VERSION', '0.0.0'],
    ['POKEPORTFOLIO_APP_VERSION', '1.2'],
    ['POKEPORTFOLIO_ANDROID_VERSION_CODE', '0'],
    ['POKEPORTFOLIO_ANDROID_VERSION_CODE', '1.5'],
    ['POKEPORTFOLIO_IOS_BUILD_NUMBER', 'abc'],
    ['POKEPORTFOLIO_APPLE_TEAM_ID', 'abcde12345'],
    ['POKEPORTFOLIO_APPLE_TEAM_ID', 'SHORT'],
  ])('refuses %s=%s', (name, value) => {
    const problems = profile.productionProblems({ ...PRODUCTION_ENV, [name]: value })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(name)
  })

  it.each(profile.PRODUCTION_FORBIDDEN_VARIABLES)(
    'refuses a production build that sets the local-only variable %s',
    (name) => {
      const problems = profile.productionProblems({ ...PRODUCTION_ENV, [name]: '1' })
      expect(problems).toEqual([`${name} must not be set for a production build`])
    },
  )

  it('knows which signing variables are missing (the Gradle guard checks the same four)', () => {
    expect(profile.missingSigningVariables({})).toEqual(profile.PRODUCTION_SIGNING_VARIABLES)
    expect(profile.missingSigningVariables(SIGNING_SENTINELS)).toEqual([])
    expect(profile.PRODUCTION_SIGNING_VARIABLES).toEqual(signing.VARIABLES)
  })
})

describe('app.config.js applies the profile to app.json', () => {
  const keys: string[] = [...Object.keys(PRODUCTION_ENV), ...Object.keys(SIGNING_SENTINELS)]
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k] as string | undefined
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('returns the local configuration when no profile is set', () => {
    expect(appConfig({ config: base }).extra?.buildProfile).toBe('LOCAL_DEV')
  })

  it('returns the production configuration when the environment is complete', () => {
    Object.assign(process.env, PRODUCTION_ENV)
    expect(appConfig({ config: base }).android.package).toBe('no.acme.portfolio')
  })

  it('throws when a production environment is incomplete', () => {
    process.env.EXPO_PUBLIC_BUILD_PROFILE = 'PRODUCTION_RELEASE'
    expect(() => appConfig({ config: base })).toThrow(/EXPO_PUBLIC_SUPABASE_URL is not set/)
  })
})

describe('Expo itself resolves each profile (the real config pipeline, nothing written)', () => {
  const expoConfig = (env: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [require.resolve('expo/bin/cli'), 'config', '--json', '--type', 'public'],
      { cwd: appRoot, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 },
    )

  const clean = (): Record<string, string> => ({
    EXPO_PUBLIC_BUILD_PROFILE: '',
    EXPO_NO_TELEMETRY: '1',
    CI: '1',
  })

  it('LOCAL_RELEASE_TEST resolves with the placeholder identity', () => {
    const result = expoConfig({ ...clean(), EXPO_PUBLIC_BUILD_PROFILE: 'LOCAL_RELEASE_TEST' })
    expect(result.status).toBe(0)
    const config = JSON.parse(result.stdout) as AppExpo
    expect(config.extra?.buildProfile).toBe('LOCAL_RELEASE_TEST')
    expect(config.android.package).toBe('invalid.pokeportfolio.spike')
  })

  it('PRODUCTION_RELEASE resolves with the supplied identity and no local plumbing', () => {
    const result = expoConfig({ ...clean(), ...PRODUCTION_ENV })
    expect(result.status).toBe(0)
    const config = JSON.parse(result.stdout) as AppExpo
    expect(config.android.package).toBe('no.acme.portfolio')
    expect(JSON.stringify(config)).not.toMatch(/with-local-cleartext|NSAllowsLocalNetworking/)
  })

  it('PRODUCTION_RELEASE without its variables does not resolve at all', () => {
    const result = expoConfig({ ...clean(), EXPO_PUBLIC_BUILD_PROFILE: 'PRODUCTION_RELEASE' })
    expect(result.status).not.toBe(0)
    const output = `${result.stdout}${result.stderr}`
    expect(output).toContain('POKEPORTFOLIO_ANDROID_APPLICATION_ID is not set')
    expect(output).not.toContain('invalid.pokeportfolio.spike')
  })

  it('an unknown profile does not resolve', () => {
    const result = expoConfig({ ...clean(), EXPO_PUBLIC_BUILD_PROFILE: 'production' })
    expect(result.status).not.toBe(0)
  })

  it('the CLI is the one the repository pins', () => {
    const version = execFileSync(process.execPath, [require.resolve('expo/bin/cli'), '--version'], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' },
    }).trim()
    expect(version).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('release signing never falls back to the debug keystore', () => {
  // The two shapes the Expo template generates (excerpted from a real prebuild).
  const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`
  const out = signing.applyReleaseSigning(TEMPLATE)
  const buildTypes = out.slice(out.indexOf('buildTypes'))

  it('adds a release signing config that reads the four variables from the environment', () => {
    for (const name of signing.VARIABLES) expect(out).toContain(`System.getenv('${name}')`)
    expect(out).toContain('GradleException')
    expect(out).toContain(signing.MARKER)
  })

  it('repoints only the release build type; debug keeps the debug keystore', () => {
    const debugBlock = buildTypes.slice(0, buildTypes.indexOf('release {'))
    expect(debugBlock).toContain('signingConfig signingConfigs.debug')
    const releaseBlock = buildTypes.slice(buildTypes.indexOf('release {'))
    expect(releaseBlock).toContain('signingConfig signingConfigs.release')
    expect(releaseBlock).not.toContain('signingConfigs.debug')
  })

  it('contains no literal credential', () => {
    // The template's own debug keystore line ('android') is outside the block this plugin adds.
    const added = out.slice(out.indexOf(signing.MARKER), out.indexOf('buildTypes'))
    expect(added).not.toMatch(/(storePassword|keyPassword|keyAlias)s+['"]/)
    expect(out.match(/storePassword 'android'/g)).toHaveLength(1)
  })

  it('is idempotent', () => {
    expect(signing.applyReleaseSigning(out)).toBe(out)
  })

  it.each([
    [
      'no signingConfigs',
      'android { buildTypes { release { signingConfig signingConfigs.debug } } }',
    ],
    ['no release build type', TEMPLATE.replace('release {', 'staging {')],
    [
      'release already repointed',
      TEMPLATE.replace('signingConfig signingConfigs.debug\n            minify', 'minify'),
    ],
    ['empty', ''],
  ])('refuses a template it does not recognise (%s)', (_name, text) => {
    expect(() => signing.applyReleaseSigning(text)).toThrow(/refusing to guess/)
  })
})

describe('backend-config applies the same profile at run time', () => {
  const hosted = {
    profile: 'PRODUCTION_RELEASE',
    url: `https://${REF}.supabase.co`,
    publishableKey: 'sb_publishable_' + 'Q'.repeat(24),
  }
  const code = (fn: () => unknown): string | undefined => {
    try {
      fn()
    } catch (error) {
      return error instanceof BackendConfigError ? error.code : 'other'
    }
    return undefined
  }

  it('PRODUCTION_RELEASE accepts a hosted origin and a publishable key, unchanged on every platform', () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      expect(loadBackendConfig(hosted, platform)).toEqual({
        url: hosted.url,
        publishableKey: hosted.publishableKey,
        host: `${REF}.supabase.co`,
      })
    }
  })

  it('PRODUCTION_RELEASE never rewrites a URL for the Android emulator', () => {
    const config = loadBackendConfig({ ...hosted, androidEmulatorHost: '10.0.2.2' }, 'android')
    expect(config.url).toBe(hosted.url)
  })

  it.each([
    ['http://127.0.0.1:55321', 'non_hosted_backend_refused'],
    ['http://10.0.2.2:55321', 'non_hosted_backend_refused'],
    ['http://192.168.1.20:55321', 'non_hosted_backend_refused'],
    [`http://${REF}.supabase.co`, 'non_hosted_backend_refused'],
    [`https://${REF}.supabase.co/rest/v1`, 'non_hosted_backend_refused'],
    ['https://example.pages.dev', 'non_hosted_backend_refused'],
    ['', 'missing_url'],
  ])('PRODUCTION_RELEASE refuses the URL %j (%s)', (url, expected) => {
    expect(code(() => loadBackendConfig({ ...hosted, url }, 'ios'))).toBe(expected)
  })

  it.each([
    ['sb_secret_' + 'y'.repeat(20), 'secret_key_refused'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln', 'invalid_key'],
    ['hello', 'invalid_key'],
    ['', 'missing_key'],
  ])('PRODUCTION_RELEASE refuses the key %#', (publishableKey, expected) => {
    expect(code(() => loadBackendConfig({ ...hosted, publishableKey }, 'ios'))).toBe(expected)
  })

  it('an unknown profile is refused, not defaulted', () => {
    expect(code(() => loadBackendConfig({ ...hosted, profile: 'production' }, 'ios'))).toBe(
      'invalid_build_profile',
    )
  })

  it.each([undefined, 'LOCAL_DEV', 'LOCAL_RELEASE_TEST'])(
    'profile %j still refuses a hosted backend (the local rule is unchanged)',
    (p) => {
      expect(code(() => loadBackendConfig({ ...hosted, profile: p }, 'ios'))).toBe(
        'production_backend_refused',
      )
    },
  )

  it.each([undefined, 'LOCAL_DEV', 'LOCAL_RELEASE_TEST'])(
    'profile %j still accepts a local backend',
    (p) => {
      const config = loadBackendConfig(
        { profile: p, url: 'http://127.0.0.1:55321', publishableKey: hosted.publishableKey },
        'android',
      )
      expect(config.url).toBe('http://10.0.2.2:55321')
    },
  )
})
