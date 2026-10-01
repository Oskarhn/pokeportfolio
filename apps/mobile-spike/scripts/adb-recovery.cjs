/**
 * P185: the pure decision and recovery logic behind the Android device drivers' adb calls. Plain
 * CommonJS (not `.mjs`) so Jest can `require()` it directly, like fixture-overwrite-guard.js.
 *
 * P184's integrated journey stopped at step 11 when the adb daemon died mid-run. The drivers
 * addressed the device only through the ANDROID_SERIAL environment variable and had no notion of a
 * lost server. This module adds the missing contract, and nothing more:
 *
 *   - a failure is classified from adb's own output (never from a guess): server unreachable,
 *     target not (yet) visible, or anything else;
 *   - only the first two are recovered, bounded, and at most `maxRecoveries` times per run;
 *   - recovery first RESTARTS the server without killing it (a running server is shared with every
 *     other session on the machine), and only if the target still does not come back does it kill
 *     and restart it, once;
 *   - after recovery the driver proves it is talking to the SAME emulator it started with: the
 *     serial, the AVD name and the kernel boot id must all be unchanged. A rebooted emulator has
 *     lost app state; a different AVD is somebody else's device. Both are a clear failure, never a
 *     silent continuation.
 *
 * Every command it issues itself is scoped with `-s <serial>`; it never runs an unscoped adb
 * command that could land on another device.
 */

const SERVER_LOSS = [
  /daemon not running/i,
  /cannot connect to daemon/i,
  /failed to check server version/i,
  /server didn't ACK/i,
  /protocol fault/i,
  /error: closed/i,
  /connection (?:reset|refused|aborted)/i,
  /could not read ok from adb server/i,
]
const TARGET_GONE = [
  /device offline/i,
  /device '[^']*' not found/i,
  /no devices\/emulators found/i,
  /error: device unauthorized/i,
]

/** 'ok' | 'server_loss' | 'target_gone' | 'other' from one finished adb process. */
function classifyAdbFailure({ status, stdout, stderr }) {
  const text = `${String(stderr ?? '')}\n${typeof stdout === 'string' ? stdout.slice(0, 2000) : ''}`
  if (SERVER_LOSS.some((re) => re.test(text))) return 'server_loss'
  if (TARGET_GONE.some((re) => re.test(text))) return 'target_gone'
  return status === 0 ? 'ok' : 'other'
}

class AdbRecoveryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdbRecoveryError'
  }
}
class AdbIdentityError extends AdbRecoveryError {
  constructor(message) {
    super(message)
    this.name = 'AdbIdentityError'
  }
}

/**
 * @param {object} o
 * @param {(args: string[]) => {status: number|null, stdout: string, stderr: string}} o.run raw adb
 * @param {(ms: number) => void} o.sleepSync
 * @param {string} o.serial   the one device this run owns (e.g. emulator-5558)
 * @param {string} [o.expectedAvd]
 * @param {number} [o.maxRecoveries]
 * @param {(line: string) => void} [o.log]
 */
function createRecovery({
  run,
  sleepSync,
  serial,
  expectedAvd,
  maxRecoveries = 2,
  log = () => {},
}) {
  if (!serial) throw new AdbRecoveryError('createRecovery: a serial is required')
  const state = { recoveries: 0, bootId: null, serverKills: 0, avd: null }
  const scoped = (args) => run(['-s', serial, ...args])
  const prop = (name) => scoped(['shell', 'getprop', name]).stdout.trim()

  function waitForTarget(tries) {
    for (let i = 0; i < tries; i += 1) {
      const r = scoped(['get-state'])
      if (r.status === 0 && r.stdout.trim() === 'device') return true
      sleepSync(1000)
    }
    return false
  }

  /** Records the identity of the device as it is now; throws if it is not the expected one. */
  function verifyIdentity({ remember }) {
    const avd = prop('ro.boot.qemu.avd_name')
    if (expectedAvd && avd !== expectedAvd) {
      throw new AdbIdentityError(
        `${serial} reports AVD ${JSON.stringify(avd)}, expected ${JSON.stringify(expectedAvd)}; refusing to continue`,
      )
    }
    const boot = scoped(['shell', 'cat', '/proc/sys/kernel/random/boot_id']).stdout.trim()
    if (boot === '') throw new AdbIdentityError(`${serial} did not report a boot id`)
    if (state.bootId !== null && boot !== state.bootId) {
      throw new AdbIdentityError(
        `${serial} rebooted during the run (boot id changed); app state is lost, refusing to continue`,
      )
    }
    if (remember || state.bootId === null) state.bootId = boot
    state.avd = avd
    return { avd, bootId: boot }
  }

  function recover(reason) {
    state.recoveries += 1
    if (state.recoveries > maxRecoveries) {
      throw new AdbRecoveryError(
        `adb recovery attempted ${String(state.recoveries)} times (limit ${String(maxRecoveries)}) after: ${reason}`,
      )
    }
    log(`adb recovery #${String(state.recoveries)} (${reason})`)
    // 1) restart without killing: a running server is shared with other sessions.
    run(['start-server'])
    let back = waitForTarget(4)
    // 2) only if the target is still unreachable: kill and start the server once.
    if (!back) {
      state.serverKills += 1
      log('adb: target still unreachable, restarting the server')
      run(['kill-server'])
      sleepSync(800)
      run(['start-server'])
      back = waitForTarget(30)
    }
    if (!back) throw new AdbRecoveryError(`${serial} did not come back after restarting adb`)
    return verifyIdentity({ remember: false })
  }

  return {
    state,
    classify: classifyAdbFailure,
    verifyIdentity,
    recover,
    /** True when a finished process should be retried once after recovery. */
    shouldRecover(result) {
      const kind = classifyAdbFailure(result)
      return kind === 'server_loss' || kind === 'target_gone'
    },
  }
}

module.exports = { AdbIdentityError, AdbRecoveryError, classifyAdbFailure, createRecovery }
