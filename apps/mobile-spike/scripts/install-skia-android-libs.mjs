#!/usr/bin/env node
/**
 * @shopify/react-native-skia's own `npx install-skia` (scripts/install-libs.js) copies each
 * platform's prebuilt static libraries from its own optional-dependency package into
 * `@shopify/react-native-skia/libs/<platform>/` — CMake's Android build reads directly from
 * `libs/android/`. That script unconditionally `require.resolve()`s the Apple (iOS/macOS) packages
 * FIRST and exits before ever reaching the Android copy step if they are not resolvable — real
 * upstream behavior (not this project's own bug), reproduced with the real package and confirmed
 * against its own source (no `--android-only` flag exists). This project never builds iOS, so this
 * script performs just the Android half of the same copy directly from the `react-native-skia-android`
 * optional dependency, which `pnpm install` already installed.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(appRoot, 'node_modules', 'react-native-skia-android', 'libs')
const dest = join(appRoot, 'node_modules', '@shopify', 'react-native-skia', 'libs', 'android')

if (!existsSync(src)) {
  throw new Error(
    `install-skia-android-libs: ${src} does not exist — is react-native-skia-android installed? Run pnpm install first.`,
  )
}
mkdirSync(dest, { recursive: true })
for (const abi of readdirSync(src)) {
  cpSync(join(src, abi), join(dest, abi), { recursive: true })
}
console.log(`Copied Skia Android prebuilt libs (${readdirSync(dest).join(', ')}) to ${dest}.`)
