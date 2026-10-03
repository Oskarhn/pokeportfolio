// plugins/with-navigation-bar-follows-theme.js: the generated MainActivity must re-apply the
// navigation-bar icon style on a live light/dark switch (P167 F5, 3-button navigation).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/with-navigation-bar-follows-theme') as {
  addNavigationBarOverride: (source: string, language: string) => string
  MARKER: string
}

const MAIN_ACTIVITY = `package invalid.pokeportfolio.spike

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun getMainComponentName(): String = "main"
}
`

describe('navigation bar follows theme config plugin', () => {
  it('adds an onConfigurationChanged override that sets light icons only in dark mode', () => {
    const out = plugin.addNavigationBarOverride(MAIN_ACTIVITY, 'kt')
    expect(out).toContain(
      'override fun onConfigurationChanged(newConfig: android.content.res.Configuration)',
    )
    expect(out).toContain('super.onConfigurationChanged(newConfig)')
    expect(out).toContain('val dark = night == android.content.res.Configuration.UI_MODE_NIGHT_YES')
    expect(out).toContain('.isAppearanceLightNavigationBars = !dark')
    // inside the class body, before its closing brace
    expect(out.trimEnd().endsWith('}')).toBe(true)
    expect(out.indexOf('getMainComponentName')).toBeLessThan(out.indexOf(plugin.MARKER))
  })

  it('is idempotent across prebuilds', () => {
    const once = plugin.addNavigationBarOverride(MAIN_ACTIVITY, 'kt')
    expect(plugin.addNavigationBarOverride(once, 'kt')).toBe(once)
  })

  it('refuses Java and an existing override instead of producing a broken file', () => {
    expect(() => plugin.addNavigationBarOverride(MAIN_ACTIVITY, 'java')).toThrow(/Kotlin/)
    const existing = MAIN_ACTIVITY.replace(
      '  override fun getMainComponentName',
      '  override fun onConfigurationChanged(c: Configuration) {}\n  override fun getMainComponentName',
    )
    expect(() => plugin.addNavigationBarOverride(existing, 'kt')).toThrow(/already overrides/)
  })

  it('is registered in app.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require('../../app.json') as { expo: { plugins: unknown[] } }
    expect(app.expo.plugins).toContain('./plugins/with-navigation-bar-follows-theme')
  })
})
