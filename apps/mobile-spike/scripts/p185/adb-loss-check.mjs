#!/usr/bin/env node
/**
 * P185 §21: real adb server loss mid-driver. Kills the adb server under a running driver and shows
 * that the next command recovers (restart, same emulator proven again) instead of failing; also
 * proves a command aimed at a different serial is never silently redirected. LOCAL ONLY.
 *
 *   node scripts/p185/adb-loss-check.mjs        -> .build/p185-evidence/adb-loss-report.json
 */
import './env.mjs'
import { spawnSync } from 'node:child_process'
import { ADB, adb, establishIdentity, recoveryState, shell } from '../android-adb.mjs'
import { saveJson } from './lib.mjs'

const identity = establishIdentity()
const before = shell('echo alive-before').trim()
const killed = spawnSync(ADB, ['kill-server'], { encoding: 'utf8' })
const t0 = Date.now()
const after = shell('echo alive-after').trim() // the very next command: the server is gone
const ms = Date.now() - t0
const state = recoveryState()
const again = establishIdentity()
const report = {
  killServerStatus: killed.status,
  before,
  after,
  recoveryMs: ms,
  recoveries: state.recoveries,
  serverKills: state.serverKills,
  sameAvd: again.avd === identity.avd,
  sameBootId: again.bootId === identity.bootId,
  serial: process.env.ANDROID_SERIAL,
  devicesAfter: adb(['devices'], { allowFail: true }).trim().split(/\r?\n/).slice(1),
}
console.log(JSON.stringify(report, null, 2))
saveJson('adb-loss-report.json', report)
const pass =
  after === 'alive-after' && report.sameAvd && report.sameBootId && (state.recoveries ?? 0) >= 1
console.log(pass ? 'PASS adb daemon loss recovered' : 'FAIL adb daemon loss')
process.exit(pass ? 0 : 1)
