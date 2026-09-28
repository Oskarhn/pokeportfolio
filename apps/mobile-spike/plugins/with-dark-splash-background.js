/**
 * Expo config plugin: paint Android 12+'s mandatory system splash-screen window with the app's
 * own dark ground colour, instead of the OS default (a plain white window with the generic
 * Android robot placeholder icon).
 *
 * Without this, the generated `Theme.App.SplashScreen` style never declares the platform's
 * `android:windowSplashScreenBackground` attribute (only the older `android:windowBackground`,
 * which the mandatory SplashScreen API on API 31+ does not read for the very first frame). The
 * app's own `userInterfaceStyle`/`backgroundColor` in app.json control `expo-status-bar` and the
 * in-JS `AppThemeProvider` default, not this native cold-start window — so both can already be
 * dark while the true first frame the person sees is still white (P179: reproduced on a real
 * Android 16 device across repeated cold starts, contradicting P178's own "no white flash"
 * claim, which was verified with a screenshot taken after this transition had already
 * completed).
 *
 * `android:windowSplashScreenBackground` is a normal theme attribute: declaring it on
 * `Theme.App.SplashScreen` (the theme MainActivity's manifest entry already uses) takes effect
 * on API 31+ and is silently ignored below it. No new asset and no icon decision (the app icon
 * is still explicitly undecided, per app.json's own §32 note) — only the background colour
 * behind it changes. No new dependency: `@expo/config-plugins`' own Styles helper, already on
 * the classpath via `expo/config-plugins` (same package the sibling plugins in this folder use).
 */
const { withAndroidStyles, AndroidConfig } = require('expo/config-plugins')

const SPLASH_THEME = { name: 'Theme.App.SplashScreen' }
const ITEM_NAME = 'android:windowSplashScreenBackground'

/** @param {import('@expo/config-plugins').ResourceXML} xml */
function setDarkSplashBackground(xml, colorRef) {
  return AndroidConfig.Styles.assignStylesValue(xml, {
    add: true,
    parent: SPLASH_THEME,
    name: ITEM_NAME,
    value: colorRef,
  })
}

function withDarkSplashBackground(config) {
  const colorRef = `@color/activityBackground`
  return withAndroidStyles(config, (cfg) => {
    cfg.modResults = setDarkSplashBackground(cfg.modResults, colorRef)
    return cfg
  })
}

module.exports = withDarkSplashBackground
module.exports.setDarkSplashBackground = setDarkSplashBackground
module.exports.SPLASH_THEME = SPLASH_THEME
module.exports.ITEM_NAME = ITEM_NAME
