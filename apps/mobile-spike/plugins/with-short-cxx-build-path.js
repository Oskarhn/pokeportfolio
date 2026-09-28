/**
 * Expo config plugin: redirect the app module's ephemeral CMake/Ninja `.cxx` intermediate build
 * output to a short, real path outside this worktree.
 *
 * This worktree's own path (`Documents\Pokemonapp-worktrees\p182\apps\mobile-spike\...`) is long
 * enough that CMake's own 250-character `CMAKE_OBJECT_PATH_MAX` safety check trips for the app
 * module's autolinked native codegen (react-native-screens/react-native-safe-area-context), even
 * with Windows' system-wide long-path support enabled (P182: reproduced on-device — that setting
 * fixes the OS's own MAX_PATH limit, but not this separate, CMake-internal guard). CMake's own
 * documented fix for exactly this situation is `buildStagingDirectory`, which only affects where
 * INTERMEDIATE `.cxx` object files land — never the app's source or its final build outputs.
 *
 * Windows-only: on macOS/Linux CI this worktree's path is short enough that the guard never
 * trips, so the property is only injected when generating for Android on Windows.
 */
const { withAppBuildGradle } = require('expo/config-plugins')
const os = require('node:os')

const MARKER = 'P182 short .cxx build path (Windows CMAKE_OBJECT_PATH_MAX workaround)'

function withShortCxxBuildPath(config) {
  if (os.platform() !== 'win32') return config
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(MARKER)) return cfg
    const stagingDir = `${os.homedir().replace(/\\/g, '/')}/.p182-cxx-build`
    const block = `
android {
    // ${MARKER}
    externalNativeBuild {
        cmake {
            buildStagingDirectory "${stagingDir}"
        }
    }
`
    cfg.modResults.contents = cfg.modResults.contents.replace(/android\s*\{/, block.trimStart())
    return cfg
  })
}

module.exports = withShortCxxBuildPath
