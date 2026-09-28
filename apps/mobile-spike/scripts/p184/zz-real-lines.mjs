import './env.mjs'
import { join } from 'node:path'
import { readdirSync } from 'node:fs'
import { amStart } from '../android-p167-lib.mjs'
import { appRoot, clearLog, ensureSignedIn, scanFixture, users } from './lib.mjs'
amStart()
await ensureSignedIn(users.b)
clearLog()
const dir = join(appRoot, '..', '..', '.p184-scratch', 'real-art')
for (const file of readdirSync(dir).filter((f) => f.endsWith('.jpg'))) {
  const { trace } = await scanFixture(join(dir, file), { label: file })
  console.log(file, JSON.stringify(trace.ocr))
}
