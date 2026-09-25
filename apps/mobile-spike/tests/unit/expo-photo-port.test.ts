// Classification of picker failures in the expo adapter. The native modules are mocked: this checks
// the mapping only. The real picker, permission dialog and cache cleanup were exercised on an
// Android 16 emulator (docs/mobile/P166_RUNTIME_AND_STITCH_REVIEW.md).
jest.mock('expo-file-system', () => ({
  File: jest.fn(),
  Paths: { cache: { uri: 'file:///cache/' } },
}))
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, canAskAgain: true }),
  ),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}))

import * as ImagePicker from 'expo-image-picker'
import { createExpoPhotoPort } from '../../src/photo/expo-photo-port'

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
