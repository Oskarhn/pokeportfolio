#!/usr/bin/env node
/**
 * P186 package inventory: lists the contents of an APK or AAB (both are ZIP files) with compressed
 * and uncompressed bytes and groups them into the components the packaging decisions are about.
 * Pure Node (no unzip dependency): reads the ZIP central directory itself.
 *
 *   node scripts/p186/package-inventory.mjs <file.apk|file.aab> [--json out.json] [--top 25]
 *   node scripts/p186/package-inventory.mjs --check-abis arm64-v8a,x86_64 <file.aab>
 *
 * `--check-abis` exits non-zero unless every listed ABI has native libraries in the package and no
 * other ABI does (the static packaging gate; it proves what is PACKAGED, never that it RUNS).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'

export function readZipEntries(buffer) {
  // End Of Central Directory record: scan backwards for the signature 0x06054b50.
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('not a ZIP file (no end-of-central-directory record)')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory')
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const uncompressed = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localOffset = buffer.readUInt32LE(offset + 42)
    entries.push({ name, method, compressed, uncompressed, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The uncompressed bytes of one entry (stored or deflated). */
export function readEntry(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26)
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28)
  const start = entry.localOffset + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressed)
  return entry.method === 0 ? raw : inflateRawSync(raw)
}

const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']

/** Which package component an entry belongs to. Order matters: the first matching rule wins. */
export function classify(name) {
  // AGP's native symbol tables: uploaded to Play for crash symbolication, never delivered to a device.
  if (name.startsWith('BUNDLE-METADATA/com.android.tools.build.debugsymbols/'))
    return 'Native symbol tables (Play-only, not delivered)'
  const lib = /(?:^|\/)lib\/([^/]+)\/([^/]+)$/.exec(name)
  if (lib !== null) {
    const file = lib[2]
    if (/^libonnxruntime/.test(file)) return 'ONNX Runtime (native)'
    if (/skia|^libreact-native-skia|^libskia/i.test(file)) return 'Skia (native)'
    if (/mlkit|ocr|tflite|tensorflow/i.test(file)) return 'ML Kit OCR (native)'
    if (/^libhermes/.test(file)) return 'Hermes (native)'
    if (
      /^lib(reactnative|jsi|fbjni|react_|rrc_|turbomodule|yoga|fabric|folly|glog|runtimeexecutor|c\+\+_shared|mapbufferjni|react)/.test(
        file,
      ) ||
      file === 'libappmodules.so'
    )
      return 'React Native core (native)'
    return 'Other native'
  }
  if (/(?:^|\/)dex\/[^/]+\.dex$|^classes\d*\.dex$/.test(name)) return 'DEX (Java/Kotlin code)'
  if (/\.onnx$/.test(name) || /model_quantized/.test(name))
    return 'Scanner model (DINOv2 int8 ONNX)'
  if (/embeddings.*\.bin$|visual_v1_index_embeddings/.test(name))
    return 'Scanner visual index (embeddings)'
  if (
    /card_ids|card-ids|visual_v1_index_manifest|manifest.*\.json$/i.test(name) &&
    /visual|scanner/i.test(name)
  )
    return 'Scanner index metadata'
  if (/mlkit|ocr/i.test(name) && /(assets|raw)\//.test(name)) return 'ML Kit OCR (models/assets)'
  if (/index\.android\.bundle|\.hbc$/.test(name)) return 'JS bundle (Hermes bytecode)'
  if (/resources\.(arsc|pb)$/.test(name)) return 'Resource table'
  if (/(^|\/)res\//.test(name)) return 'Android resources'
  if (/(^|\/)assets\//.test(name)) return 'Other assets'
  if (/AndroidManifest\.xml$/.test(name)) return 'Manifest'
  if (/^META-INF\//.test(name) || /^BUNDLE-METADATA\//.test(name) || /BundleConfig\.pb$/.test(name))
    return 'Signing / bundle metadata'
  return 'Other'
}

export function abiOf(name) {
  const m = /(?:^|\/)lib\/([^/]+)\//.exec(name)
  return m !== null && ABIS.includes(m[1]) ? m[1] : null
}

export function summarise(entries) {
  const groups = new Map()
  const perAbi = new Map()
  for (const e of entries) {
    if (e.name.endsWith('/')) continue
    const key = classify(e.name)
    const g = groups.get(key) ?? {
      component: key,
      files: 0,
      compressed: 0,
      uncompressed: 0,
      abis: new Set(),
    }
    g.files += 1
    g.compressed += e.compressed
    g.uncompressed += e.uncompressed
    const abi = abiOf(e.name)
    if (abi !== null) {
      g.abis.add(abi)
      const a = perAbi.get(abi) ?? { abi, files: 0, compressed: 0, uncompressed: 0 }
      a.files += 1
      a.compressed += e.compressed
      a.uncompressed += e.uncompressed
      perAbi.set(abi, a)
    }
    groups.set(key, g)
  }
  return {
    components: [...groups.values()]
      .map((g) => ({ ...g, abis: [...g.abis].sort() }))
      .sort((a, b) => b.compressed - a.compressed),
    perAbi: [...perAbi.values()].sort((a, b) => b.compressed - a.compressed),
  }
}

/** Entries a device with exactly this ABI would be sent (AAB: base module minus other ABIs' libs and Play-only metadata). */
export function deliveredTo(entries, abi) {
  return entries.filter((e) => {
    if (e.name.endsWith('/')) return false
    if (e.name.startsWith('BUNDLE-METADATA/')) return false
    const own = abiOf(e.name)
    return own === null || own === abi
  })
}

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`

if (
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('package-inventory.mjs')
) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const i = args.indexOf(name)
    return i === -1 ? null : args[i + 1]
  }
  const file = args.find(
    (a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')),
  )
  if (file === undefined)
    throw new Error('usage: package-inventory.mjs <file> [--json out] [--check-abis a,b]')
  const buffer = readFileSync(file)
  const entries = readZipEntries(buffer)
  const summary = summarise(entries)
  const result = {
    file,
    bytes: buffer.length,
    entries: entries.length,
    ...summary,
    top: entries
      .filter((e) => !e.name.endsWith('/'))
      .sort((a, b) => b.compressed - a.compressed)
      .slice(0, Number(flag('--top') ?? 25))
      .map((e) => ({
        name: e.name,
        compressed: e.compressed,
        uncompressed: e.uncompressed,
        stored: e.method === 0,
      })),
  }
  const out = flag('--json')
  if (out !== null) writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(`${file}: ${buffer.length} bytes, ${entries.length} entries`)
  for (const c of summary.components)
    console.log(
      `${c.component.padEnd(38)} ${mb(c.compressed).padStart(10)} compressed ${mb(c.uncompressed).padStart(10)} raw  ${c.files} files ${c.abis.join(',')}`,
    )
  console.log('--- per ABI (native libraries)')
  for (const a of summary.perAbi)
    console.log(
      `${a.abi.padEnd(14)} ${mb(a.compressed).padStart(10)} compressed ${mb(a.uncompressed).padStart(10)} raw  ${a.files} libs`,
    )
  const delivered = flag('--delivered')
  if (delivered !== null) {
    const subset = deliveredTo(entries, delivered)
    const sum = summarise(subset)
    const total = subset.reduce((a, e) => a + e.compressed, 0)
    console.log(
      `--- delivered to a ${delivered} device (compressed, base module only): ${mb(total)}`,
    )
    for (const c of sum.components)
      console.log(
        `${c.component.padEnd(46)} ${mb(c.compressed).padStart(10)} compressed ${mb(c.uncompressed).padStart(10)} raw`,
      )
    result.delivered = { abi: delivered, compressedBytes: total, components: sum.components }
    if (out !== null) writeFileSync(out, JSON.stringify(result, null, 2))
  }
  const wanted = flag('--check-abis')
  if (wanted !== null) {
    const want = wanted.split(',').sort()
    const have = summary.perAbi.map((a) => a.abi).sort()
    const ok = JSON.stringify(want) === JSON.stringify(have)
    console.log(`ABI gate: want [${want}] have [${have}] -> ${ok ? 'PASS' : 'FAIL'}`)
    process.exit(ok ? 0 : 1)
  }
}
