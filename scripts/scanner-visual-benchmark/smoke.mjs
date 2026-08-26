import { buildCorpus } from './lib/fetch-references.mjs'
import { augmentAll } from './lib/augment.mjs'
import { embedImageBuffer, warmUpModel } from './lib/embed.mjs'
import { ocrFullFrame, disposeOcr } from './lib/ocr.mjs'
import { readFile } from 'node:fs/promises'

const corpus = await buildCorpus({ maxPerSet: 3 })
console.log('corpus size', corpus.length)
await warmUpModel()

const sample = corpus[0]
const buf = await readFile(sample.imagePath)
const refEmbed = await embedImageBuffer(buf)
console.log('ref embed dim', refEmbed.length, 'name', sample.name)

const augmented = await augmentAll(buf, sample.cardId)
console.log(
  'augmentations',
  augmented.map((a) => a.profile),
)

for (const aug of augmented.slice(0, 2)) {
  const emb = await embedImageBuffer(aug.buffer)
  let dot = 0
  for (let i = 0; i < emb.length; i++) dot += emb[i] * refEmbed[i]
  const ocr = await ocrFullFrame(aug.buffer)
  console.log(aug.profile, 'sim=', dot.toFixed(3), 'ocr=', JSON.stringify(ocr.text.slice(0, 40)))
}
await disposeOcr()
