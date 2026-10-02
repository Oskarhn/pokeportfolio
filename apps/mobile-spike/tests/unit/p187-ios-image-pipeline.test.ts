// P187: the photo -> OCR -> decode path on iOS, checked at the seams a Windows host can reach. The
// native iOS behaviour itself (HEIC re-encode, orientation baking, NSURL handling) is read from the
// installed packages' sources and recorded in docs/mobile/IOS_PORTABILITY_AUDIT.md; the properties
// this app relies on are pinned here so a change to them fails loudly instead of failing on a phone.
jest.mock('expo-file-system', () => {
  class File {
    uri: string
    constructor(uri: string) {
      this.uri = uri
    }
  }
  class Directory {}
  return { File, Directory, Paths: { cache: { uri: 'file:///cache/' } } }
})
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() =>
    Promise.resolve({ granted: true, canAskAgain: true }),
  ),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}))

import * as ImagePicker from 'expo-image-picker'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isNativeReadableFileUri } from '../../src/features/scanner-native/ocr-adapter'
import { sniffImageHeader } from '../../src/features/scanner-native/image-header'
import { PICKER_QUALITY, createExpoPhotoPort } from '../../src/photo/expo-photo-port'
import { loadBackendConfig, resolvePlatformUrl } from '../../src/config/backend-config'

const appRoot = join(__dirname, '..', '..')

describe('picker options that keep iOS output decodable and private', () => {
  const launch = ImagePicker.launchImageLibraryAsync as jest.Mock
  const camera = ImagePicker.launchCameraAsync as jest.Mock
  const firstOptions = (mock: jest.Mock): Record<string, unknown> =>
    (mock.mock.calls as unknown[][])[0]?.[0] as Record<string, unknown>
  beforeEach(() => {
    launch.mockReset().mockResolvedValue({ canceled: true, assets: null })
    camera.mockReset().mockResolvedValue({ canceled: true, assets: null })
  })

  it('quality is below 1: that is what makes iOS re-encode HEIC to JPEG and bake the orientation', () => {
    expect(PICKER_QUALITY).toBeGreaterThan(0)
    expect(PICKER_QUALITY).toBeLessThan(1)
  })

  it.each(['library', 'camera'] as const)(
    '%s: no EXIF (GPS), no base64, no editing, images only',
    async (source) => {
      await createExpoPhotoPort().acquire(source)
      const options = firstOptions(source === 'library' ? launch : camera)
      expect(options).toMatchObject({
        mediaTypes: ['images'],
        exif: false,
        base64: false,
        allowsEditing: false,
        quality: PICKER_QUALITY,
      })
    },
  )

  it('the library path asks for one image and requests no photo-library permission (system picker)', async () => {
    await createExpoPhotoPort().acquire('library')
    expect(firstOptions(launch).allowsMultipleSelection).toBe(false)
    expect(ImagePicker.requestMediaLibraryPermissionsAsync).toBeUndefined()
  })
})

describe('the picker output the decoder will be handed', () => {
  it('HEIC / HEIF bytes are refused by the header check instead of reaching the native decoder', () => {
    // ISO-BMFF: 4-byte size, "ftyp", brand "heic".
    const heic = new Uint8Array([
      0,
      0,
      0,
      24,
      0x66,
      0x74,
      0x79,
      0x70,
      0x68,
      0x65,
      0x69,
      0x63,
      ...new Array<number>(20).fill(0),
    ])
    expect(sniffImageHeader(heic)).toBeNull()
  })
})

describe('isNativeReadableFileUri (iOS NSURL URLWithString: contract)', () => {
  it('accepts what expo-file-system and the picker produce', () => {
    expect(
      isNativeReadableFileUri(
        'file:///var/mobile/Containers/Data/Application/6F1E8C0A-1B2C-4D3E-8F90-123456789ABC/Library/Caches/ImagePicker/0B3A9E52-6A1D-4C0B-9F7A-5D7D2B7E4C11.jpg',
      ),
    ).toBe(true)
    expect(isNativeReadableFileUri('file:///data/user/0/app/cache/ImagePicker/a-b.jpg')).toBe(true)
    expect(isNativeReadableFileUri('file:///a/My%20Photo.jpg')).toBe(true)
  })
  it.each([
    ['a bare path', '/var/mobile/photo.jpg'],
    ['an Android content URI', 'content://media/external/images/media/1'],
    ['an unescaped space (a nil NSURL on iOS)', 'file:///a/My Photo.jpg'],
    ['a remote URL', 'https://example.invalid/photo.jpg'],
    ['a data URI', 'data:image/jpeg;base64,AAAA'],
    ['an asset-library URI', 'ph://ABC-123/L0/001'],
    ['file:// with a host part', 'file://host/a.jpg'],
    ['a query string', 'file:///a.jpg?x=1'],
    ['an empty string', ''],
  ])('refuses %s', (_label, uri) => {
    expect(isNativeReadableFileUri(uri)).toBe(false)
  })
  it('recognizeCardText checks the URI before the native call', () => {
    const text = readFileSync(join(appRoot, 'src/features/scanner-native/ocr-adapter.ts'), 'utf8')
    const body = text.slice(text.indexOf('export async function recognizeCardText'))
    expect(body.indexOf('isNativeReadableFileUri(imagePath)')).toBeGreaterThan(0)
    expect(body.indexOf('isNativeReadableFileUri(imagePath)')).toBeLessThan(
      body.indexOf('TextRecognition.recognize('),
    )
  })
})

describe('backend reachability from an iPhone', () => {
  const key = 'sb_publishable_' + 'x'.repeat(20)
  it('the simulator shares the host loopback: iOS leaves the URL alone (only Android is rewritten to 10.0.2.2)', () => {
    expect(resolvePlatformUrl('http://127.0.0.1:55321', 'ios', {})).toBe('http://127.0.0.1:55321')
    expect(resolvePlatformUrl('http://127.0.0.1:55321', 'android', {})).toBe(
      'http://10.0.2.2:55321',
    )
  })
  it('a physical iPhone can use the Mac LAN address (private ranges are allowed, public hosts are not)', () => {
    expect(
      loadBackendConfig({ url: 'http://192.168.1.20:55321', publishableKey: key }, 'ios').host,
    ).toBeTruthy()
    expect(() =>
      loadBackendConfig({ url: 'http://203.0.113.9:55321', publishableKey: key }, 'ios'),
    ).toThrow()
  })
})
