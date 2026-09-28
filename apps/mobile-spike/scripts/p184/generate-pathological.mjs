#!/usr/bin/env node
/**
 * Generates the P184 pathological-image set (image-safety gate): files that must be refused
 * quickly and safely by the native scanner, before any decode/OCR/model work. Nothing here is a
 * real photo; every file is produced from code. Output is NOT committed (some files are
 * megabytes): pass an output directory, default `<repo>/.p184-scratch/pathological`.
 *
 *   node scripts/p184/generate-pathological.mjs [outDir]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..', '..')
const repoRoot = resolve(appRoot, '..', '..')
const outDir = resolve(process.argv[2] ?? join(repoRoot, '.p184-scratch', 'pathological'))
mkdirSync(outDir, { recursive: true })
const requireFromRoot = createRequire(join(repoRoot, 'package.json'))
const sharp = requireFromRoot('sharp')
const sample = readFileSync(join(appRoot, 'tests', 'fixtures', 'scanner-p184', 'f01-clean.jpg'))

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, data, tail])
}

/** A genuine, decodable PNG whose declared size is enormous and whose pixel data is all zero, so
 *  it deflates to a few tens of KB: a compressed pixel bomb. 1 bit per pixel keeps the RAW size
 *  small enough to build here (20000 x 20000 = 50 MB) while the decoded RGBA would be 1.6 GB. */
function pixelBombPng(width, height) {
  const rowBytes = Math.ceil(width / 8) + 1
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // grayscale
  const row = Buffer.alloc(rowBytes)
  const block = 512
  const chunks = []
  const { createDeflate } = requireFromRoot('node:zlib')
  const deflate = createDeflate({ level: 9 })
  deflate.on('data', (d) => chunks.push(d))
  const blockBuf = Buffer.concat(Array.from({ length: block }, () => row))
  return new Promise((resolveP, reject) => {
    deflate.on('error', reject)
    deflate.on('end', () => {
      resolveP(
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          pngChunk('IHDR', ihdr),
          pngChunk('IDAT', Buffer.concat(chunks)),
          pngChunk('IEND', Buffer.alloc(0)),
        ]),
      )
    })
    for (let y = 0; y < height; y += block)
      deflate.write(blockBuf.subarray(0, Math.min(block, height - y) * rowBytes))
    deflate.end()
  })
}

function patchJpegDimensions(jpeg, width, height) {
  const out = Buffer.from(jpeg)
  for (let i = 2; i + 9 < out.length;) {
    if (out[i] !== 0xff) break
    const marker = out[i + 1]
    const len = out.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      out.writeUInt16BE(height, i + 5)
      out.writeUInt16BE(width, i + 7)
      return out
    }
    i += 2 + len
  }
  throw new Error('no SOF marker in the sample JPEG')
}

const files = {}

files['p01-pixel-bomb-png-20000x20000.png'] = await pixelBombPng(20000, 20000)
files['p02-huge-jpeg-12000x12000.jpg'] = await sharp({
  create: { width: 12000, height: 12000, channels: 3, background: '#7a5c2e' },
})
  .jpeg({ quality: 40 })
  .toBuffer()
files['p03-declared-huge-jpeg-30000x30000.jpg'] = patchJpegDimensions(sample, 30000, 30000)
files['p04-zero-dimension.jpg'] = patchJpegDimensions(sample, 0, 0)
files['p05-truncated-jpeg.jpg'] = sample.subarray(0, Math.floor(sample.length * 0.4))
{
  const png = await sharp(join(appRoot, 'tests', 'fixtures', 'scanner-p184', 'f01-clean.jpg'))
    .resize(600, 800)
    .png()
    .toBuffer()
  const bad = Buffer.from(png)
  for (let i = Math.floor(bad.length / 2); i < Math.floor(bad.length / 2) + 64; i += 1)
    bad[i] ^= 0xff
  files['p06-corrupt-png.png'] = bad
}
files['p07-extreme-aspect-4000x120.jpg'] = await sharp({
  create: { width: 4000, height: 120, channels: 3, background: '#335577' },
})
  .jpeg()
  .toBuffer()
files['p08-not-an-image.jpg'] = Buffer.from(
  'This is plain text with a .jpg extension, not an image.\n'.repeat(40),
)
files['p09-pdf-as-jpg.jpg'] = Buffer.from(
  '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'.repeat(20),
)
files['p10-tiny-20x20.jpg'] = await sharp({
  create: { width: 20, height: 20, channels: 3, background: '#aa3366' },
})
  .jpeg()
  .toBuffer()
{
  // > 10 MB, structurally valid, mostly incompressible noise.
  const width = 3200
  const height = 2400
  const noise = Buffer.alloc(width * height * 3)
  let s = 42
  for (let i = 0; i < noise.length; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    noise[i] = s >>> 24
  }
  files['p11-oversize-file-over-10MB.jpg'] = await sharp(noise, {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer()
}
files['p12-svg-as-jpg.jpg'] = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="99999" height="99999"><rect width="1" height="1"/></svg>',
)
files['p13-empty.jpg'] = Buffer.alloc(0)

const summary = []
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(outDir, name), bytes)
  summary.push({ name, bytes: bytes.length })
}
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(summary, null, 2)}\n`)
for (const s of summary) console.log(`${String(s.bytes).padStart(10)}  ${s.name}`)
