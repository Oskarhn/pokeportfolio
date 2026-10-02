/**
 * Build profiles for the native app (P188): which kind of build is this, and is its configuration
 * complete enough to be that kind of build?
 *
 *   LOCAL_DEV            a developer or proof build against an isolated LOCAL backend. Placeholder
 *                        application ids, local cleartext, the debug keystore. The default.
 *   LOCAL_RELEASE_TEST   the same local backend and placeholder identity, but a release-shaped build
 *                        (R8, resource shrinking, ABI split). What the emulator release journey and
 *                        the P186 package are. NOT a store build.
 *   PRODUCTION_RELEASE   a build that talks to the hosted backend with a real identity and a real
 *                        signing key. Every value comes from the BUILD ENVIRONMENT; nothing is
 *                        committed. It FAILS CLOSED: a missing, placeholder or secret-shaped value
 *                        stops the build with the variable's NAME (never its value).
 *
 * The profile is read from `EXPO_PUBLIC_BUILD_PROFILE`. The same variable reaches the JS bundle
 * (Expo inlines EXPO_PUBLIC_*), where `src/config/backend-config.ts` applies the matching runtime
 * rule, so the native configuration and the runtime guard cannot disagree about the profile.
 *
 * No real application id, bundle id, team id, URL, key or keystore is in this repository. Secrets
 * (keystore password, key password) are only ever read from the environment by the Gradle build
 * (plugins/with-release-signing.js); they are never part of the Expo config, which is embedded in
 * the app manifest.
 *
 * Pure functions; `applyBuildProfile` takes the environment as a parameter so tests need no globals.
 */
'use strict'

const PROFILES = Object.freeze(['LOCAL_DEV', 'LOCAL_RELEASE_TEST', 'PRODUCTION_RELEASE'])
const PRODUCTION = 'PRODUCTION_RELEASE'
const PROFILE_VARIABLE = 'EXPO_PUBLIC_BUILD_PROFILE'

/** Public, non-secret production inputs. All required. */
const PRODUCTION_VALUE_VARIABLES = Object.freeze([
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'POKEPORTFOLIO_ANDROID_APPLICATION_ID',
  'POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER',
  'POKEPORTFOLIO_APPLE_TEAM_ID',
  'POKEPORTFOLIO_APP_VERSION',
  'POKEPORTFOLIO_ANDROID_VERSION_CODE',
  'POKEPORTFOLIO_IOS_BUILD_NUMBER',
])

/** Secret signing inputs. Presence is checked by the Gradle build, never copied into any config. */
const PRODUCTION_SIGNING_VARIABLES = Object.freeze([
  'POKEPORTFOLIO_ANDROID_KEYSTORE_PATH',
  'POKEPORTFOLIO_ANDROID_KEYSTORE_PASSWORD',
  'POKEPORTFOLIO_ANDROID_KEY_ALIAS',
  'POKEPORTFOLIO_ANDROID_KEY_PASSWORD',
])

/** Variables that only make sense for a local or proof build: a production build refuses them. */
const PRODUCTION_FORBIDDEN_VARIABLES = Object.freeze([
  'EXPO_PUBLIC_RUNTIME_PROOF',
  'EXPO_PUBLIC_ANDROID_EMULATOR_HOST',
  'EXPO_PUBLIC_ANDROID_LOOPBACK',
  'SPIKE_PACKAGE',
])

const PROJECT_REF = /^[a-z0-9]{20}$/
const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{16,}$/
const SEMVER = /^\d+\.\d+\.\d+$/
const ANDROID_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
const IOS_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/
const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/
const PLACEHOLDER_SEGMENT = /^(invalid|example|placeholder|changeme|spike|test|todo|your)$/i

class BuildProfileError extends Error {
  /** @param {string[]} problems one line per problem; names and categories only, never values */
  constructor(profile, problems) {
    super(
      `${profile} build configuration is not usable:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n(values are never printed; see docs/mobile/BUILD_CONFIGURATION_PROFILES.md)',
    )
    this.name = 'BuildProfileError'
    this.profile = profile
    this.problems = problems
  }
}

function isPlaceholderIdentifier(id) {
  return id.split('.').some((segment) => PLACEHOLDER_SEGMENT.test(segment))
}

/**
 * The profile named by the environment. An unset or empty variable is LOCAL_DEV (the safest
 * profile: it can only reach a local backend). An unknown value is an error, never a fallback.
 */
function resolveBuildProfile(env) {
  const raw = env[PROFILE_VARIABLE]
  if (raw === undefined || raw.trim() === '') return 'LOCAL_DEV'
  const value = raw.trim()
  if (!PROFILES.includes(value)) {
    throw new BuildProfileError(value.length > 40 ? 'unknown' : value, [
      `${PROFILE_VARIABLE} is not one of ${PROFILES.join(', ')}`,
    ])
  }
  return value
}

/** Problems with a production environment, as category strings. Empty means complete. */
function productionProblems(env) {
  const problems = []
  const value = (name) => (env[name] ?? '').trim()
  for (const name of PRODUCTION_VALUE_VARIABLES) {
    if (value(name) === '') problems.push(`${name} is not set`)
  }
  for (const name of PRODUCTION_FORBIDDEN_VARIABLES) {
    if (value(name) !== '') problems.push(`${name} must not be set for a production build`)
  }

  const url = value('EXPO_PUBLIC_SUPABASE_URL')
  if (url !== '') {
    const match = /^https:\/\/([a-z0-9]+)\.supabase\.co$/.exec(url)
    if (match === null || !PROJECT_REF.test(match[1])) {
      problems.push(
        'EXPO_PUBLIC_SUPABASE_URL is not https://<20-character project ref>.supabase.co',
      )
    }
  }
  const key = value('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  if (key !== '') {
    if (/sb_secret_/i.test(key))
      problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is secret-shaped')
    else if (!PUBLISHABLE_KEY.test(key))
      problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not an sb_publishable_ key')
  }

  const androidId = value('POKEPORTFOLIO_ANDROID_APPLICATION_ID')
  if (androidId !== '') {
    if (!ANDROID_ID.test(androidId))
      problems.push('POKEPORTFOLIO_ANDROID_APPLICATION_ID is not a valid application id')
    else if (isPlaceholderIdentifier(androidId))
      problems.push('POKEPORTFOLIO_ANDROID_APPLICATION_ID is a placeholder identifier')
  }
  const iosId = value('POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER')
  if (iosId !== '') {
    if (!IOS_ID.test(iosId))
      problems.push('POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER is not a valid bundle identifier')
    else if (isPlaceholderIdentifier(iosId))
      problems.push('POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER is a placeholder identifier')
  }
  const team = value('POKEPORTFOLIO_APPLE_TEAM_ID')
  if (team !== '' && !APPLE_TEAM_ID.test(team))
    problems.push('POKEPORTFOLIO_APPLE_TEAM_ID is not a 10-character team id')
  const version = value('POKEPORTFOLIO_APP_VERSION')
  if (version !== '' && (!SEMVER.test(version) || version === '0.0.0'))
    problems.push('POKEPORTFOLIO_APP_VERSION is not a release version (x.y.z, not 0.0.0)')
  const code = value('POKEPORTFOLIO_ANDROID_VERSION_CODE')
  if (code !== '' && !/^[1-9]\d{0,9}$/.test(code))
    problems.push('POKEPORTFOLIO_ANDROID_VERSION_CODE is not a positive integer')
  const build = value('POKEPORTFOLIO_IOS_BUILD_NUMBER')
  if (build !== '' && !/^[1-9]\d{0,8}(\.\d{1,9}){0,2}$/.test(build))
    problems.push('POKEPORTFOLIO_IOS_BUILD_NUMBER is not a build number')
  return problems
}

/** The names of production signing variables that are missing. Used by the Gradle-side guard. */
function missingSigningVariables(env) {
  return PRODUCTION_SIGNING_VARIABLES.filter((name) => (env[name] ?? '').trim() === '')
}

/**
 * The Expo config for the profile. `base` is app.json's `expo` object and is never mutated.
 * LOCAL_* return it unchanged apart from `extra.buildProfile`; PRODUCTION_RELEASE replaces the
 * placeholder identity, drops everything that exists only for a local backend, and adds release
 * signing. Throws BuildProfileError (names only) when the production environment is incomplete.
 */
function applyBuildProfile(base, env) {
  const profile = resolveBuildProfile(env)
  const expo = JSON.parse(JSON.stringify(base))
  expo.extra = { ...(expo.extra ?? {}), buildProfile: profile }
  if (profile !== PRODUCTION) return expo

  const problems = productionProblems(env)
  if (problems.length > 0) throw new BuildProfileError(profile, problems)

  const value = (name) => env[name].trim()
  expo.name = (env.POKEPORTFOLIO_APP_NAME ?? '').trim() || 'PokePortfolio'
  expo.version = value('POKEPORTFOLIO_APP_VERSION')

  expo.android = {
    ...(expo.android ?? {}),
    package: value('POKEPORTFOLIO_ANDROID_APPLICATION_ID'),
    versionCode: Number(value('POKEPORTFOLIO_ANDROID_VERSION_CODE')),
  }

  const { infoPlist = {}, ...ios } = expo.ios ?? {}
  // Local-network exemptions exist only so a device can reach a developer machine over plain HTTP.
  const {
    NSAppTransportSecurity: _ats,
    NSLocalNetworkUsageDescription: _localNetwork,
    ...productionInfoPlist
  } = infoPlist
  void _ats
  void _localNetwork
  expo.ios = {
    ...ios,
    bundleIdentifier: value('POKEPORTFOLIO_IOS_BUNDLE_IDENTIFIER'),
    buildNumber: value('POKEPORTFOLIO_IOS_BUILD_NUMBER'),
    appleTeamId: value('POKEPORTFOLIO_APPLE_TEAM_ID'),
    infoPlist: productionInfoPlist,
  }

  const isPluginNamed = (entry, name) => (Array.isArray(entry) ? entry[0] : entry) === name
  expo.plugins = (expo.plugins ?? []).filter(
    (entry) => !isPluginNamed(entry, './plugins/with-local-cleartext'),
  )
  expo.plugins.push('./plugins/with-release-signing')
  return expo
}

module.exports = {
  PROFILES,
  PROFILE_VARIABLE,
  PRODUCTION_VALUE_VARIABLES,
  PRODUCTION_SIGNING_VARIABLES,
  PRODUCTION_FORBIDDEN_VARIABLES,
  BuildProfileError,
  resolveBuildProfile,
  productionProblems,
  missingSigningVariables,
  applyBuildProfile,
}
