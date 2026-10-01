// P186: the port starts the model while the person chooses a photo (scannerEntered) and shares ONE
// session with the recognition that follows. Collaborators are injected, so this checks the
// DECISIONS with the real pipeline; the adapter's own session cache is covered in
// p186-session-lifecycle.test.ts.
jest.mock('expo-file-system', () => ({ File: class {} }))
jest.mock('@shopify/react-native-skia/src/skia/NativeSetup', () => ({}))
jest.mock('@shopify/react-native-skia/src/skia/Skia', () => ({ Skia: {} }))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ImageFactory', () => ({
  AlphaType: { Unpremul: 3 },
}))
jest.mock('@shopify/react-native-skia/src/skia/types/Image/ColorType', () => ({
  ColorType: { RGBA_8888: 4 },
}))
jest.mock('@react-native-ml-kit/text-recognition', () => ({
  __esModule: true,
  default: { recognize: jest.fn() },
  TextRecognitionScript: { LATIN: 'latin' },
}))
jest.mock('onnxruntime-react-native', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class {},
}))
jest.mock('../../src/features/scanner-native/visual-adapter', () => ({
  getVisualSession: jest.fn(),
  visualSessionActiveCount: () => 1,
  visualSessionCreationCount: () => 1,
}))
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }))
jest.mock('expo-crypto', () => ({
  digest: jest.fn(),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}))

import { createNativeCardRecognitionPort } from '../../src/features/scanner-native/recognition-pipeline'
import type { RecognitionPipelineDeps } from '../../src/features/scanner-native/recognition-pipeline'
import type { VisualSession } from '../../src/features/scanner-native/visual-adapter'
import {
  resetScanTraceSink,
  setScanTraceSink,
  type NativeTraceEvent,
} from '../../src/features/scanner-native/scan-trace'
import { flush } from '../support/fakes'

afterEach(() => resetScanTraceSink())

const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x78, 0x03, 0xe8, 0x03, 0x01, 0x11, 0x00, 0x02,
  0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
])
const W = 160
const H = 224
const PIXELS = (() => {
  const out = new Uint8ClampedArray(W * H * 4)
  let seed = 7
  for (let i = 0; i < out.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const v = (seed >>> 24) & 0xff
    out[i] = v
    out[i + 1] = (v * 3) & 0xff
    out[i + 2] = (v * 7) & 0xff
    out[i + 3] = 255
  }
  return out
})()
const IMAGE = { uri: 'file:///cache/ImagePicker/a.jpg', width: 1000, height: 1400 }

const FAKE_SESSION: VisualSession = {
  embed: () => Promise.resolve(new Float32Array(1)),
  embedTimed: () => Promise.resolve({ vector: new Float32Array(1), preprocessMs: 1, onnxMs: 1 }),
  search: () => [],
  dispose: () => Promise.resolve(),
}

function setup(overrides: Partial<RecognitionPipelineDeps> = {}) {
  const created = { n: 0 }
  let cache: Promise<VisualSession> | null = null
  const deps: RecognitionPipelineDeps = {
    readFile: () => Promise.resolve({ size: JPEG.length, bytes: () => Promise.resolve(JPEG) }),
    decode: () => ({
      data: PIXELS,
      width: W,
      height: H,
      originalWidth: 1000,
      originalHeight: 1400,
      orientedWidth: 1000,
      orientedHeight: 1400,
    }),
    ocr: () =>
      Promise.resolve({
        fullText: '',
        rawNameText: null,
        rawCollectorNumberText: null,
        nameOcrConfidence: null,
        collectorOcrConfidence: null,
        slashTokens: [],
      }),
    // The same shape as the adapter's cache: one pending promise, created at most once.
    visualSession: () => {
      cache ??= (async () => {
        created.n += 1
        await Promise.resolve()
        return FAKE_SESSION
      })()
      return cache
    },
    retrieve: () => Promise.resolve([]),
    ...overrides,
  }
  const events: NativeTraceEvent[] = []
  setScanTraceSink((e) => events.push(e))
  const port = createNativeCardRecognitionPort(deps)
  return { port, created, events }
}

describe('scanner prewarm (P186)', () => {
  it('does nothing at construction: no model work (never at app launch)', async () => {
    const s = setup()
    // A real timer tick as well as microtasks: a prewarm scheduled with setTimeout(0) at construction
    // must not slip through.
    await flush(10)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(s.created.n).toBe(0)
    expect(s.events).toEqual([])
  })

  it('prewarms the session when the photo screen is entered, and reports how long it took', async () => {
    const s = setup()
    s.port.scannerEntered?.()
    await flush(5)
    expect(s.created.n).toBe(1)
    const ready = s.events.find((e) => e.kind === 'session' && e.action === 'prewarm_ready')
    expect(ready).toBeDefined()
    expect(ready?.kind === 'session' ? typeof ready.ms : null).toBe('number')
  })

  it('a photo chosen BEFORE the prewarm finished reuses the same session: one creation', async () => {
    const s = setup()
    s.port.scannerEntered?.()
    await s.port.recognize(IMAGE)
    expect(s.created.n).toBe(1)
  })

  it('entering the screen again does not create a second session', async () => {
    const s = setup()
    s.port.scannerEntered?.()
    s.port.scannerEntered?.()
    await flush(5)
    expect(s.created.n).toBe(1)
  })

  it('a failed prewarm is reported, not cached: the scan retries and still works', async () => {
    let attempts = 0
    const s = setup({
      visualSession: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve(FAKE_SESSION)
      },
    })
    s.port.scannerEntered?.()
    await flush(5)
    expect(s.events.some((e) => e.kind === 'session' && e.action === 'prewarm_failed')).toBe(true)
    const outcome = await s.port.recognize(IMAGE)
    expect(attempts).toBe(2)
    expect(outcome.status).not.toBe('error')
  })

  it('an identity reset cancels scans but neither creates nor drops a session', async () => {
    const s = setup()
    s.port.scannerEntered?.()
    await flush(5)
    s.port.reset?.()
    await flush(5)
    expect(s.created.n).toBe(1)
  })

  it('the model session stays loaded after the screen is left: the port has no unload path', () => {
    // Measured (docs/mobile/P186): an idle release returned 19 of 277 MB. If an unload is ever added
    // it needs its own measurement, tests and this assertion changed on purpose.
    const s = setup()
    expect(Object.keys(s.port).sort()).toEqual(
      ['cancelActive', 'implemented', 'recognize', 'reset', 'scannerEntered'].sort(),
    )
  })
})
