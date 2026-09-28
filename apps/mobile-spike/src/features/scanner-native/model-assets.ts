import { Asset } from 'expo-asset'
import * as Crypto from 'expo-crypto'
import { File } from 'expo-file-system'
import manifestJson from '../../../assets/scanner/visual-v1/index/manifest.json'
import cardIdsJson from '../../../assets/scanner/visual-v1/index/card-ids.json'
import type { VisualIndexManifest } from '@shared/data/scanner/visual-index'

// Metro resolves a require() of an asset-extension file (assetExts: onnx/bin — metro.config.js) to
// a numeric module id, not a JS value — there is no generated type for it, so the number type is
// asserted once here rather than left as `any` everywhere it is used below.
/* eslint-disable @typescript-eslint/no-require-imports -- Metro asset (assetExts: onnx/bin), not a JS module. */
const MODEL_ASSET_MODULE =
  require('../../../assets/scanner/visual-v1/model/onnx/model_quantized.onnx') as number
const EMBEDDINGS_ASSET_MODULE =
  require('../../../assets/scanner/visual-v1/index/embeddings.bin') as number
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Asset integrity (mission §11): no mutable "latest", fail closed on a hash mismatch, no network
 * download during an ordinary scan (both files are bundled INTO the APK via Metro's asset
 * pipeline at build time — `Asset.downloadAsync()` on a `require()`'d local asset copies it out of
 * the APK's own bundle into app storage, it does not fetch anything over the network). Verified
 * against `manifest.json`'s OWN pinned `modelSha256`/`embeddingsSha256` fields rather than a
 * second hardcoded copy of the same hashes, so there is exactly one place (the manifest this asset
 * generation actually shipped with) that has to stay in sync — see
 * `scripts/scanner-visual-index/lib/model-pin.mjs` for where those hashes were first verified
 * against the upstream Hugging Face repo (docs/mobile/P182_PORTABILITY_AUDIT.md).
 */
export class AssetIntegrityError extends Error {
  constructor(
    readonly asset: 'model' | 'index',
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(`${asset} asset hash mismatch: expected ${expectedSha256}, got ${actualSha256}.`)
    this.name = 'AssetIntegrityError'
  }
}

export interface ScannerAssets {
  readonly modelPath: string
  readonly manifest: VisualIndexManifest
  readonly cardIds: readonly string[]
  readonly embeddingsBytes: Int8Array
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function materializeLocalUri(assetModule: number): Promise<string> {
  const asset = Asset.fromModule(assetModule)
  await asset.downloadAsync()
  if (asset.localUri === null) {
    throw new Error('Bundled scanner asset has no local URI after downloadAsync().')
  }
  return asset.localUri
}

let cached: Promise<ScannerAssets> | null = null

/** Loads and verifies both assets once per process; every later call returns the same cached,
 *  already-verified result (no repeated hashing on every scan). An integrity failure stays cached
 *  (fail closed: nothing else is tried in its place); any other failure (an I/O error while
 *  materializing the bundled asset) is dropped so the next scan can try again. */
export function loadScannerAssets(): Promise<ScannerAssets> {
  if (cached !== null) return cached
  const pending = loadScannerAssetsUncached()
  cached = pending
  pending.catch((error: unknown) => {
    if (!(error instanceof AssetIntegrityError) && cached === pending) cached = null
  })
  return pending
}

async function loadScannerAssetsUncached(): Promise<ScannerAssets> {
  const manifest = manifestJson as VisualIndexManifest
  const cardIds = cardIdsJson as readonly string[]

  const modelLocalUri = await materializeLocalUri(MODEL_ASSET_MODULE)
  const modelFile = new File(modelLocalUri)
  const modelBytes = await modelFile.bytes()
  const modelSha = await sha256Hex(modelBytes)
  if (modelSha !== manifest.modelSha256) {
    throw new AssetIntegrityError('model', manifest.modelSha256, modelSha)
  }

  const embeddingsLocalUri = await materializeLocalUri(EMBEDDINGS_ASSET_MODULE)
  const embeddingsFile = new File(embeddingsLocalUri)
  const embeddingsBytesU8 = await embeddingsFile.bytes()
  const embeddingsSha = await sha256Hex(embeddingsBytesU8)
  if (embeddingsSha !== manifest.embeddingsSha256) {
    throw new AssetIntegrityError('index', manifest.embeddingsSha256, embeddingsSha)
  }

  return {
    modelPath: modelLocalUri,
    manifest,
    cardIds,
    embeddingsBytes: new Int8Array(
      embeddingsBytesU8.buffer,
      embeddingsBytesU8.byteOffset,
      embeddingsBytesU8.byteLength,
    ),
  }
}

/** Test-only: clears the module-level cache between unit tests. */
export function __resetScannerAssetsCacheForTests(): void {
  cached = null
}
