#!/usr/bin/env node
/**
 * P185 scanner accessibility and layout gate, driven from the uiautomator accessibility tree.
 * LOCAL ONLY (synthetic data). TalkBack itself is covered by talkback-check.mjs.
 *
 *   node scripts/p185/a11y-check.mjs            (P185_TAG=-p184apk labels a run of another APK)
 *
 * For the scanner outcomes (HIGH, review MEDIUM, review LOW, no match, blur abstain) and the card
 * screen with its printing radios, at 360 dp / 200 % font and at 430 dp / 100 % font:
 *
 *   - the WHOLE scroll range is swept (see a11y-lib.mjs): every control is judged where it was best
 *     visible; all of them must be reachable, fully on screen, not overlapping each other and not
 *     under the tab bar;
 *   - every app-owned button / radio / checkbox / switch is >= 48 dp on both sides and is named;
 *   - authoritative identity (card, set, printed number) is in the accessible name of the candidate;
 *   - confidence is stated in WORDS; no raw UUID and no model score is exposed anywhere;
 *   - the printing radios expose their selected state;
 *   - a screenshot of every scroll position is kept (identity must not be visibly truncated).
 *
 * Output: .build/p185-evidence/a11y-report<TAG>.json + a11y-<config>-<scenario>-<n>.png
 */
import './env.mjs'
import { join } from 'node:path'
import { amStart, openPhotoScreen } from '../android-p167-lib.mjs'
import {
  adb,
  byId,
  dump,
  ensureSignedIn,
  fixtureDir,
  nextScanTrace,
  pickNewest,
  pushImage,
  saveJson,
  scanMark,
  scansSince,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { screen, sweepDumps } from './driver.mjs'
import { CONFIDENCE_WORDS, auditSweep, leaks, textSeen } from './a11y-lib.mjs'

const TAG = process.env.P185_TAG ?? ''
const report = []
function record(name, status, detail) {
  report.push({ name, status, detail })
  console.log(`${status} ${name}  ${JSON.stringify(detail ?? null).slice(0, 1200)}`)
}
const idOf = (n) => n.id.replace(/^.*:id\//, '')

const CONFIGS = [
  {
    name: '360dp-font200',
    apply: () => {
      shell('wm density 480')
      shell('settings put system font_scale 2.0')
    },
  },
  {
    name: '430dp-font100',
    apply: () => {
      shell('wm density 400')
      shell('settings put system font_scale 1.0')
    },
  },
]
const revert = () => {
  shell('wm density reset')
  shell('settings put system font_scale 1.0')
}

/** What each scanner outcome must show, as accessible text. */
const SCENARIOS = [
  {
    name: 'high',
    file: 'f01-clean.jpg',
    outcomeId: 'p169-recognition-result',
    tier: 'HIGH',
    texts: [
      ['heading', /Likely match/],
      ['confidence', CONFIDENCE_WORDS.high],
      ['identity', /Sparkfin.*P184 Set Alpha.*007/],
    ],
    controls: ['p169-recognition-confirm', 'p169-recognition-retake', 'p169-photo-choose-manually'],
  },
  {
    name: 'review-medium',
    file: 'f17-p169-charizard.jpg',
    outcomeId: 'p169-recognition-result',
    tier: 'MEDIUM',
    texts: [
      ['heading', /Possible matches/],
      ['confidence', CONFIDENCE_WORDS.review_medium],
      ['identity', /P169 Charizard.*P169 Base Set.*004/],
    ],
    controls: ['p169-recognition-retake', 'p169-photo-choose-manually'],
  },
  {
    name: 'review-low',
    file: 'f18-p169-pikachu.jpg',
    outcomeId: 'p169-recognition-result',
    tier: 'LOW',
    texts: [
      ['heading', /Possible matches/],
      ['confidence', CONFIDENCE_WORDS.review_low],
      ['identity', /P169 Pikachu.*P169 Legends Reprint.*025/],
    ],
    controls: ['p169-recognition-retake', 'p169-photo-choose-manually'],
  },
  {
    name: 'no-match',
    file: 'f12-unknown-card.jpg',
    outcomeId: 'p169-recognition-no-match',
    tier: 'NO_MATCH',
    texts: [['no match', /did not match a card/]],
    controls: ['p169-choose-manually'],
  },
  {
    name: 'blur-abstain',
    file: 'f04-blur-severe.jpg',
    outcomeId: 'p169-recognition-abstain',
    tier: null,
    texts: [['reason', /blurry|sharp|unclear|readable|focus/i]],
    controls: ['p169-recognition-retake'],
  },
]

async function scanAndSweep(cfgName, sc) {
  const before = scanMark()
  await pushImage(join(fixtureDir, sc.file), `a11y-${cfgName}`)
  await pickNewest()
  const trace = await nextScanTrace(before)
  await sleep(900)
  const scr = screen()
  const dumps = await sweepDumps({
    onScreen: (i) => shot(`a11y-${cfgName}-${sc.name}-${String(i)}${TAG}`),
  })
  const audit = auditSweep(dumps, { dpi: scr.dpi, width: scr.width })
  return { trace, scr, dumps, audit }
}

const clean = (a) =>
  a.small.length +
    a.unlabeled.length +
    a.unreachable.length +
    a.overlaps.length +
    a.obstructed.length +
    a.offscreenX.length ===
  0

adb(['logcat', '-G', '16M'], { allowFail: true })
amStart()
await ensureSignedIn(users.b)

for (const cfg of CONFIGS) {
  cfg.apply()
  await sleep(4000)
  amStart()
  await ensureSignedIn(users.b)
  await openPhotoScreen()
  await sleep(800)

  // --- idle photo entry
  {
    const scr = screen()
    const dumps = await sweepDumps({
      onScreen: (i) => shot(`a11y-${cfg.name}-idle-${String(i)}${TAG}`),
    })
    const a = auditSweep(dumps, { dpi: scr.dpi, width: scr.width })
    record(`${cfg.name} photo entry idle`, clean(a) ? 'PASS' : 'FAIL', {
      widthDp: Math.round(scr.width / (scr.dpi / 160)),
      screens: a.screens,
      roles: a.roles,
      small: a.small,
      unlabeled: a.unlabeled,
      unreachable: a.unreachable,
      overlaps: a.overlaps,
      obstructed: a.obstructed,
    })
  }

  for (const sc of SCENARIOS) {
    let r
    try {
      r = await scanAndSweep(cfg.name, sc)
    } catch (e) {
      record(`${cfg.name} ${sc.name}`, 'FAIL', String(e.message ?? e).slice(0, 400))
      continue
    }
    const { trace, scr, audit } = r
    const seen = Object.fromEntries(sc.texts.map(([k, re]) => [k, textSeen(audit, re)]))
    const missingText = sc.texts.filter(([k]) => seen[k] === null).map(([k]) => k)
    const missingControls = sc.controls.filter((id) => !audit.all.some((n) => idOf(n) === id))
    const outcomeShown = audit.all.some((n) => idOf(n) === sc.outcomeId)
    const leaked = leaks(audit)
    const tierOk = sc.tier === null || trace.tier === sc.tier
    const candidateRows = audit.all.filter((n) => idOf(n).startsWith('p169-recognition-candidate-'))
    const ok =
      outcomeShown &&
      tierOk &&
      missingText.length === 0 &&
      missingControls.length === 0 &&
      clean(audit) &&
      leaked.length === 0
    record(`${cfg.name} ${sc.name}`, ok ? 'PASS' : 'FAIL', {
      widthDp: Math.round(scr.width / (scr.dpi / 160)),
      tier: trace.tier,
      tierOk,
      outcomeShown,
      screens: audit.screens,
      roles: audit.roles,
      textSeenInScreen: Object.fromEntries(
        Object.entries(seen).map(([k, v]) => [k, v === null ? null : v.dumpIndex]),
      ),
      missingText,
      missingControls,
      small: audit.small,
      unlabeled: audit.unlabeled,
      unreachable: audit.unreachable,
      overlaps: audit.overlaps,
      obstructed: audit.obstructed,
      offscreenX: audit.offscreenX,
      leaked,
      candidateNames: candidateRows.map((n) => n.desc || n.text),
    })
  }

  // --- card screen with printing radios: sizes, names, selected state after a choice
  {
    const before = scanMark()
    await pushImage(join(fixtureDir, 'f17-p169-charizard.jpg'), `a11y-${cfg.name}-card`)
    await pickNewest()
    await nextScanTrace(before)
    await sleep(900)
    const { value: rowNode } = await waitFor(
      (ns) => ns.find((n) => idOf(n).startsWith('p169-recognition-candidate-')),
      { label: 'candidate row (visible after the scan)' },
    ).catch(async () => {
      // At 200 % the row sits below the fold: scroll until it shows.
      for (let i = 0; i < 6; i += 1) {
        shell('input touchscreen swipe 540 1700 540 800 300')
        await sleep(500)
        const hit = dump().find((n) => idOf(n).startsWith('p169-recognition-candidate-'))
        if (hit) return { value: hit }
      }
      throw new Error('candidate row never became visible')
    })
    tap(rowNode)
    await waitFor((ns) => byId(ns, 'p169-card') || byId(ns, 'p169-card-identity'), {
      timeoutMs: 30000,
      label: 'card screen',
    })
    await sleep(900)
    const scr = screen()
    const dp = scr.dpi / 160
    const choiceDumps = await sweepDumps({
      onScreen: (i) => shot(`a11y-${cfg.name}-card-choice-${String(i)}${TAG}`),
    })
    const choice = auditSweep(choiceDumps, { dpi: scr.dpi, width: scr.width })
    const radios = choice.all.filter(
      (n) => n.cls === 'android.widget.RadioButton' && idOf(n).startsWith('p169-variant-'),
    )
    // Choose the first printing and read the radios again: exactly one must be selected/checked.
    if (radios[0]) {
      const fresh = dump().find((n) => n.bounds && idOf(n) === idOf(radios[0]))
      if (fresh) tap(fresh)
    }
    await sleep(2500)
    const afterDumps = await sweepDumps({
      onScreen: (i) => shot(`a11y-${cfg.name}-card-chosen-${String(i)}${TAG}`),
    })
    const after = auditSweep(afterDumps, { dpi: scr.dpi, width: scr.width })
    // After a choice the printing is stated in words and the price source is a radio pair
    // ("Provider prices" / "Stored snapshot"): exactly one of them is checked.
    const afterRadios = after.all.filter((n) => n.cls === 'android.widget.RadioButton')
    const checkedCount = afterRadios.filter((n) => n.checked || n.selected).length
    const printingWords = textSeen(after, /Printing you chose/)
    record(
      `${cfg.name} card screen (printing radios)`,
      radios.length >= 2 &&
        choice.small.length + choice.unlabeled.length + choice.unreachable.length === 0 &&
        after.small.length + after.unreachable.length === 0 &&
        checkedCount === 1 &&
        printingWords !== null
        ? 'PASS'
        : 'FAIL',
      {
        radiosFound: radios.length,
        radioSizesDp: radios.map((n) => [
          Math.round((n.bounds.x2 - n.bounds.x1) / dp),
          Math.round((n.bounds.y2 - n.bounds.y1) / dp),
        ]),
        radioNames: radios.map((n) => n.desc || n.text),
        choiceSmall: choice.small,
        choiceUnreachable: choice.unreachable,
        afterSmall: after.small,
        afterUnreachable: after.unreachable,
        checkedAfterChoice: checkedCount,
        printingStatedInWords: printingWords?.text ?? null,
        leaked: leaks(choice).concat(leaks(after)),
      },
    )
    shell('input keyevent 4')
    await sleep(800)
  }
}
revert()
await sleep(3000)

saveJson(`a11y-report${TAG}.json`, report)
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(`\nSTEPS ${String(report.length)}  FAIL ${String(failed)}`)
process.exit(failed > 0 ? 1 : 0)
