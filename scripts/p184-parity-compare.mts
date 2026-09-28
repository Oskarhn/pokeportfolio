/**
 * Joins the device scenario evaluation (.build/p184-evidence/scenario-eval.json, produced by
 * scripts/p184/scenario-eval.mjs from the release APK) with the web-logic run
 * (scripts/p184-parity-web.mts) over the SAME images and reports, per image and in total:
 * top-1 agreement, top-5 overlap, confidence-class agreement, collector-number interpretation
 * agreement, and DANGEROUS divergences (native more confident than web where it matters).
 *
 *   pnpm exec tsx scripts/p184-parity-compare.mts <scenario-eval.json> <parity-web.json> <out.json>
 *
 * Similarity floats are not compared: only ordering, bands and interpretation.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { parseCollectorNumberStructured } from '../src/domain/scanner/collector-parse'

interface DeviceResult {
  id: string
  tier: string
  trace: {
    ocr: { name: string | null; number: string | null } | null
    topCandidateIds: string[]
    preselectedId: string | null
    visualTop: { cardId: string; similarity: number }[]
  }
  highShown: boolean
}
interface WebResult {
  file: string
  ocr: { name: string | null; number: string | null }
  tier: string
  topCandidateIds: string[]
  visualTop: { cardId: string; similarity: number }[]
}

const [evalFile, webFile, outFile] = process.argv.slice(2)
if (!evalFile || !webFile || !outFile) throw new Error('usage: <scenario-eval.json> <parity-web.json> <out.json>')
const device = (JSON.parse(readFileSync(evalFile, 'utf8')) as { results: DeviceResult[] }).results
const web = JSON.parse(readFileSync(webFile, 'utf8')) as WebResult[]
const RANK: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, NO_MATCH: 0, ABSTAIN: 0 }

function interpretNumber(text: string | null): string | null {
  if (text === null) return null
  const parsed = parseCollectorNumberStructured(text)
  if (parsed === null) return null
  return `${parsed.prefix}|${String(parsed.numeric)}|${parsed.suffix}|${String(parsed.total)}`
}

const rows = device.map((d) => {
  const w = web.find((x) => x.file === `${d.id}.jpg`)
  if (w === undefined) return { id: d.id, missing: true }
  const dTop = d.trace.topCandidateIds
  const wTop = w.topCandidateIds
  const overlap = dTop.length === 0 && wTop.length === 0 ? 1 : dTop.filter((id) => wTop.includes(id)).length / Math.max(1, Math.min(5, Math.max(dTop.length, wTop.length)))
  const dNum = interpretNumber(d.trace.ocr?.number ?? null)
  const wNum = interpretNumber(w.ocr.number)
  const dangerous: string[] = []
  const dRank = RANK[d.tier] ?? 0
  const wRank = RANK[w.tier] ?? 0
  if (d.tier === 'HIGH' && wRank < RANK.MEDIUM!) dangerous.push(`native HIGH while web ${w.tier}`)
  if (d.tier === 'HIGH' && w.tier === 'HIGH' && dTop[0] !== wTop[0]) dangerous.push('both HIGH but different top-1')
  if (d.trace.preselectedId !== null && wTop[0] !== undefined && d.trace.preselectedId !== wTop[0] && w.tier !== 'NO_MATCH') dangerous.push('native pre-selects a card the web scanner ranks below top-1')
  return {
    id: d.id,
    deviceTier: d.tier,
    webTier: w.tier,
    top1Same: dTop[0] === wTop[0],
    top5Overlap: Math.round(overlap * 100) / 100,
    tierSame: d.tier === w.tier || (d.tier === 'ABSTAIN' && w.tier === 'NO_MATCH'),
    nativeMoreConfident: dRank > wRank,
    deviceOcr: d.trace.ocr,
    webOcr: w.ocr,
    numberInterpretationSame: dNum === wNum,
    deviceNumber: dNum,
    webNumber: wNum,
    deviceVisualTop1: d.trace.visualTop[0]?.cardId?.slice(0, 8) ?? null,
    webVisualTop1: w.visualTop[0]?.cardId?.slice(0, 8) ?? null,
    visualTop1Same: d.trace.visualTop[0]?.cardId === w.visualTop[0]?.cardId,
    dangerous,
  }
})
const compared = rows.filter((r) => !('missing' in r)) as Exclude<(typeof rows)[number], { missing: true }>[]
const summary = {
  images: compared.length,
  top1Same: compared.filter((r) => r.top1Same).length,
  tierSame: compared.filter((r) => r.tierSame).length,
  nativeMoreConfident: compared.filter((r) => r.nativeMoreConfident).length,
  numberInterpretationSame: compared.filter((r) => r.numberInterpretationSame).length,
  visualTop1Same: compared.filter((r) => r.visualTop1Same).length,
  avgTop5Overlap: Math.round((compared.reduce((a, r) => a + r.top5Overlap, 0) / Math.max(1, compared.length)) * 100) / 100,
  dangerousDivergences: compared.filter((r) => r.dangerous.length > 0).length,
}
writeFileSync(outFile, `${JSON.stringify({ summary, rows }, null, 2)}\n`)
for (const r of compared) {
  console.log(`${r.id.padEnd(24)} dev=${String(r.deviceTier).padEnd(8)} web=${String(r.webTier).padEnd(8)} top1=${String(r.top1Same).padEnd(5)} top5=${r.top5Overlap} num=${String(r.numberInterpretationSame).padEnd(5)} vis1=${String(r.visualTop1Same).padEnd(5)} ${r.dangerous.join('; ')}`)
}
console.log(JSON.stringify(summary))
