import './env.mjs'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { amStart } from '../android-p167-lib.mjs'
import {
  appRoot,
  clearLog,
  ensureSignedIn,
  saveJson,
  scanFixture,
  stripNodes,
  users,
} from './lib.mjs'

/** LOCAL-ONLY: real card artwork (cached by an earlier phase, never committed) through the app. */
const dir = join(appRoot, '..', '..', '.p184-scratch', 'real-art')
amStart()
await ensureSignedIn(users.b)
clearLog()
const out = []
for (const file of readdirSync(dir).filter((f) => f.endsWith('.jpg'))) {
  const { trace, ui } = await scanFixture(join(dir, file), { label: file.replace('.jpg', '') })
  out.push({ file, trace, ui: stripNodes(ui) })
  console.log(
    `${file}: ocr=${JSON.stringify(trace.ocr)} top=${trace.visualTop
      .slice(0, 3)
      .map((v) => `${v.cardId.slice(0, 8)}@${v.similarity}`)
      .join(' ')} tier=${trace.tier} ui=${ui.kind} ms=${trace.stages.totalMs}`,
  )
}
saveJson('calibration-real.json', out)
