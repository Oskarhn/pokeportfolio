import { Directory, File, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import type { PhotoOutcome, PhotoPort, UnavailableReason } from './photo-store'

/**
 * expo-image-picker / expo-file-system adapter for the photo spike. On-device only: no network API is
 * imported here or in photo-store.ts.
 *
 * - Camera: requests the camera permission (opt-in, at the moment the person asks) and launches the
 *   system camera UI. Library: the system photo picker (Android photo picker / iOS PHPicker) needs no
 *   broad library permission, so none is requested.
 * - `exif: false` and no base64: location metadata and pixel data are not pulled into JS memory.
 * - `deleteFile` deletes ONLY files under the app's cache directory, which is where the picker copies
 *   the chosen image. Anything else is not owned by the app and is left alone.
 *
 * Android runtime behaviour (permission dialog, picker, camera, cache copy deleted on exit) was
 * exercised on an Android 16 emulator in P166. The picker launch that failed after an Activity
 * recreation (font scale, display size, locale: P166 F1) is fixed by the expo-modules-core patch in
 * patches/ and re-verified on the emulator (docs/mobile/P167_ANDROID_HARDENING.md).
 * iOS is not verified. Store logic is tested through fakes in tests/unit/photo-store.test.ts.
 */

export function createExpoPhotoPort(now: () => string = () => new Date().toISOString()): PhotoPort {
  return {
    async acquire(source): Promise<PhotoOutcome> {
      if (source === 'camera') {
        const permission = await ImagePicker.requestCameraPermissionsAsync()
        if (!permission.granted) {
          return { status: 'permission_denied', canAskAgain: permission.canAskAgain }
        }
      }
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        allowsEditing: false,
        exif: false,
        base64: false,
        quality: 0.8,
      }
      let result: ImagePicker.ImagePickerResult
      try {
        result =
          source === 'camera'
            ? await ImagePicker.launchCameraAsync(options)
            : await ImagePicker.launchImageLibraryAsync({
                ...options,
                allowsMultipleSelection: false,
              })
      } catch (error) {
        // Only the camera path can mean "no camera". A library failure is an error even when its
        // message mentions a camera (seen on an Android 16 emulator: the library picker failed once
        // and the screen told the person the CAMERA was unavailable).
        const message = error instanceof Error ? error.message : ''
        // The picker's own message carries no personal data; without it a device failure is opaque.
        console.warn(`photo ${source} failed: ${message || String(error)}`)
        return { status: 'unavailable', reason: classifyPickerFailure(source, message) }
      }
      if (result.canceled) return { status: 'cancelled' }
      const asset = result.assets[0]
      if (asset === undefined) return { status: 'cancelled' }
      return {
        status: 'picked',
        image: {
          kind: 'local_image',
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          source,
          acquiredAt: now(),
        },
      }
    },

    async deleteFile(uri): Promise<void> {
      if (!uri.startsWith(Paths.cache.uri)) return
      const file = new File(uri)
      if (file.exists) file.delete()
      return Promise.resolve()
    },

    async purgeOwnedCache(): Promise<number> {
      // expo-image-picker writes every copy to <cache>/ImagePicker (ImagePickerConstants.CACHE_DIR_NAME
      // on Android). Only files in that app-owned folder are removed; nothing else in the cache.
      const folder = new Directory(Paths.cache, PICKER_CACHE_DIR)
      if (!folder.exists) return Promise.resolve(0)
      let removed = 0
      for (const entry of folder.list()) {
        if (entry instanceof File) {
          entry.delete()
          removed += 1
        }
      }
      return Promise.resolve(removed)
    },
  }
}

export const PICKER_CACHE_DIR = 'ImagePicker'

/**
 * Only the camera path can mean "no camera": a library failure whose message mentions a camera is an
 * error (seen on an Android 16 emulator in P166). An unregistered Activity-result launcher (P167 F1)
 * cannot be retried away; only a restart of the app (or the expo-modules-core patch) restores it.
 */
export function classifyPickerFailure(
  source: 'camera' | 'library',
  message: string,
): UnavailableReason {
  if (/unregistered ActivityResultLauncher/i.test(message)) return 'restart_required'
  if (source === 'camera' && /camera/i.test(message)) return 'no_camera'
  return 'error'
}
