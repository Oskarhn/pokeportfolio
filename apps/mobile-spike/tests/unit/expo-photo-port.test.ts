// Classification of picker failures in the expo adapter. The native modules are mocked: this checks
// the mapping only. The real picker, permission dialog and cache cleanup were exercised on an
// Android 16 emulator (docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md).
jest.mock('expo-file-system', () => {
  class File {
    deleted = false
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
    delete() {
      this.deleted = true
    }
  }
  class Directory {
    name: string
    constructor(_parent: unknown, name: string) {
      this.name = name
    }
    get exists() {
      return mockDir.exists
    }
    list() {
      return mockDir.entries
    }
  }
  return { File, Directory, Paths: { cache: { uri: 'file:///cache/' } } }
})
const mockDir: { exists: boolean; entries: unknown[] } = { exists: false, entries: [] }
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, canAskAgain: true }),
  ),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}))

import * as ImagePicker from 'expo-image-picker'
import { Directory, File } from 'expo-file-system'
import {
  PICKER_CACHE_DIR,
  classifyPickerFailure,
  createExpoPhotoPort,
} from '../../src/photo/expo-photo-port'

const launchCamera = ImagePicker.launchCameraAsync as jest.Mock
const launchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock

describe('expo photo port: failure classification', () => {
  it('a camera failure that names the camera is "no_camera"', async () => {
    launchCamera.mockRejectedValueOnce(new Error('No camera available on this device'))
    await expect(createExpoPhotoPort().acquire('camera')).resolves.toEqual({
      status: 'unavailable',
      reason: 'no_camera',
    })
  })

  it('a library failure is "error" even when its message mentions a camera', async () => {
    launchLibrary.mockRejectedValueOnce(new Error('Activity for camera roll could not be started'))
    await expect(createExpoPhotoPort().acquire('library')).resolves.toEqual({
      status: 'unavailable',
      reason: 'error',
    })
  })
})

describe('P167: launcher lost after an Activity recreation, orphaned picker copies', () => {
  const UNREGISTERED =
    "Call to function 'ExponentImagePicker.launchImageLibraryAsync' has been rejected. → Caused by: java.lang.IllegalStateException: Attempting to launch an unregistered ActivityResultLauncher with contract expo.modules.imagepicker.contracts.ImageLibraryContract@f5a32b6"

  it('the exact P166/P167 device message is "restart_required", on either source', async () => {
    launchLibrary.mockRejectedValueOnce(new Error(UNREGISTERED))
    await expect(createExpoPhotoPort().acquire('library')).resolves.toEqual({
      status: 'unavailable',
      reason: 'restart_required',
    })
    expect(classifyPickerFailure('camera', UNREGISTERED.replace('ImageLibrary', 'Camera'))).toBe(
      'restart_required',
    )
  })

  it('purgeOwnedCache deletes the files in the picker folder only, and counts them', async () => {
    const a = new File('file:///cache/ImagePicker/a.png')
    const b = new File('file:///cache/ImagePicker/b.jpg')
    const nested = new Directory('file:///cache/ImagePicker', 'sub')
    mockDir.exists = true
    mockDir.entries = [a, nested, b]
    await expect(createExpoPhotoPort().purgeOwnedCache()).resolves.toBe(2)
    expect((a as unknown as { deleted: boolean }).deleted).toBe(true)
    expect((b as unknown as { deleted: boolean }).deleted).toBe(true)
    expect(PICKER_CACHE_DIR).toBe('ImagePicker')
  })

  it('purgeOwnedCache is a no-op when the picker folder does not exist', async () => {
    mockDir.exists = false
    await expect(createExpoPhotoPort().purgeOwnedCache()).resolves.toBe(0)
  })
})
