/**
 * Expo config plugin: manually registers onnxruntime-react-native's `ReactPackage`.
 *
 * Every other native module this app uses (ml-kit, Skia, safe-area-context, screens) gets found
 * by the autolinking scan and appears in the generated `PackageList.java` automatically.
 * `onnxruntime-react-native` does not — confirmed by direct testing of the autolinking package's
 * own `react-native-config`/`resolve` commands against this exact package (its own `packageName`,
 * `AndroidManifest.xml`/build.gradle `namespace`, and `OnnxruntimePackage.java`'s `ReactPackage`
 * class-name regex all resolve correctly in isolation; the gap is in an earlier dependency-
 * discovery step this plugin does not attempt to fix upstream). Without this, `NativeModules.
 * Onnxruntime` is `null` at runtime and the package's own `binding.ts` calls `Module.install()`
 * unguarded, crashing the app at JS-module-load time (P182: reproduced on-device — see
 * docs/mobile/P182_PORTABILITY_AUDIT.md).
 *
 * Uses the app's own generated "Packages that cannot be autolinked yet can be added manually
 * here" seam in MainApplication.kt (a comment Expo's own template leaves for exactly this case),
 * not a build-time hack — the officially documented manual-registration escape hatch.
 */
const { withMainApplication } = require('expo/config-plugins')

const IMPORT_LINE = 'import ai.onnxruntime.reactnative.OnnxruntimePackage'
const ADD_LINE = '          add(OnnxruntimePackage())'
const MARKER = 'P182: onnxruntime-react-native is not autolinked, added manually'

function withOnnxruntimePackage(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents
    if (contents.includes(MARKER)) return cfg

    if (!contents.includes(IMPORT_LINE)) {
      contents = contents.replace(
        /(import com\.facebook\.react\.PackageList\n)/,
        `$1${IMPORT_LINE}\n`,
      )
    }

    contents = contents.replace(
      /(\/\/ Packages that cannot be autolinked yet can be added manually here.*\n)/,
      `$1          // ${MARKER}\n${ADD_LINE}\n`,
    )

    cfg.modResults.contents = contents
    return cfg
  })
}

module.exports = withOnnxruntimePackage
