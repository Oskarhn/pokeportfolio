/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/require-await -- jest.mock factories must require lazily; the Asset mock is async by contract. */
import { INDEX_BYTES, MODEL_BYTES, MANIFEST, sha, world } from '../support/p184-asset-world'

// Asset integrity and model-session lifecycle (P184). The bundled model and index are verified
// against the SHA-256 pinned in the index manifest; every mutation below must make the scanner
// REFUSE to initialise, and nothing may fall back to an unverified asset.
//
// The bundled files are gitignored build artefacts (apps/mobile-spike/assets/scanner, staged by
// `pnpm assets:scanner`), so they are replaced here by virtual modules: the test needs their
// integrity LOGIC, not the 24 MB model.

jest.mock(
  '../../assets/scanner/visual-v1/index/manifest.json',
  () => ({
    __esModule: true,
    // A getter, so a test that edits world.manifest before loading sees the edited manifest.
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
  {
    virtual: true,
  },
)
jest.mock('../../assets/scanner/visual-v1/model/onnx/model_quantized.onnx', () => 1, {
  virtual: true,
})
jest.mock('../../assets/scanner/visual-v1/index/embeddings.bin', () => 2, { virtual: true })

jest.mock('expo-asset', () => {
  const { world } =
    require('../support/p184-asset-world') as typeof import('../support/p184-asset-world')
  return {
    Asset: {
      fromModule: (id: number) => ({
        localUri: null as string | null,
        async downloadAsync() {
          if (world.ioFailuresLeft > 0) {
            world.ioFailuresLeft -= 1
            throw new Error('transient I/O failure')
          }
          this.localUri = id === 1 ? 'file:///cache/model.onnx' : 'file:///cache/embeddings.bin'
        },
      }),
    },
  }
})
jest.mock('expo-file-system', () => {
  const { world } =
    require('../support/p184-asset-world') as typeof import('../support/p184-asset-world')
  return {
    File: class {
      uri: string
      constructor(uri: string) {
        this.uri = uri
      }
      bytes(): Promise<Uint8Array> {
        const found = world.files.get(this.uri)
        if (found === undefined) return Promise.reject(new Error(`missing ${this.uri}`))
        return Promise.resolve(found)
      }
    },
  }
})
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (_algorithm: string, bytes: Uint8Array): Promise<ArrayBuffer> => {
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
  const { world } =
    require('../support/p184-asset-world') as typeof import('../support/p184-asset-world')
  return {
    Tensor: class {},
    InferenceSession: {
      create: jest.fn(() => {
        world.createCalls += 1
        return Promise.resolve({
          inputNames: ['pixel_values'],
          outputNames: ['last_hidden_state'],
          run: () => Promise.resolve({ last_hidden_state: { data: new Float32Array(8) } }),
          release: () => {
            world.released += 1
            return Promise.resolve()
          },
        })
      }),
    },
  }
})
jest.mock('@shared/data/scanner/visual-index', () => ({
  decodeVisualIndex: jest.fn(() => ({})),
  l2Normalize: (v: Float32Array) => v,
  searchVisualIndex: jest.fn(() => []),
}))

import {
  AssetIntegrityError,
  __resetScannerAssetsCacheForTests,
  loadScannerAssets,
} from '../../src/features/scanner-native/model-assets'
import {
  __resetVisualSessionCacheForTests,
  getVisualSession,
  visualSessionCreationCount,
} from '../../src/features/scanner-native/visual-adapter'

function freshWorld(overrides: { model?: Uint8Array; index?: Uint8Array } = {}): void {
  world.files = new Map([
    ['file:///cache/model.onnx', overrides.model ?? MODEL_BYTES],
    ['file:///cache/embeddings.bin', overrides.index ?? INDEX_BYTES],
  ])
  world.manifest = { ...MANIFEST }
  world.ioFailuresLeft = 0
  world.createCalls = 0
  world.released = 0
  __resetScannerAssetsCacheForTests()
  __resetVisualSessionCacheForTests()
}

beforeEach(() => freshWorld())

const flipByte = (bytes: Uint8Array, at: number): Uint8Array => {
  const copy = new Uint8Array(bytes)
  copy[at] = (copy[at] ?? 0) ^ 0x01
  return copy
}

describe('asset integrity: mutate each asset, the scanner refuses to initialise', () => {
  it('pristine assets verify and load', async () => {
    const assets = await loadScannerAssets()
    expect(assets.manifest.modelSha256).toBe(sha(MODEL_BYTES))
    expect(assets.embeddingsBytes.byteLength).toBe(INDEX_BYTES.byteLength)
  })

  it('a single flipped byte in the MODEL is refused', async () => {
    freshWorld({ model: flipByte(MODEL_BYTES, 10) })
    await expect(loadScannerAssets()).rejects.toMatchObject({
      name: 'AssetIntegrityError',
      asset: 'model',
    })
  })

  it('a single flipped byte in the INDEX is refused', async () => {
    freshWorld({ index: flipByte(INDEX_BYTES, 40) })
    await expect(loadScannerAssets()).rejects.toMatchObject({
      name: 'AssetIntegrityError',
      asset: 'index',
    })
  })

  it('a tampered manifest hash for the model is refused', async () => {
    freshWorld()
    world.manifest = { ...MANIFEST, modelSha256: '0'.repeat(64) }
    await expect(loadScannerAssets()).rejects.toBeInstanceOf(AssetIntegrityError)
  })

  it('a tampered manifest hash for the index is refused', async () => {
    freshWorld()
    world.manifest = { ...MANIFEST, embeddingsSha256: 'f'.repeat(64) }
    await expect(loadScannerAssets()).rejects.toMatchObject({ asset: 'index' })
  })

  it('a truncated model is refused', async () => {
    freshWorld({ model: MODEL_BYTES.slice(0, 30) })
    await expect(loadScannerAssets()).rejects.toBeInstanceOf(AssetIntegrityError)
  })

  it('an empty index is refused', async () => {
    freshWorld({ index: new Uint8Array(0) })
    await expect(loadScannerAssets()).rejects.toBeInstanceOf(AssetIntegrityError)
  })
})

describe('no fallback to an unverified asset', () => {
  it('a model mutation means NO inference session is ever created, on this or any later scan', async () => {
    freshWorld({ model: flipByte(MODEL_BYTES, 3) })
    await expect(getVisualSession()).rejects.toBeInstanceOf(AssetIntegrityError)
    await expect(getVisualSession()).rejects.toBeInstanceOf(AssetIntegrityError)
    await expect(getVisualSession()).rejects.toBeInstanceOf(AssetIntegrityError)
    expect(world.createCalls).toBe(0)
    expect(visualSessionCreationCount()).toBe(0)
  })

  it('an integrity failure is sticky: putting good bytes back does not un-refuse within the process', async () => {
    freshWorld({ index: flipByte(INDEX_BYTES, 1) })
    await expect(getVisualSession()).rejects.toBeInstanceOf(AssetIntegrityError)
    world.files.set('file:///cache/embeddings.bin', INDEX_BYTES)
    await expect(getVisualSession()).rejects.toBeInstanceOf(AssetIntegrityError)
    expect(world.createCalls).toBe(0)
  })

  it('a TRANSIENT I/O failure is not cached: the next scan can initialise', async () => {
    freshWorld()
    world.ioFailuresLeft = 1
    await expect(getVisualSession()).rejects.toThrow('transient I/O failure')
    const session = await getVisualSession()
    expect(session).toBeDefined()
    expect(world.createCalls).toBe(1)
  })
})

describe('one model session per JS runtime', () => {
  it('many scans and concurrent first scans create exactly one session', async () => {
    const sessions = await Promise.all([1, 2, 3, 4, 5].map(() => getVisualSession()))
    await getVisualSession()
    expect(new Set(sessions).size).toBe(1)
    expect(world.createCalls).toBe(1)
    expect(visualSessionCreationCount()).toBe(1)
  })

  it('a disposed session is released once and replaced, never reused', async () => {
    const first = await getVisualSession()
    await first.dispose()
    expect(world.released).toBe(1)
    const second = await getVisualSession()
    expect(second).not.toBe(first)
    expect(world.createCalls).toBe(2)
  })

  it('embedTimed reports a preprocess/ONNX split and embed() is the same vector', async () => {
    const session = await getVisualSession()
    const image = { data: new Uint8ClampedArray(4), width: 1, height: 1 }
    // The preprocess step needs real pixels; a 1x1 image is enough for the timing contract.
    const timed = await session.embedTimed({
      ...image,
      width: 224,
      height: 224,
      data: new Uint8ClampedArray(224 * 224 * 4),
    })
    expect(timed.preprocessMs).toBeGreaterThanOrEqual(0)
    expect(timed.onnxMs).toBeGreaterThanOrEqual(0)
  })
})
