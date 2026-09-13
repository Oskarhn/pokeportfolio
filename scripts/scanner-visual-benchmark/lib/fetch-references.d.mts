export interface CorpusRow {
  cardId: string
  name: string
  localId: string
  setId: string
  setName: string
  language: string
  imageUrl: string
  imagePath: string
}
export const CACHE_DIR: string
export const IMAGES_DIR: string
export const CORPUS_MANIFEST: string
export function buildCorpus(options?: {
  maxPerSet?: number
  concurrency?: number
}): Promise<CorpusRow[]>
