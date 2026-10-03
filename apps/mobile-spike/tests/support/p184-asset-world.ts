import { createHash } from 'node:crypto'

/** Shared state for the P184 asset-integrity test's module mocks (kept in a support module so the
 *  hoisted jest.mock factories can require it lazily instead of touching a not-yet-initialised
 *  top-level binding). */
export const MODEL_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 251))
export const INDEX_BYTES = new Uint8Array(Array.from({ length: 96 }, (_, i) => (i * 13 + 5) % 251))
export const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export const MANIFEST = {
  version: 'visual-v1',
  modelId: 'test/model',
  modelRevision: 'rev',
  modelSha256: sha(MODEL_BYTES),
  embeddingDim: 4,
  quantization: 'int8',
  cardCount: 24,
  embeddingsSha256: sha(INDEX_BYTES),
}

export const world: {
  files: Map<string, Uint8Array>
  manifest: typeof MANIFEST
  ioFailuresLeft: number
  createCalls: number
  released: number
} = { files: new Map(), manifest: MANIFEST, ioFailuresLeft: 0, createCalls: 0, released: 0 }
