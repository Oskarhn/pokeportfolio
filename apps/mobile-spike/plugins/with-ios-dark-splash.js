/**
 * Expo config plugin (iOS ONLY): make the launch screen the app's own dark ground colour.
 *
 * The prebuild template's SplashScreen.storyboard paints `systemBackgroundColor` (pure black once the
 * app forces the dark user-interface style, white otherwise) and shows an image named `SplashScreen`
 * that the template does not ship. The first frame would therefore be black (not #0F0F11) and the
 * image view would reference a missing asset. The app has no logo yet (the icon is an open design
 * decision, as on Android: plugins/with-dark-splash-background.js), so this writes the background
 * colour and drops the dangling image view and its constraints.
 *
 * Android's splash is handled by a different plugin; nothing here touches an Android mod, and this
 * file registers no Android mod (pinned by tests/unit/p187-ios-config.test.ts). The edit throws if the
 * storyboard no longer has the shape it expects, so a template change fails the prebuild loudly
 * instead of silently shipping a white launch screen.
 */
const { withDangerousMod } = require('expo/config-plugins')
const fs = require('node:fs')
const path = require('node:path')

// #0F0F11, the app's dark root (app.json `backgroundColor`), as the sRGB fractions Interface Builder stores.
const BACKGROUND =
  '<color key="backgroundColor" red="0.058823529411764705" green="0.058823529411764705" blue="0.06666666666666667" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>'

/** @param {string} xml the generated SplashScreen.storyboard */
function darkSplashStoryboard(xml) {
  const background = '<color key="backgroundColor" systemColor="systemBackgroundColor"/>'
  const subviews = /\s*<subviews>[\s\S]*?<\/subviews>/
  const constraints = /\s*<constraints>[\s\S]*?<\/constraints>/
  const imageResource = /\s*<image name="SplashScreenLogo"[^>]*\/>/
  if (!xml.includes(background) || !subviews.test(xml)) {
    throw new Error(
      'with-ios-dark-splash: SplashScreen.storyboard has an unexpected shape; update the plugin.',
    )
  }
  return xml
    .replace(subviews, '')
    .replace(constraints, '')
    .replace(imageResource, '')
    .replace(background, BACKGROUND)
}

function withIosDarkSplash(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const file = path.join(
        cfg.modRequest.platformProjectRoot,
        cfg.modRequest.projectName,
        'SplashScreen.storyboard',
      )
      fs.writeFileSync(file, darkSplashStoryboard(fs.readFileSync(file, 'utf8')))
      return cfg
    },
  ])
}

module.exports = withIosDarkSplash
module.exports.darkSplashStoryboard = darkSplashStoryboard
