/**
 * Expo config plugin (iOS ONLY): pin the `onnxruntime-c` pod to the version of the JS package.
 *
 * onnxruntime-react-native's podspec depends on `onnxruntime-c` WITHOUT a version, so `pod install`
 * resolves whatever CocoaPods trunk has newest on the day. The native glue (cpp/, ios/*.mm) of
 * onnxruntime-react-native 1.24.3 is compiled against that C library; a newer, unreviewed
 * onnxruntime-c would silently change the model runtime. onnxruntime-c 1.24.3 exists on trunk
 * (iOS 15.1, static xcframework) and is the version the Android build runs (same release train).
 *
 * Registers an iOS mod only (pinned by tests/unit/p187-ios-config.test.ts). Throws if the Podfile
 * no longer has the anchor line, so template drift fails the prebuild instead of dropping the pin.
 */
const { withPodfile } = require('expo/config-plugins')

const ANCHOR = '  use_expo_modules!\n'

/** @param {string} podfile @param {string} version */
function pinOnnxruntimeC(podfile, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`unexpected onnxruntime version ${version}`)
  const line = `  pod 'onnxruntime-c', '${version}'\n`
  if (podfile.includes(line)) return podfile
  if (!podfile.includes(ANCHOR)) {
    throw new Error(
      'with-ios-onnxruntime-pin: Podfile has no `use_expo_modules!` anchor; update the plugin.',
    )
  }
  return podfile.replace(ANCHOR, `${ANCHOR}${line}`)
}

function withIosOnnxruntimePin(config) {
  return withPodfile(config, (cfg) => {
    const { version } = require('onnxruntime-react-native/package.json')
    cfg.modResults.contents = pinOnnxruntimeC(cfg.modResults.contents, version)
    return cfg
  })
}

module.exports = withIosOnnxruntimePin
module.exports.pinOnnxruntimeC = pinOnnxruntimeC
