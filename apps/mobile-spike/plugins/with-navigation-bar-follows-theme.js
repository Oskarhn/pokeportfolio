/**
 * Expo config plugin: keep the Android navigation-bar icon style in step with a live light/dark switch.
 *
 * React Native's edge-to-edge setup (WindowUtil.enableEdgeToEdge) chooses the navigation-bar icon
 * style ONCE, when the Activity is created. Expo declares `uiMode` in MainActivity's configChanges, so
 * a light/dark switch does not recreate the Activity and the style stays as it was. With gesture
 * navigation the system samples the background and hides this; with 3-button navigation the bar kept
 * a light scrim with dark buttons under the dark app (seen on the Android 16 emulator in P167). The
 * status bar is handled in JS by expo-status-bar ("auto").
 *
 * This adds an onConfigurationChanged override to the generated MainActivity that re-applies the same
 * rule RN uses at creation (light icons in dark mode). Idempotent: a second prebuild does not add it
 * twice. No new dependency (androidx.core is already on the classpath).
 */
const { withMainActivity } = require('expo/config-plugins')

const MARKER = '// P167: navigation-bar icon style follows a live light/dark switch'

const KOTLIN_OVERRIDE = `
  ${MARKER}
  override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
    super.onConfigurationChanged(newConfig)
    val night = newConfig.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
    val dark = night == android.content.res.Configuration.UI_MODE_NIGHT_YES
    androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
      .isAppearanceLightNavigationBars = !dark
  }
`

/** Inserts the override before the class's closing brace. Throws if the source is not Kotlin. */
function addNavigationBarOverride(source, language) {
  if (language !== 'kt')
    throw new Error('with-navigation-bar-follows-theme: MainActivity must be Kotlin')
  if (source.includes(MARKER)) return source
  if (/override fun onConfigurationChanged\(/.test(source)) {
    throw new Error(
      'with-navigation-bar-follows-theme: MainActivity already overrides onConfigurationChanged',
    )
  }
  const end = source.lastIndexOf('}')
  if (end === -1) throw new Error('with-navigation-bar-follows-theme: no class body found')
  return `${source.slice(0, end).replace(/\s*$/, '\n')}${KOTLIN_OVERRIDE}}\n`
}

function withNavigationBarFollowsTheme(config) {
  return withMainActivity(config, (cfg) => {
    cfg.modResults.contents = addNavigationBarOverride(
      cfg.modResults.contents,
      cfg.modResults.language,
    )
    return cfg
  })
}

module.exports = withNavigationBarFollowsTheme
module.exports.addNavigationBarOverride = addNavigationBarOverride
module.exports.MARKER = MARKER
