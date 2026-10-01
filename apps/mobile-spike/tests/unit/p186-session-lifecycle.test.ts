/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily. */
import { INDEX_BYTES, MODEL_BYTES, MANIFEST, world } from '../support/p184-asset-world'
import { ctl, resetCtl } from '../support/p186-ort-control'

// P186: the model session is ONE per runtime. These tests run the REAL adapter (visual-adapter.ts)
// over a fake onnxruntime and assert what the prewarm depends on: a single creation for concurrent
// callers, at most one live session at any moment, a retry after a failed creation and an idempotent
// dispose. (There is no idle release: measured, it returned 19 of 277 MB; see docs/mobile/P186.)

jest.mock(
  '../../assets/scanner/visual-v1/index/manifest.json',
  () => ({
    __esModule: true,
    get default() {
      return (
        require('../support/p184-asset-world') as typeof import('../support/p184-asset-world')
      ).world.manifest
    },
  }),
  { virtual: true },
)
jest.mock(
  '../../assets/scanner/visual-v1/index/card-ids.json',
  () => ({ __esModule: true, default: [] }),
  { virtual: true },
)
jest.mock('../../assets/scanner/visual-v1/model/onnx/model_quantized.onnx', () => 1, {
  virtual: true,
})
jest.mock('../../assets/scanner/visual-v1/index/embeddings.bin', () => 2, { virtual: true })
jest.mock('expo-asset', () => ({
  Asset: {
    fromModule: (id: number) => ({
      localUri: null as string | null,
      downloadAsync() {
        this.localUri = id === 1 ? 'file:///cache/model.onnx' : 'file:///cache/embeddings.bin'
        return Promise.resolve()
      },
    }),
  },
}))
jest.mock('expo-file-system', () => {
  const { world: w } =
    require('../support/p184-asset-world') as typeof import('../support/p184-asset-world')
  return {
    File: class {
      uri: string
      constructor(uri: string) {
        this.uri = uri
      }
      bytes(): Promise<Uint8Array> {
        const found = w.files.get(this.uri)
        return found === undefined ? Promise.reject(new Error('missing')) : Promise.resolve(found)
      }
    },
  }
})
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (_a: string, bytes: Uint8Array): Promise<ArrayBuffer> => {
    const buffer = (require('node:crypto') as typeof import('node:crypto'))
      .createHash('sha256')
      .update(bytes)
      .digest()
    return Promise.resolve(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    )
  },
}))
jest.mock('onnxruntime-react-native', () => {
  const { ctl: c } =
    require('../support/p186-ort-control') as typeof import('../support/p186-ort-control')
  return {
    Tensor: class {},
    InferenceSession: {
      create: async () => {
        if (c.holdCreate !== null) await c.holdCreate
        c.created += 1
        const n = c.created
        c.alive += 1
        c.maxAlive = Math.max(c.maxAlive, c.alive)
        c.log.push(`create:${String(n)}`)
        return {
          inputNames: ['pixel_values'],
          outputNames: ['last_hidden_state'],
          run: () => Promise.resolve({ last_hidden_state: { data: new Float32Array(8) } }),
          release: async () => {
            if (c.holdRelease !== null) await c.holdRelease
            c.alive -= 1
            c.log.push(`release:${String(n)}`)
          },
        }
      },
    },
  }
})
jest.mock('@shared/data/scanner/visual-index', () => ({
  decodeVisualIndex: jest.fn(() => ({})),
  l2Normalize: (v: Float32Array) => v,
  searchVisualIndex: jest.fn(() => []),
}))

import { __resetScannerAssetsCacheForTests } from '../../src/features/scanner-native/model-assets'
import {
  __resetVisualSessionCacheForTests,
  getVisualSession,
  visualSessionActiveCount,
  visualSessionCreationCount,
} from '../../src/features/scanner-native/visual-adapter'
import {
  resetScanTraceSink,
  setScanTraceSink,
  type NativeTraceEvent,
} from '../../src/features/scanner-native/scan-trace'

beforeEach(() => {
  world.files = new Map([
    ['file:///cache/model.onnx', MODEL_BYTES],
    ['file:///cache/embeddings.bin', INDEX_BYTES],
  ])
  world.manifest = { ...MANIFEST }
  resetCtl()
  __resetScannerAssetsCacheForTests()
  __resetVisualSessionCacheForTests()
})

describe('model session lifecycle (P186)', () => {
  it('creates one session for any number of concurrent callers (prewarm + scan)', async () => {
    const [a, b, c] = await Promise.all([
      getVisualSession(),
      getVisualSession(),
      getVisualSession(),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(ctl.created).toBe(1)
    expect(visualSessionCreationCount()).toBe(1)
    expect(visualSessionActiveCount()).toBe(1)
  })

  it('later callers get the same cached session (no second creation after it exists)', async () => {
    const first = await getVisualSession()
    expect(await getVisualSession()).toBe(first)
    expect(ctl.created).toBe(1)
    expect(ctl.maxAlive).toBe(1)
  })

  it('a failed creation is not cached: the next caller retries', async () => {
    world.files.delete('file:///cache/model.onnx')
    await expect(getVisualSession()).rejects.toThrow()
    expect(ctl.created).toBe(0)
    world.files.set('file:///cache/model.onnx', MODEL_BYTES)
    await getVisualSession()
    expect(ctl.created).toBe(1)
  })

  it('dispose releases the runtime once, drops the cache entry and updates the active count', async () => {
    const first = await getVisualSession()
    await first.dispose()
    await first.dispose() // idempotent: the count never goes negative
    expect(ctl.log).toEqual(['create:1', 'release:1'])
    expect(visualSessionActiveCount()).toBe(0)
    const second = await getVisualSession()
    expect(second).not.toBe(first)
    expect(ctl.maxAlive).toBe(1)
  })

  it('reports how much of the creation was loading the verified assets', async () => {
    const events: NativeTraceEvent[] = []
    setScanTraceSink((e) => events.push(e))
    await getVisualSession()
    resetScanTraceSink()
    const created = events.find((e) => e.kind === 'session' && e.action === 'created')
    expect(created?.kind === 'session' ? created.assetsMs : undefined).toEqual(expect.any(Number))
    expect(created?.kind === 'session' ? created.active : undefined).toBe(1)
  })
})
