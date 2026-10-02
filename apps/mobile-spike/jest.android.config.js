// P187: the same native unit suite, resolved the way Metro resolves it for ANDROID (haste platform
// `android`, Platform.OS 'android'). The default `unit` project uses the `jest-expo` preset, whose
// default platform is iOS, so a plain `pnpm test` already imports the JS graph the iOS way; this
// config proves the Android resolution still works after the iOS portability changes.
//   pnpm test:android-resolver
const base = require('./jest.config.js')
const path = require('node:path')

const unit = base.projects.find((project) => project.displayName === 'unit')
module.exports = {
  testTimeout: base.testTimeout,
  projects: [
    {
      ...unit,
      displayName: 'unit-android',
      preset: path.resolve(__dirname, 'node_modules/jest-expo/android'),
    },
  ],
}
