// Imported FIRST by the P186 drivers (scripts/android-adb.mjs reads these when it is evaluated).
// P186 reuses the P185 drivers under its own application id, emulator, stack, proxy port and
// evidence directory so it never touches another phase's stack or device. Every value can be
// overridden from the environment (see instance.cjs for the precedence), so a second, parallel
// instance needs no source edit:
//   P186_INSTANCE=verify1 P186_PORT_SHIFT=1600 P186_EMULATOR_PORT=5562 node scripts/p186/smoke.mjs
import { createRequire } from 'node:module'

const { resolveInstance } = createRequire(import.meta.url)('./instance.cjs')
const { instance, portShift, ...values } = resolveInstance({
  env: process.env,
  argv: process.argv.slice(2),
})
for (const [key, value] of Object.entries(values)) process.env[key] ??= value
process.env.P186_INSTANCE ??= instance
process.env.P186_PORT_SHIFT ??= String(portShift)
