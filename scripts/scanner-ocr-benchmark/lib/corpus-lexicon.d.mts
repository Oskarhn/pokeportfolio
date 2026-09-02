export interface OcrCorpusRow {
  cardId: string
  name: string
  localId: string
  setId: string
  setName: string
  language: string
  imagePath: string
}
export function loadOcrCorpus(options?: { maxPerSet?: number }): Promise<OcrCorpusRow[]>
