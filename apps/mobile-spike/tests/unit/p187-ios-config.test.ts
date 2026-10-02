/**
 * @jest-environment node
 */
// P187: iOS configuration, checked statically on Windows. Two things are covered:
//   1. every Android-specific config plugin registers mods for the ANDROID platform only, so an iOS
//      prebuild cannot be mutated by them (a plugin that touched an iOS mod would corrupt Info.plist
//      / the Xcode project, or throw on a machine with no Android project);
//   2. the resolved iOS Info.plist (Expo's own `config --type introspect`, which runs the iOS mods
//      without writing files) carries exactly the permissions and dark-first settings the app needs.
// This is configuration readiness only: it does not generate or build an Xcode project.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const appRoot = join(__dirname, '..', '..')
const appJson = JSON.parse(readFileSync(join(appRoot, 'app.json'), 'utf8')) as {
  expo: {
    plugins: (string | [string, Record<string, unknown>])[]
    android: { blockedPermissions: string[] }
  } & Record<string, unknown>
}
const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

type ModRegistry = Record<string, unknown>
type PluginFn = (config: { name: string; slug: string; mods?: ModRegistry }) => {
  mods?: ModRegistry
}

const IOS_PLUGIN_PATHS = ['./plugins/with-ios-dark-splash']
const ALL_LOCAL_PLUGIN_PATHS = appJson.expo.plugins
  .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
  .filter((name) => name.startsWith('./plugins/'))
const LOCAL_PLUGIN_PATHS = ALL_LOCAL_PLUGIN_PATHS.filter((name) => !IOS_PLUGIN_PATHS.includes(name))

describe('Android-specific config plugins are scoped to Android (P187)', () => {
  it('the app lists the local plugins this test covers (six Android, one iOS)', () => {
    expect([...ALL_LOCAL_PLUGIN_PATHS].sort()).toEqual([
      './plugins/with-dark-splash-background',
      './plugins/with-ios-dark-splash',
      './plugins/with-local-cleartext',
      './plugins/with-navigation-bar-follows-theme',
      './plugins/with-onnxruntime-package',
      './plugins/with-release-packaging',
      './plugins/with-short-cxx-build-path',
    ])
  })

  it.each(LOCAL_PLUGIN_PATHS)('%s registers mods for android only', (relative) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require(join(appRoot, relative)) as PluginFn
    const result = plugin({ name: 'p187', slug: 'p187' })
    const platforms = Object.keys(result.mods ?? {})
    expect(platforms.length).toBeGreaterThan(0) // the plugin really registered something
    expect(platforms).toEqual(['android'])
  })
})

describe('the iOS-only config plugin never touches Android (P187)', () => {
  it.each(IOS_PLUGIN_PATHS)('%s registers mods for ios only', (relative) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const plugin = require(join(appRoot, relative)) as PluginFn
    const platforms = Object.keys(plugin({ name: 'p187', slug: 'p187' }).mods ?? {})
    expect(platforms).toEqual(['ios'])
  })

  it('the dark splash storyboard transform paints #0F0F11, drops the dangling image view, and fails loudly on drift', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { darkSplashStoryboard } = require(join(appRoot, IOS_PLUGIN_PATHS[0]!)) as {
      darkSplashStoryboard: (xml: string) => string
    }
    const template = `<view key="view">
  <subviews>
    <imageView image="SplashScreen" id="EXPO-SplashScreen"/>
  </subviews>
  <constraints>
    <constraint firstItem="EXPO-SplashScreen"/>
  </constraints>
  <color key="backgroundColor" systemColor="systemBackgroundColor"/>
</view>
<resources>
  <image name="SplashScreenLogo" width="100" height="90"/>
</resources>`
    const out = darkSplashStoryboard(template)
    expect(out).toContain('red="0.0588')
    expect(out).not.toContain('<color key="backgroundColor" systemColor')
    expect(out).not.toContain('imageView')
    expect(out).not.toContain('SplashScreenLogo')
    expect(() => darkSplashStoryboard('<view/>')).toThrow(/unexpected shape/)
  })
})

describe('resolved iOS Info.plist (expo config --type introspect)', () => {
  let ios: Record<string, unknown>
  let android: { permissions?: string[] }

  beforeAll(() => {
    const out = execFileSync(
      process.execPath,
      [
        join(appRoot, 'node_modules', 'expo', 'bin', 'cli'),
        'config',
        '--type',
        'introspect',
        '--json',
      ],
      { cwd: appRoot, encoding: 'utf8', env: { ...process.env, CI: '1' } },
    )
    const resolved = JSON.parse(out.slice(out.indexOf('{'))) as {
      ios: { infoPlist: Record<string, unknown> }
      android: { permissions?: string[] }
    }
    ios = resolved.ios.infoPlist
    android = resolved.android
  }, 120_000)

  it('asks for the camera and the photo library, in words that say recognition is local', () => {
    for (const key of ['NSCameraUsageDescription', 'NSPhotoLibraryUsageDescription']) {
      const text = ios[key]
      expect(typeof text).toBe('string')
      expect(text).toMatch(/on this device/)
      expect(text).toMatch(/never uploaded/)
    }
  })

  it('declares no permission the app never uses (no microphone, no Face ID)', () => {
    expect(ios).not.toHaveProperty('NSMicrophoneUsageDescription')
    expect(ios).not.toHaveProperty('NSFaceIDUsageDescription')
    expect(ios).not.toHaveProperty('NSLocationWhenInUseUsageDescription')
    expect(ios).not.toHaveProperty('NSContactsUsageDescription')
    expect(android.permissions ?? []).not.toContain('android.permission.RECORD_AUDIO')
  })

  it('blocks the Android permissions no feature uses (merged in by React Native / androidx.biometric)', () => {
    expect(appJson.expo.android.blockedPermissions.sort()).toEqual([
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      'android.permission.VIBRATE',
    ])
  })

  it('is dark-first: forced dark style and a dark native root view, never a white one', () => {
    expect(ios.UIUserInterfaceStyle).toBe('Dark')
    // RCTRootViewBackgroundColor is written by the expo-system-ui plugin from `backgroundColor`.
    // Without that package Expo only warns, and the root view is white.
    expect(typeof ios.RCTRootViewBackgroundColor).toBe('number')
    // 0xFF0F0F11 = the app's #0F0F11, opaque.
    expect(ios.RCTRootViewBackgroundColor).toBe(0xff0f0f11)
    expect(pkg.dependencies).toHaveProperty('expo-system-ui')
  })

  it('keeps App Transport Security ON: only local-network loads are exempt (no NSAllowsArbitraryLoads)', () => {
    const ats = ios.NSAppTransportSecurity as Record<string, unknown>
    expect(ats).toEqual({ NSAllowsLocalNetworking: true })
    expect(typeof ios.NSLocalNetworkUsageDescription).toBe('string')
  })

  it('is portrait-only on iPhone (no iPad layout is built or claimed)', () => {
    expect(ios.UISupportedInterfaceOrientations).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
    ])
    expect(appJson.expo.ios).toMatchObject({ supportsTablet: false })
  })
})

describe('app.json permission plugin options', () => {
  function options(name: string): Record<string, unknown> {
    const entry = appJson.expo.plugins.find((p) => Array.isArray(p) && p[0] === name)
    expect(entry).toBeDefined()
    return (entry as [string, Record<string, unknown>])[1]
  }

  it('expo-image-picker switches the microphone off (it also adds RECORD_AUDIO on Android)', () => {
    expect(options('expo-image-picker').microphonePermission).toBe(false)
  })

  it('expo-secure-store switches the Face ID usage text off (the store is never biometric-gated)', () => {
    expect(options('expo-secure-store').faceIDPermission).toBe(false)
  })
})
