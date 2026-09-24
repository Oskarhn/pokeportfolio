import { File, Paths } from 'expo-file-system'
import * as ImagePicker from 'expo-image-picker'
import type { PhotoOutcome, PhotoPort } from './photo-store'

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
 * Runtime behaviour (permission dialogs, the picker UI, the cache copy) is NOT verified: no emulator
 * or device was available. It is exercised through fakes in tests/unit/photo-store.test.ts.
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
        const message = error instanceof Error ? error.message : ''
        return { status: 'unavailable', reason: /camera/i.test(message) ? 'no_camera' : 'error' }
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
  }
}
