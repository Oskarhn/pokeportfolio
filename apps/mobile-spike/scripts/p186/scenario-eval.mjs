import './env.mjs'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { amStart } from '../android-p167-lib.mjs'
import {
  appRoot,
  clearLog,
  ensureSignedIn,
  fixtureDir,
  fixtureManifest,
  proxy,
  saveJson,
  scanFixture,
  shot,
  stripNodes,
  users,
} from '../p185/lib.mjs'

/**
 * Adversarial scenario evaluation (P184): every synthetic fixture plus the LOCAL-ONLY real-artwork
 * photos through the REAL release app, against the scenario catalog (scenario-catalog.mjs). For each
 * scan it records what OCR read, what the visual channel ranked, what fusion decided and what the
 * person is shown — then applies the policy: a HIGH is only acceptable for the card the fixture
 * really is, and never for a fixture whose evidence is degraded, contradictory or ambiguous.
 */
const ANY = ['HIGH', 'MEDIUM', 'LOW', 'NO_MATCH']
const RULES = {
  'f01-clean': { truth: 'Sparkfin', tiers: ['HIGH', 'MEDIUM'], positive: true },
  'f02-perspective': { truth: 'Sparkfin', tiers: ANY },
  'f03-blur-moderate': { truth: 'Sparkfin', tiers: ANY },
  'f04-blur-severe': { forbidHigh: true, tiers: ['LOW', 'NO_MATCH'] },
  'f05-glare': { truth: 'Sparkfin', tiers: ANY },
  'f06-cropped-top': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f07-cropped-bottom': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f08-upside-down': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f09-rotated-90': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f10-tiny-in-background': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f11-non-card': { forbidHigh: true, tiers: ['LOW', 'NO_MATCH'] },
  'f12-unknown-card': { forbidHigh: true, tiers: ['LOW', 'NO_MATCH'] },
  'f13-ocr-vs-visual': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f14-visual-vs-number': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f15-same-art-reprint': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f16-duplicate-number': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'f17-p169-charizard': { truth: 'P169 Charizard', tiers: ['HIGH', 'MEDIUM'] },
  'f18-p169-pikachu': { forbidHigh: true, tiers: ['MEDIUM', 'LOW'] },
  'real-base1-1': { truth: 'Alakazam', tiers: ['HIGH', 'MEDIUM'], positive: true },
  'real-base1-2': { forbidHigh: true, tiers: ['MEDIUM', 'LOW'] },
  'real-base1-4': { truth: 'Charizard', tiers: ['HIGH', 'MEDIUM'] },
  'real-base1-58': { truth: 'Pikachu', tiers: ['HIGH', 'MEDIUM'] },
  'real-base1-16': { forbidHigh: true, tiers: ['MEDIUM', 'LOW', 'NO_MATCH'] },
  'real-base1-15': { forbidHigh: true, tiers: ['NO_MATCH', 'LOW'] },
}

const list = fixtureManifest.fixtures.map((f) => ({
  id: f.id,
  file: join(fixtureDir, f.file),
  scenario: f.scenario,
}))
const realDir = join(appRoot, '..', '..', '.p184-scratch', 'real-art')
if (existsSync(realDir)) {
  for (const file of readdirSync(realDir)
    .filter((f) => f.endsWith('.jpg'))
    .sort()) {
    list.push({
      id: file.replace('.jpg', ''),
      file: join(realDir, file),
      scenario: 'REAL artwork (local only, never committed)',
    })
  }
}

amStart()
await ensureSignedIn(users.b)
clearLog()
await proxy('reset', 'POST')
const results = []
for (const item of list) {
  const rule = RULES[item.id]
  if (rule === undefined) throw new Error(`no policy rule for ${item.id}`)
  const { trace, ui } = await scanFixture(item.file, { label: item.id })
  shot(`eval-${item.id}`)
  const tier = trace.tier ?? (trace.outcome === 'abstain_quality' ? 'ABSTAIN' : trace.outcome)
  const topLabel = ui.candidates[0]?.label ?? null
  const topName = topLabel === null ? null : topLabel.split(',')[0]
  const isHigh = ui.preselectable
  const wrongHigh =
    isHigh && (rule.forbidHigh === true || (rule.truth !== undefined && topName !== rule.truth))
  const tierOk = rule.tiers.includes(tier) || tier === 'ABSTAIN'
  const positiveOk = rule.positive !== true || tier === 'HIGH'
  results.push({
    id: item.id,
    scenario: item.scenario,
    ocr: trace.ocr,
    visualTop1: trace.visualTop[0] ?? null,
    tier,
    ui: stripNodes(ui),
    topName,
    highShown: isHigh,
    falseHigh: wrongHigh,
    tierOk,
    positiveOk,
    pass: !wrongHigh && tierOk,
    totalMs: trace.stages.totalMs,
    trace,
  })
  console.log(
    `${item.id.padEnd(24)} tier=${String(tier).padEnd(8)} ui=${ui.kind.padEnd(9)} top=${String(topName).padEnd(16)} high=${String(isHigh).padEnd(5)} falseHigh=${String(wrongHigh).padEnd(5)} tierOk=${String(tierOk).padEnd(5)} ocr=${JSON.stringify(trace.ocr && [trace.ocr.name, trace.ocr.number])} v1=${trace.visualTop[0]?.similarity}`,
  )
}
const audit = await proxy('audit')
saveJson('scenario-eval.json', { results, audit })
console.log(
  JSON.stringify({
    total: results.length,
    pass: results.filter((r) => r.pass).length,
    falseHigh: results.filter((r) => r.falseHigh).length,
    positives: results
      .filter(
        (r) =>
          r.positiveOk !== undefined && list.find((l) => l.id === r.id) && RULES[r.id].positive,
      )
      .map((r) => [r.id, r.positiveOk]),
    imageMarkers: audit.imageMarkers,
    audit,
  }),
)
