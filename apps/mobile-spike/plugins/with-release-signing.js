/**
 * Expo config plugin: Android release signing for the PRODUCTION_RELEASE profile (P188).
 *
 * The Expo template signs the release build type with the committed debug keystore. That is correct
 * for a local candidate and wrong for anything distributed. This plugin is added by
 * config/build-profile.cjs ONLY for PRODUCTION_RELEASE. It adds a `release` signing config whose four
 * values are read from the BUILD environment by Gradle itself (never copied into this repository, the
 * generated project or the Expo config), points the release build type at it, and makes the Gradle
 * configuration fail, naming the missing variable, when any value is absent or the keystore file does
 * not exist. A production build can therefore never fall back to the debug keystore.
 *
 * Pure transform `applyReleaseSigning` is exported for tests; it is idempotent and throws when the
 * template no longer has the two shapes it edits (an Expo template change must be a deliberate
 * review, not a silent debug-signed production build).
 */
const { withAppBuildGradle } = require('expo/config-plugins')

const MARKER = 'P188 production release signing'
const VARIABLES = [
  'POKEPORTFOLIO_ANDROID_KEYSTORE_PATH',
  'POKEPORTFOLIO_ANDROID_KEYSTORE_PASSWORD',
  'POKEPORTFOLIO_ANDROID_KEY_ALIAS',
  'POKEPORTFOLIO_ANDROID_KEY_PASSWORD',
]

const RELEASE_SIGNING_BLOCK = `        // ${MARKER}: values come from the build environment, never from this repository.
        release {
            def ppMissing = [${VARIABLES.map((v) => `'${v}'`).join(', ')}].findAll { name ->
                def value = System.getenv(name)
                value == null || value.trim().isEmpty()
            }
            if (!ppMissing.isEmpty()) {
                throw new GradleException('Production release signing is not configured; missing: ' + ppMissing.join(', '))
            }
            def ppKeystore = file(System.getenv('POKEPORTFOLIO_ANDROID_KEYSTORE_PATH'))
            if (!ppKeystore.isFile()) {
                throw new GradleException('POKEPORTFOLIO_ANDROID_KEYSTORE_PATH does not point to a file')
            }
            storeFile ppKeystore
            storePassword System.getenv('POKEPORTFOLIO_ANDROID_KEYSTORE_PASSWORD')
            keyAlias System.getenv('POKEPORTFOLIO_ANDROID_KEY_ALIAS')
            keyPassword System.getenv('POKEPORTFOLIO_ANDROID_KEY_PASSWORD')
        }
`

const DEBUG_SIGNING_BLOCK = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\}\s*\n)/
// Only the release build type is repointed: the pattern runs on the text AFTER \`buildTypes\`, and
// its release body (comments only in the template) holds no brace before the signingConfig line.
const RELEASE_BUILD_TYPE = /(\brelease\s*\{[^}]*?)signingConfig signingConfigs\.debug/

function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents
  const split = contents.indexOf('buildTypes')
  const head = split === -1 ? '' : contents.slice(0, split)
  const tail = split === -1 ? '' : contents.slice(split)
  if (!DEBUG_SIGNING_BLOCK.test(head) || !RELEASE_BUILD_TYPE.test(tail)) {
    throw new Error(
      'with-release-signing: the generated app/build.gradle no longer has the expected debug ' +
        'signingConfig and release buildType; refusing to guess (review the Expo template change)',
    )
  }
  return (
    head.replace(DEBUG_SIGNING_BLOCK, (_m, debugBlock) => debugBlock + RELEASE_SIGNING_BLOCK) +
    tail.replace(
      RELEASE_BUILD_TYPE,
      (_m, before) => before + 'signingConfig signingConfigs.release',
    )
  )
}

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyReleaseSigning(cfg.modResults.contents)
    return cfg
  })
}

module.exports = withReleaseSigning
module.exports.applyReleaseSigning = applyReleaseSigning
module.exports.MARKER = MARKER
module.exports.VARIABLES = VARIABLES
