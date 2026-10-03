/**
 * Expo config plugin: redirect the app module's ephemeral CMake/Ninja `.cxx` intermediate build
 * output to a short, real path outside the checkout.
 *
 * A worktree path such as `Documents\Pokemonapp-worktrees\<name>\apps\mobile-spike\...` is long
 * enough that CMake's own 250-character `CMAKE_OBJECT_PATH_MAX` safety check trips for the app
 * module's autolinked native codegen (react-native-screens/react-native-safe-area-context), even
 * with Windows' system-wide long-path support enabled (P182: reproduced on-device — that setting
 * fixes the OS's own MAX_PATH limit, but not this separate, CMake-internal guard). CMake's own
 * documented fix for exactly this situation is `buildStagingDirectory`, which only affects where
 * INTERMEDIATE `.cxx` object files land — never the app's source or its final build outputs.
 *
 * Windows-only: on macOS/Linux CI the path is short enough that the guard never trips, so the
 * property is only injected when generating for Android on Windows.
 *
 * P184: the staging directory is keyed by a short hash of THIS project's root (was a single shared
 * `~/.p182-cxx-build`), so two checkouts or worktrees built on one machine never share, or corrupt,
 * each other's CMake state. The home directory comes from `os.homedir()`, never a literal path.
 *
 * P186: the same guard trips in the LIBRARY modules that build their own native code
 * (onnxruntime-react-native's `onnxruntimejsi` target): their `.cxx` directory sits inside
 * node_modules and CMake mirrors the absolute source path under CMakeFiles/, so the object path
 * exceeds Windows' 260 characters. It passes for x86_64 and fails for arm64-v8a (three characters
 * longer) at this checkout depth, so a release bundle that carries arm64 needs it. The root project
 * now gives every Android library module that declares a CMake build its own short staging
 * directory under the same per-project hash.
 */
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins')
const { createHash } = require('node:crypto')
const os = require('node:os')

const MARKER = 'short .cxx build path (Windows CMAKE_OBJECT_PATH_MAX workaround)'

/** Short, stable, per-project staging directory (forward slashes: it is written into Gradle). */
function stagingDirFor(projectRoot, homedir = os.homedir()) {
  const key = createHash('sha256').update(projectRoot).digest('hex').slice(0, 8)
  return `${homedir.replace(/\\/g, '/')}/.pokeportfolio-cxx/${key}`
}

function injectStagingDir(contents, stagingDir) {
  if (contents.includes(MARKER)) return contents
  const block = `
android {
    // ${MARKER}
    externalNativeBuild {
        cmake {
            buildStagingDirectory "${stagingDir}"
        }
    }
`
  return contents.replace(/android\s*\{/, block.trimStart())
}

const LIBRARY_MARKER =
  'short .cxx build path for library modules (Windows CMAKE_OBJECT_PATH_MAX workaround)'

/**
 * Appends to the root build.gradle a block that points every Android library module's CMake
 * staging directory at `<stagingDir>/<module name>` (only modules that declare a CMake build).
 */
function injectLibraryStagingDirs(contents, stagingDir) {
  if (contents.includes(LIBRARY_MARKER)) return contents
  const block = `
// ${LIBRARY_MARKER}
subprojects { subproject ->
    def shortCxx = {
        def android = subproject.extensions.findByName('android')
        if (android != null && subproject.plugins.hasPlugin('com.android.library')) {
            def cmake = android.externalNativeBuild.cmake
            if (cmake.path != null) {
                cmake.buildStagingDirectory = new File("${stagingDir}/" + subproject.name)
            }
        }
    }
    // A module that is already evaluated cannot take afterEvaluate (Gradle refuses it).
    if (subproject.state.executed) shortCxx() else subproject.afterEvaluate(shortCxx)
}
`
  return contents.endsWith('\n') ? contents + block : `${contents}\n${block}`
}

function withShortCxxBuildPath(config) {
  if (os.platform() !== 'win32') return config
  const withApp = withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = injectStagingDir(
      cfg.modResults.contents,
      stagingDirFor(cfg.modRequest.projectRoot),
    )
    return cfg
  })
  return withProjectBuildGradle(withApp, (cfg) => {
    cfg.modResults.contents = injectLibraryStagingDirs(
      cfg.modResults.contents,
      stagingDirFor(cfg.modRequest.projectRoot),
    )
    return cfg
  })
}

module.exports = withShortCxxBuildPath
module.exports.stagingDirFor = stagingDirFor
module.exports.injectStagingDir = injectStagingDir
module.exports.injectLibraryStagingDirs = injectLibraryStagingDirs
module.exports.MARKER = MARKER
module.exports.LIBRARY_MARKER = LIBRARY_MARKER
