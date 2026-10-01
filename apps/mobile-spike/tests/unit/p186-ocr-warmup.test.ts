/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories require lazily. */
// P186: the OCR engine is started on a synthetic blank while the person chooses a photo. The blank
// must be a valid, text-free, card-free PNG; starting it must happen once per process, a failure
// must never fail the prewarm or a scan, and the only ML Kit script ever requested is LATIN (the
// non-Latin recognizers bundled by the wrapper are therefore unused: docs/mobile/P186 §ML Kit).
const mockRecognize = jest.fn()
const mockFiles: { created: string[]; written: Uint8Array[]; deleted: string[] } = {
  created: [],
  written: [],
  deleted: [],
}
jest.mock('@react-native-ml-kit/text-recognition', () => ({
  __esModule: true,
  default: { recognize: (...args: unknown[]): unknown => mockRecognize(...args) as unknown },
  TextRecognitionScript: { LATIN: 'latin', CHINESE: 'chinese' },
}))
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache/' },
  File: class {
    uri: string
    constructor(dir: string, name: string) {
      this.uri = `${dir}${name}`
    }
    create() {
      mockFiles.created.push(this.uri)
    }
    write(bytes: Uint8Array) {
      mockFiles.written.push(bytes)
    }
    delete() {
      mockFiles.deleted.push(this.uri)
    }
  },
}))
jest.mock('@shopify/react-native-skia/src/skia/NativeSetup', () => ({}))
jest.mock('@shopify/react-native-skia/src/skia/Skia', () => ({ Skia: {} }))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ImageFactory', () => ({
  AlphaType: { Unpremul: 3 },
}))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ColorType', () => ({
  ColorType: { RGBA_8888: 4 },
}))
jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class {},
}))
jest.mock('../../src/features/scanner-native/visual-adapter', () => ({
  getVisualSession: jest.fn(),
  releaseVisualSession: jest.fn(),
  visualSessionActiveCount: () => 0,
  visualSessionCreationCount: () => 0,
}))
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }))
jest.mock('expo-crypto', () => ({
  digest: jest.fn(),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))

import { inflateSync } from 'node:zlib'
import { warmOcr } from '../../src/features/scanner-native/ocr-adapter'
import { WARMUP_PNG } from '../../src/features/scanner-native/warmup-image'
import {
  createNativeCardRecognitionPort,
  type RecognitionPipelineDeps,
} from '../../src/features/scanner-native/recognition-pipeline'
import { flush } from '../support/fakes'

beforeEach(() => {
  mockRecognize.mockReset()
  mockFiles.created = []
  mockFiles.written = []
  mockFiles.deleted = []
})

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('the OCR warm-up image', () => {
  const view = new DataView(WARMUP_PNG.buffer, WARMUP_PNG.byteOffset, WARMUP_PNG.byteLength)

  it('is a valid PNG: signature, 64 x 64 8-bit grey, correct CRCs, IEND last', () => {
    expect([...WARMUP_PNG.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const chunks: { type: string; data: Uint8Array }[] = []
    let offset = 8
    while (offset < WARMUP_PNG.length) {
      const length = view.getUint32(offset)
      const type = String.fromCharCode(...WARMUP_PNG.slice(offset + 4, offset + 8))
      const data = WARMUP_PNG.slice(offset + 8, offset + 8 + length)
      const stored = view.getUint32(offset + 8 + length)
      expect(crc32(WARMUP_PNG.slice(offset + 4, offset + 8 + length))).toBe(stored)
      chunks.push({ type, data })
      offset += 12 + length
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const ihdr = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset, 13)
    expect(ihdr.getUint32(0)).toBe(64)
    expect(ihdr.getUint32(4)).toBe(64)
    expect(ihdr.getUint8(8)).toBe(8) // bit depth
    expect(ihdr.getUint8(9)).toBe(0) // greyscale
  })

  it('decodes to an entirely white image: no card, no text, nothing personal', () => {
    const idat = (() => {
      let offset = 8
      while (offset < WARMUP_PNG.length) {
        const length = view.getUint32(offset)
        const type = String.fromCharCode(...WARMUP_PNG.slice(offset + 4, offset + 8))
        if (type === 'IDAT') return WARMUP_PNG.slice(offset + 8, offset + 8 + length)
        offset += 12 + length
      }
      throw new Error('no IDAT')
    })()
    const raw = inflateSync(Buffer.from(idat))
    expect(raw.length).toBe(64 * 65)
    for (let row = 0; row < 64; row += 1) {
      expect(raw[row * 65]).toBe(0) // filter: none
      for (let x = 1; x <= 64; x += 1) expect(raw[row * 65 + x]).toBe(0xff)
    }
  })
})

describe('warmOcr', () => {
  it('recognises the blank with the LATIN script only; the only file it writes is the synthetic blank', async () => {
    mockRecognize.mockResolvedValue({ text: '', blocks: [] })
    await warmOcr()
    expect(mockRecognize).toHaveBeenCalledTimes(1)
    expect((mockRecognize.mock.calls[0] as unknown[] | undefined)?.[1]).toBe('latin')
    expect(mockFiles.written[0]).toBe(WARMUP_PNG)
    expect(mockFiles.created).toEqual(['file:///cache/ocr-warmup.png'])
    expect(mockFiles.written).toHaveLength(1)
  })

  it('lets an ML Kit failure reach the caller (the port ignores it)', async () => {
    mockRecognize.mockRejectedValue(new Error('boom'))
    await expect(warmOcr()).rejects.toThrow('boom')
  })

  it('requests only the LATIN script anywhere in the scanner sources (non-Latin recognizers unused)', () => {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dir = path.resolve(__dirname, '../../src')
    const hits: string[] = []
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8')
          for (const m of text.matchAll(/TextRecognitionScript\.([A-Z_]+)/g)) hits.push(m[1] ?? '')
        }
      }
    }
    walk(dir)
    expect(hits.length).toBeGreaterThan(0)
    expect(new Set(hits)).toEqual(new Set(['LATIN']))
  })
})

describe('OCR prewarm through the port', () => {
  function depsWith(warm: () => Promise<void>): RecognitionPipelineDeps {
    return {
      readFile: () => Promise.reject(new Error('unused')),
      decode: () => {
        throw new Error('unused')
      },
      ocr: () => Promise.reject(new Error('unused')),
      warmOcr: warm,
      visualSession: () =>
        Promise.resolve({
          embed: () => Promise.resolve(new Float32Array(1)),
          embedTimed: () =>
            Promise.resolve({ vector: new Float32Array(1), preprocessMs: 0, onnxMs: 0 }),
          search: () => [],
          dispose: () => Promise.resolve(),
        }),
      retrieve: () => Promise.resolve([]),
    }
  }

  it('starts the OCR engine once per process, however often the screen is entered', async () => {
    const warm = jest.fn(() => Promise.resolve())
    const port = createNativeCardRecognitionPort(depsWith(warm))
    port.scannerEntered?.()
    await flush(5)
    port.scannerEntered?.()
    await flush(5)
    expect(warm).toHaveBeenCalledTimes(1)
  })

  it('a failed OCR start does not fail the prewarm and is retried on the next entry', async () => {
    const warm = jest.fn().mockRejectedValueOnce(new Error('ml kit')).mockResolvedValue(undefined)
    const port = createNativeCardRecognitionPort(depsWith(warm))
    port.scannerEntered?.()
    await flush(5)
    port.scannerEntered?.()
    await flush(5)
    expect(warm).toHaveBeenCalledTimes(2)
  })
})

describe('decoder prewarm through the port', () => {
  function depsWithDecode(decode: jest.Mock): RecognitionPipelineDeps {
    return {
      readFile: () => Promise.reject(new Error('unused')),
      decode,
      ocr: () => Promise.reject(new Error('unused')),
      visualSession: () =>
        Promise.resolve({
          embed: () => Promise.resolve(new Float32Array(1)),
          embedTimed: () =>
            Promise.resolve({ vector: new Float32Array(1), preprocessMs: 0, onnxMs: 0 }),
          search: () => [],
          dispose: () => Promise.resolve(),
        }),
      retrieve: () => Promise.resolve([]),
    }
  }

  it('decodes the synthetic blank once per process, never a photo', async () => {
    const decode = jest.fn()
    const port = createNativeCardRecognitionPort(depsWithDecode(decode))
    port.scannerEntered?.()
    await flush(5)
    port.scannerEntered?.()
    await flush(5)
    expect(decode).toHaveBeenCalledTimes(1)
    expect((decode.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(WARMUP_PNG)
  })

  it('a decoder failure is ignored (and retried next entry), the prewarm still completes', async () => {
    const decode = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('skia')
      })
      .mockImplementation(() => undefined)
    const port = createNativeCardRecognitionPort(depsWithDecode(decode))
    port.scannerEntered?.()
    await flush(5)
    port.scannerEntered?.()
    await flush(5)
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('does not decode anything at construction (never at app launch)', async () => {
    const decode = jest.fn()
    createNativeCardRecognitionPort(depsWithDecode(decode))
    await flush(5)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(decode).not.toHaveBeenCalled()
  })
})
