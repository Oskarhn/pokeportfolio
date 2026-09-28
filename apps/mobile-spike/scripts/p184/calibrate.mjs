import './env.mjs'
import { join } from 'node:path'
import { amStart } from '../android-p167-lib.mjs'
import {
  clearLog,
  ensureSignedIn,
  fixtureDir,
  fixtureManifest,
  saveJson,
  scanFixture,
  shot,
  stripNodes,
  users,
} from './lib.mjs'

/**
 * Calibration run (P184): every fixture through the REAL release app, with only the standard seeded
 * catalog present. Records what the device's OCR read and which catalog-index cards the visual
 * channel ranks first for each image. scenario-catalog.mjs turns those observations into the
 * catalog rows the adversarial scenarios need.
 */
amStart()
await ensureSignedIn(users.b)
clearLog()
const out = []
for (const f of fixtureManifest.fixtures) {
  const { trace, ui } = await scanFixture(join(fixtureDir, f.file), { label: f.id })
  shot(`calibrate-${f.id}`)
  out.push({ id: f.id, scenario: f.scenario, printed: f.printed, trace, ui: stripNodes(ui) })
  console.log(
    `${f.id}: outcome=${trace.outcome} ocr=${JSON.stringify(trace.ocr)} visual1=${trace.visualTop[0]?.cardId}@${trace.visualTop[0]?.similarity} tier=${trace.tier} totalMs=${trace.stages.totalMs}`,
  )
}
saveJson('calibration.json', out)
