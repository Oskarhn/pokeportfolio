interface Result {
  status: number | null
  stdout: string
  stderr: string
}
interface Recovery {
  state: { recoveries: number; serverKills: number; bootId: string | null; avd: string | null }
  shouldRecover: (r: Result) => boolean
  verifyIdentity: (o: { remember: boolean }) => { avd: string; bootId: string }
  recover: (reason: string) => { avd: string; bootId: string }
}
interface RecoveryModule {
  classifyAdbFailure: (r: Result) => 'ok' | 'server_loss' | 'target_gone' | 'other'
  createRecovery: (o: {
    run: (args: string[]) => Result
    sleepSync: (ms: number) => void
    serial: string
    expectedAvd?: string
    maxRecoveries?: number
    log?: (line: string) => void
  }) => Recovery
  AdbIdentityError: new (m: string) => Error
  AdbRecoveryError: new (m: string) => Error
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mod = require('../../scripts/adb-recovery.cjs') as RecoveryModule
const { AdbIdentityError, AdbRecoveryError, classifyAdbFailure, createRecovery } = mod

/**
 * P185 §21: the driver's adb recovery, tested without a real adb. P184's integrated journey stopped
 * when the adb daemon died; the contract now is: detect the loss from adb's own output, restart the
 * server (without killing it unless the target stays unreachable), prove the SAME emulator is back
 * (serial, AVD name, boot id), retry once — and fail clearly otherwise.
 */
const ok = (stdout = ''): Result => ({ status: 0, stdout, stderr: '' })
const fail = (stderr: string): Result => ({ status: 1, stdout: '', stderr })

interface FakeWorld {
  calls: string[][]
  run: (args: string[]) => Result
  serverUp: boolean
  /** polls of get-state that still answer "offline" after the server restarts */
  offlinePolls: number
  /** the target never answers again */
  gone: boolean
  avd: string
  bootId: string
}

function world(overrides: Partial<FakeWorld> = {}): FakeWorld {
  const w: FakeWorld = {
    calls: [],
    serverUp: true,
    offlinePolls: 0,
    gone: false,
    avd: 'p185_api36',
    bootId: 'boot-1',
    run: (args) => {
      w.calls.push(args)
      const cmd = args[0] === '-s' ? args.slice(2) : args
      if (cmd[0] === 'start-server') {
        w.serverUp = true
        return ok()
      }
      if (cmd[0] === 'kill-server') {
        w.serverUp = false
        w.offlinePolls = 0
        return ok()
      }
      if (!w.serverUp) return fail('cannot connect to daemon at tcp:5037: Connection refused')
      if (cmd[0] === 'get-state') {
        if (w.gone) return fail("error: device 'emulator-5558' not found")
        if (w.offlinePolls > 0) {
          w.offlinePolls -= 1
          return fail("error: device 'emulator-5558' not found")
        }
        return ok('device\n')
      }
      if (cmd.join(' ') === 'shell getprop ro.boot.qemu.avd_name') return ok(`${w.avd}\n`)
      if (cmd.join(' ') === 'shell cat /proc/sys/kernel/random/boot_id') return ok(`${w.bootId}\n`)
      return ok()
    },
    ...overrides,
  }
  return w
}

const make = (w: FakeWorld, extra: { maxRecoveries?: number } = {}) =>
  createRecovery({
    run: (args) => w.run(args),
    sleepSync: () => undefined,
    serial: 'emulator-5558',
    expectedAvd: 'p185_api36',
    ...extra,
  })

describe('classifyAdbFailure', () => {
  it("reads adb's own words: a dead server, a missing target, anything else, success", () => {
    expect(classifyAdbFailure(fail('* daemon not running; starting now at tcp:5037'))).toBe(
      'server_loss',
    )
    expect(classifyAdbFailure(fail('adb: cannot connect to daemon'))).toBe('server_loss')
    expect(classifyAdbFailure(fail("error: protocol fault (couldn't read status)"))).toBe(
      'server_loss',
    )
    expect(classifyAdbFailure(fail('error: device offline'))).toBe('target_gone')
    expect(classifyAdbFailure(fail("error: device 'emulator-5558' not found"))).toBe('target_gone')
    expect(classifyAdbFailure(fail('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'))).toBe('other')
    expect(classifyAdbFailure(ok('fine'))).toBe('ok')
  })

  it('does not mistake a successful command whose OUTPUT mentions a device for a loss', () => {
    expect(classifyAdbFailure({ status: 0, stdout: 'List of devices attached', stderr: '' })).toBe(
      'ok',
    )
  })

  it('only server loss and a missing target are recovered; an app-level failure never is', () => {
    const rec = make(world())
    expect(rec.shouldRecover(fail('cannot connect to daemon'))).toBe(true)
    expect(rec.shouldRecover(fail('error: device offline'))).toBe(true)
    expect(rec.shouldRecover(fail('Failure [INSTALL_FAILED_VERSION_DOWNGRADE]'))).toBe(false)
    expect(rec.shouldRecover(ok())).toBe(false)
  })
})

describe('adb recovery', () => {
  it('restarts a dead server WITHOUT killing it and proves the same emulator is back', () => {
    const w = world()
    const rec = make(w)
    rec.verifyIdentity({ remember: true }) // identity recorded while the server was healthy
    w.serverUp = false
    const id = rec.recover('shell input')
    expect(id).toEqual({ avd: 'p185_api36', bootId: 'boot-1' })
    expect(w.calls.some((c) => c[0] === 'kill-server')).toBe(false)
    expect(rec.state.serverKills).toBe(0)
    expect(rec.state.recoveries).toBe(1)
  })

  it('kills and restarts the server ONCE only when the target stays unreachable after a plain restart', () => {
    const w = world()
    const rec = make(w)
    rec.verifyIdentity({ remember: true })
    // After start-server the target reports "not found" for the whole first wait window (4 polls),
    // then comes back once the server has been killed and started again.
    w.serverUp = false
    let pollsSinceStart = 0
    const base = w.run
    w.run = (args) => {
      const cmd = args[0] === '-s' ? args.slice(2) : args
      if (
        cmd[0] === 'get-state' &&
        w.serverUp &&
        w.calls.filter((c) => c[0] === 'kill-server').length === 0
      ) {
        w.calls.push(args)
        pollsSinceStart += 1
        return fail("error: device 'emulator-5558' not found")
      }
      return base(args)
    }
    rec.recover('shell input')
    expect(pollsSinceStart).toBe(4)
    expect(w.calls.filter((c) => c[0] === 'kill-server')).toHaveLength(1)
    expect(rec.state.serverKills).toBe(1)
  })

  it('refuses to continue on a DIFFERENT emulator (AVD name changed)', () => {
    const w = world()
    const rec = make(w)
    rec.verifyIdentity({ remember: true })
    w.avd = 'someone_elses_avd'
    expect(() => rec.recover('x')).toThrow(AdbIdentityError)
  })

  it('refuses to continue when the emulator REBOOTED (boot id changed: app state is lost)', () => {
    const w = world()
    const rec = make(w)
    rec.verifyIdentity({ remember: true })
    w.bootId = 'boot-2'
    expect(() => rec.recover('x')).toThrow(/rebooted/)
  })

  it('fails clearly when the target never comes back', () => {
    const w = world({ gone: true })
    const rec = make(w)
    expect(() => rec.recover('x')).toThrow(AdbRecoveryError)
  })

  it('is bounded: more recoveries than the limit is an error, not another retry', () => {
    const w = world()
    const rec = make(w, { maxRecoveries: 2 })
    rec.verifyIdentity({ remember: true })
    rec.recover('1')
    rec.recover('2')
    expect(() => rec.recover('3')).toThrow(/limit 2/)
  })

  it('every command it issues for the device carries -s <serial>; only the server commands are global', () => {
    const w = world()
    const rec = make(w)
    rec.verifyIdentity({ remember: true })
    w.serverUp = false
    rec.recover('x')
    for (const c of w.calls) {
      if (c[0] === 'start-server' || c[0] === 'kill-server') continue
      expect(c.slice(0, 2)).toEqual(['-s', 'emulator-5558'])
    }
  })

  it('a serial is mandatory: an unscoped recovery could land on another device', () => {
    expect(() =>
      createRecovery({ run: () => ok(), sleepSync: () => undefined, serial: '' }),
    ).toThrow(AdbRecoveryError)
  })
})
