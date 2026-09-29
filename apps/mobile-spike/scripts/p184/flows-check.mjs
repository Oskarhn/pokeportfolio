#!/usr/bin/env node
/**
 * P184 integrated journeys on the installed release build: photo -> recognised card -> confirm ->
 * explicit printing -> read-only Price Check -> Add to Collection (one acquisition) and -> a
 * non-NOK purchase with FX, each verified against the isolated database. LOCAL ONLY.
 *
 *   node scripts/p184/flows-check.mjs            (P184_STEPS=<regex> runs a subset)
 *
 * Preconditions: stack seeded, scripts/p169/mock-tcgdex.mjs --stack=p184 and the capture proxy
 * running, the proof APK installed on the P184 emulator. Output: .build/p184-evidence/flows-report.json
 */
import './env.mjs'
import { amStart } from '../android-p167-lib.mjs'
import {
  byId,
  byIdPrefix,
  dump,
  ensureSignedIn,
  fixtureDir,
  proxy,
  psql,
  saveJson,
  scanFixture,
  shell,
  shot,
  sleep,
  tap,
  users,
  waitFor,
} from './lib.mjs'
import { back, findScrolling, tapId, tapScrolling, typeInto } from './flows.mjs'
import { B, choosePrinting, counts, diff, finCounts, priceTexts, scanToCard } from './journeys.mjs'

const only = process.env.P184_STEPS ? new RegExp(process.env.P184_STEPS, 'i') : null
const report = []

async function step(name, fn) {
  if (only && !only.test(name)) return
  const t0 = Date.now()
  try {
    const detail = await fn()
    report.push({ step: name, status: 'PASS', ms: Date.now() - t0, detail })
    console.log(`PASS ${name}  ${JSON.stringify(detail ?? null).slice(0, 800)}`)
  } catch (e) {
    report.push({
      step: name,
      status: 'FAIL',
      ms: Date.now() - t0,
      detail: String(e.message ?? e).slice(0, 800),
    })
    console.log(`FAIL ${name}  ${String(e.message ?? e).slice(0, 600)}`)
    try {
      shot(`flow-fail-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`)
    } catch {
      // The failure itself is what matters.
    }
  }
}

amStart()
await ensureSignedIn(B)
await proxy('reset', 'POST')
await fetch('http://127.0.0.1:55499/__reset', { method: 'POST' }).catch(() => undefined)

// ------------------------------------------------------------------------------------------------
let flow1 = null
await step(
  'scanner -> confirm card -> explicit printing -> raw Price Check (read-only)',
  async () => {
    const before = counts()
    const { trace, ui, cardId } = await scanToCard(
      'f17-p169-charizard.jpg',
      'flow1',
      'P169 Charizard',
    )
    const pre = counts()
    const cardScreen = {
      printingChoiceShown: !!byId(dump(), 'p169-printing-choice'),
      priceShownBeforeChoice: byIdPrefix(dump(), 'p169-raw-').length > 0,
    }
    if (!cardScreen.printingChoiceShown)
      throw new Error('the card with two printings did not ask for the printing')
    if (cardScreen.priceShownBeforeChoice)
      throw new Error('a price was shown before a printing was chosen')
    const printing = await choosePrinting(cardId, 'holo')
    shot('flow1-price-check')
    const after = counts()
    flow1 = { cardId, printing }
    if (finCounts() !== before.join('|'))
      throw new Error(`Price Check wrote to the ledger: ${JSON.stringify(diff(before, after))}`)
    return {
      tier: trace.tier,
      preselected: trace.preselectedId,
      shownConfidence: ui.badge ?? ui.heading,
      printing,
      prices: priceTexts(),
      writesDuringScanAndPriceCheck: diff(before, after),
    }
  },
)

await step(
  'Add to Collection: nothing is written before the final confirm, then exactly one acquisition',
  async () => {
    if (flow1 === null) throw new Error('needs the Price Check step')
    const before = counts()
    const { node } = await findScrolling('p169-add-to-collection')
    tap(node)
    await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
    await tapScrolling('p175-go-add-acquisition')
    await waitFor((ns) => byId(ns, 'p175-add-acquisition'), { label: 'add acquisition form' })
    await typeInto('p175-unit-cost', '12.34')
    await typeInto('p175-quantity', '1')
    const beforeConfirm = counts()
    if (beforeConfirm.join('|') !== before.join('|'))
      throw new Error(
        `the ledger changed before the final confirm: ${JSON.stringify(diff(before, beforeConfirm))}`,
      )
    await tapScrolling('p175-confirm-acquisition')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-acquisition-success'), {
      timeoutMs: 30000,
      label: 'acquisition result',
    })
    await sleep(1500)
    const after = counts()
    const d = diff(before, after)
    if (d.lots !== 1)
      throw new Error(`expected exactly one new acquisition lot, got ${JSON.stringify(d)}`)
    const lot = psql(
      `select al.quantity||'|'||al.unit_cost_basis_minor||'|'||al.cost_basis_state from acquisition_lots al join holdings h on h.id=al.holding_id where h.user_id='${B.id}' and h.card_variant_id='${flow1.printing.variantId}' order by al.created_at desc limit 1`,
    )
    if (lot !== '1|1234|known') throw new Error(`unexpected lot ${lot}`)
    return { writesBeforeConfirm: diff(before, beforeConfirm), writesAfterConfirm: d, lot }
  },
)

await step('Collection shows the new holding', async () => {
  if (flow1 === null) throw new Error('needs the Price Check step')
  const holdingId = psql(
    `select id from holdings where user_id='${B.id}' and card_variant_id='${flow1.printing.variantId}'`,
  )
  await tapId('tab-collection', 'collection tab')
  await waitFor((ns) => byId(ns, 'collection-list'), { label: 'collection list' })
  const { node } = await findScrolling(`row-${holdingId}`)
  shot('flow2-collection-row')
  return {
    rowVisible: node !== undefined,
    holdingId: holdingId.slice(0, 8),
    label: (node.desc || node.text).slice(0, 90),
  }
})

await step(
  'scanner -> printing -> Record purchase in EUR: exact source amount + FX + NOK',
  async () => {
    const before = counts()
    const { cardId } = await scanToCard('f17-p169-charizard.jpg', 'flow3', 'P169 Charizard')
    const printing = await choosePrinting(cardId, 'holo')
    const { node } = await findScrolling('p169-add-to-collection')
    tap(node)
    await waitFor((ns) => byId(ns, 'p170-add-intent'), { label: 'add intent screen' })
    await tapScrolling('p175-go-record-purchase')
    await waitFor((ns) => byId(ns, 'p175-record-purchase'), { label: 'record purchase screen' })
    await tapScrolling('p178-purchase-currency')
    await waitFor((ns) => byId(ns, 'p178-currency-option-EUR'), { label: 'currency sheet' })
    tap(byId(dump(), 'p178-currency-option-EUR'))
    await waitFor((ns) => byId(ns, 'p180-purchase-fx-notice'), {
      timeoutMs: 20000,
      label: 'FX notice',
    })
    const fxNotice = byId(dump(), 'p180-purchase-fx-notice')?.text ?? null
    await typeInto('p175-purchase-quantity', '2')
    await typeInto('p175-purchase-unit-price', '10.00')
    const total = byId(dump(), 'p175-purchase-total')?.text ?? null
    const beforeConfirm = counts()
    if (beforeConfirm.join('|') !== before.join('|'))
      throw new Error('a write happened before the final confirm')
    shot('flow3-purchase-eur-form')
    await tapScrolling('p175-confirm-purchase')
    await waitFor((ns) => byId(ns, 'collection-list') || byId(ns, 'p175-purchase-success'), {
      timeoutMs: 30000,
      label: 'purchase result',
    })
    await sleep(1500)
    const after = counts()
    const d = diff(before, after)
    if (d.purchases !== 1)
      throw new Error(`expected exactly one new purchase, got ${JSON.stringify(d)}`)
    const row = psql(
      `select p.currency||'|'||p.total_minor||'|'||p.fx_rate_to_nok||'|'||p.fx_rate_date||'|'||p.fx_source||'|'||p.total_nok_minor||'|'||pl.quantity||'|'||pl.unit_price_minor from purchases p join purchase_lines pl on pl.purchase_id=p.id where p.user_id='${B.id}' order by p.created_at desc limit 1`,
    )
    const [currency, totalMinor, fx, fxDate, fxSource, totalNok, qty, unit] = row.split('|')
    // 2 x EUR 10.00 = 2000 minor; NOK = 2000 * 11.5 = 23000 minor (EUR 20.00 -> NOK 230.00).
    if (currency !== 'EUR' || totalMinor !== '2000' || unit !== '1000' || qty !== '2')
      throw new Error(`source amount is not exact: ${row}`)
    if (Number(fx) !== 11.5 || fxSource !== 'norges_bank' || totalNok !== '23000')
      throw new Error(`FX/NOK fields are not exact: ${row}`)
    return {
      form: { fxNotice, total },
      row: { currency, totalMinor, fx, fxDate, fxSource, totalNok, qty, unit },
      writes: d,
    }
  },
)

saveJson('flows-report.json', { report, requests: (await proxy('log')).requests.length })
const failed = report.filter((r) => r.status === 'FAIL').length
console.log(
  `\nSTEPS ${String(report.length)}  PASS ${String(report.filter((r) => r.status === 'PASS').length)}  FAIL ${String(failed)}`,
)
process.exit(failed > 0 ? 1 : 0)
