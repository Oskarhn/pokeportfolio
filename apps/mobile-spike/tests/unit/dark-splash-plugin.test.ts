// plugins/with-dark-splash-background.js: the generated Theme.App.SplashScreen style must
// declare android:windowSplashScreenBackground, or Android 12+'s mandatory SplashScreen API
// shows its own white default (icon on white) for the true first frame regardless of the app's
// own windowBackground — reproduced on a real Android 16 device (P179).
interface StyleItem {
  $: { name: string }
  _: string
}
interface StyleGroup {
  $: { name: string; parent?: string }
  item?: StyleItem[]
}
interface StylesXml {
  resources: { style: StyleGroup[] }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../plugins/with-dark-splash-background') as {
  setDarkSplashBackground: (xml: StylesXml, colorRef: string) => StylesXml
  SPLASH_THEME: { name: string }
  ITEM_NAME: string
}

const BASE_STYLES: StylesXml = {
  resources: {
    style: [
      {
        $: { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' },
        item: [{ $: { name: 'android:windowBackground' }, _: '@color/activityBackground' }],
      },
      {
        $: { name: 'Theme.App.SplashScreen', parent: 'AppTheme' },
        item: [{ $: { name: 'android:windowBackground' }, _: '@drawable/splashscreen_logo' }],
      },
    ],
  },
}

function splashItems(xml: StylesXml): StyleItem[] {
  const theme = xml.resources.style.find((s) => s.$.name === 'Theme.App.SplashScreen')
  return theme?.item ?? []
}

describe('dark splash background config plugin', () => {
  it('adds android:windowSplashScreenBackground to the splash theme, pointing at the same dark ground colour AppTheme itself uses', () => {
    const out = plugin.setDarkSplashBackground(BASE_STYLES, '@color/activityBackground')
    const items = splashItems(out)
    const added = items.find((i) => i.$.name === 'android:windowSplashScreenBackground')
    expect(added?._).toBe('@color/activityBackground')
    // the legacy attribute (harmless on API < 31) is left in place, not replaced
    expect(items.some((i) => i.$.name === 'android:windowBackground')).toBe(true)
  })

  it('is idempotent across prebuilds (overwrites, never duplicates, the same item)', () => {
    const once = plugin.setDarkSplashBackground(BASE_STYLES, '@color/activityBackground')
    const twice = plugin.setDarkSplashBackground(once, '@color/activityBackground')
    const items = splashItems(twice)
    expect(items.filter((i) => i.$.name === 'android:windowSplashScreenBackground')).toHaveLength(1)
  })

  it('is registered in app.json', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app = require('../../app.json') as { expo: { plugins: unknown[] } }
    expect(app.expo.plugins).toContain('./plugins/with-dark-splash-background')
  })
})
