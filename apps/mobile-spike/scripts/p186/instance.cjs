/**
 * One named LOCAL instance of the native test environment (stack, emulator, ports, app id), resolved
 * from the command line and the environment instead of from edits to the source.
 *
 * P186's drivers hard-coded one stack, one AVD, one serial and one set of ports. An independent
 * reproducer running next to it had to patch the registry in scripts/p169/local-backend.mjs and
 * scripts/p186/env.mjs (uncommitted). With this module a second instance is
 *
 *   P186_INSTANCE=verify1 P186_PORT_SHIFT=1600 P186_EMULATOR_PORT=5562 node scripts/p186/...
 *
 * Precedence, highest first, for every value: an explicit environment variable of the consumer
 * (ANDROID_SERIAL, ANDROID_AVD_NAME, SPIKE_PACKAGE, P185_STACK, P185_PROXY_PORT, P185_API_PORT,
 * P185_DB_CONTAINER, P185_EVIDENCE_DIR) > the P186_* instance values > the P186 defaults, which
 * reproduce the previous normal use exactly. Pure and side-effect free so a test can pin it.
 */
'use strict'

const NAME = /^[a-z][a-z0-9]{1,15}$/
const DEFAULT_INSTANCE = 'p186'
const DEFAULT_PORT_SHIFT = 650
const DEFAULT_EMULATOR_PORT = 5560

function intIn(value, label, min, max) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}, got ${JSON.stringify(value)}`)
  }
  return n
}

/**
 * Local Supabase stack identity for a name the static registry does not know. Mirrors the fields the
 * registry entries carry (see STACKS in scripts/p169/local-backend.mjs); the port formulas are the
 * ones the P186 entry follows (API = 55321 + shift, mock provider = 54852 + shift).
 */
function dynamicStack(name, portShift) {
  if (!NAME.test(name)) throw new Error(`stack name ${JSON.stringify(name)} must match ${NAME}`)
  const shift = intIn(portShift, 'port shift', 100, 9000)
  return {
    projectId: `pokeportfolio-${name}-app`,
    portShift: shift,
    dir: name,
    mockPort: 54852 + shift,
    withWorktreeMigrations: true,
  }
}

/**
 * @param {{ env?: Record<string, string | undefined>, argv?: string[] }} input
 */
function resolveInstance({ env = {}, argv = [] } = {}) {
  const flag = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3)
  const name = flag('instance') ?? env.P186_INSTANCE ?? DEFAULT_INSTANCE
  if (!NAME.test(name)) throw new Error(`instance ${JSON.stringify(name)} must match ${NAME}`)
  const portShift = intIn(
    flag('port-shift') ?? env.P186_PORT_SHIFT ?? DEFAULT_PORT_SHIFT,
    'port shift',
    100,
    9000,
  )
  const emulatorPort = intIn(
    flag('emulator-port') ?? env.P186_EMULATOR_PORT ?? DEFAULT_EMULATOR_PORT,
    'emulator port',
    5554,
    5584,
  )
  if (emulatorPort % 2 !== 0)
    throw new Error('emulator port must be even (adb uses port and port+1)')
  const stack = env.P185_STACK ?? name
  const projectId = `pokeportfolio-${stack}-app`
  return {
    instance: name,
    portShift,
    SPIKE_PACKAGE: env.SPIKE_PACKAGE ?? `invalid.pokeportfolio.spike.${name}`,
    ANDROID_SERIAL: env.ANDROID_SERIAL ?? `emulator-${emulatorPort}`,
    ANDROID_AVD_NAME: env.ANDROID_AVD_NAME ?? `${name}_api36`,
    P185_STACK: stack,
    P185_PORT_SHIFT: env.P185_PORT_SHIFT ?? String(portShift),
    P185_PROXY_PORT: env.P185_PROXY_PORT ?? String(55191 + portShift),
    P185_API_PORT: env.P185_API_PORT ?? String(55321 + portShift),
    P185_DB_CONTAINER: env.P185_DB_CONTAINER ?? `supabase_db_${projectId}`,
    P185_EVIDENCE_DIR: env.P185_EVIDENCE_DIR ?? `${name}-evidence`,
  }
}

module.exports = { resolveInstance, dynamicStack, DEFAULT_INSTANCE, DEFAULT_PORT_SHIFT }
