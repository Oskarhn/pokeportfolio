import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  createAnonClient,
  createInvitationDirect,
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  mustDelete,
  seedCatalog,
  type SyntheticUser,
} from '../../db/setup'

/**
 * P203 — one connected, user-level journey in a clean account, driven only through the UI:
 *
 *   invitation → account → search → purchase → cost basis → "no price" → priced, with provenance →
 *   manual valuation (independent of cost) → sign-out → protected routes refuse → expired session.
 *
 * Every other authenticated spec proves one mechanism in isolation (identity races, exact money,
 * unsaved-work protection ...). None walks a new person from an invitation to a valued holding, so a
 * regression in the seams between those steps — a purchase that creates no visible holding, a cost
 * that changes when a value is set, a price shown with no source — had no test to fail.
 *
 * Isolation. The account is created by redeeming a real invitation (no inherited sign-in), and the
 * card is a private catalog row made for this run: the shared catalog is exercised by other specs and
 * `price_snapshots` carries a unique-per-day constraint, so seeding a price on a shared card would be
 * a collision waiting for a parallel worker. The suite is cleaned up in `afterAll`.
 *
 * Determinism. Waits are on visible state or URLs, never on time. The only thing seeded behind the
 * UI's back is the market price (a provider write the app has no UI for), and an FX rate.
 *
 * P210 extends the same account's journey with: a second way to add a holding (the add-to-collection
 * form, without a purchase), the price states a user meets in turn (fresh with provenance, stale,
 * missing, fresh again), the portfolio and financial totals as the SIGNED-IN USER's own RPCs report
 * them (exact minor units, cross-checked against what the page shows), a second invited user who must
 * see none of it, a session whose refresh token no longer works, and finally deletion of this
 * account through the UI. The deletion step runs only against a loopback Supabase stack AND a
 * reachable test registry sink (`assertDisposableTarget`); otherwise it is reported as skipped, never
 * as passed, and `afterAll` removes the account instead.
 */

test.use({ storageState: { cookies: [], origins: [] } })

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
// supabase-js derives its storage key from the first label of the host name.
const STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`

const SUFFIX = randomUUID().slice(0, 8)
const CARD_NAME = `P203 Journey ${SUFFIX}`
const CARD_LOCAL_ID = `p203-journey-${SUFFIX}`
const ADDED_CARD_NAME = `P210 Added ${SUFFIX}`
// Generated per run (the local stack is disposable); never a fixed credential in the repository.
const PASSWORD = `p203-${randomUUID()}`

const QUANTITY = 2
const UNIT_PRICE_INPUT = '50,00'
const TOTAL_MINOR = '10000' // 2 x 50.00 NOK
const PROVIDER_EUR_MINOR = 1000 // EUR 10.00 per card
const EUR_NOK_RATE = '11.50000000'
const MARKET_VALUE = /230,00/ // 2 x EUR 10.00 x 11.5

const service = createServiceClient()
let invitedEmail = ''
let userId = ''
let cardId = ''
let variantId = ''
/** A second private card, added through the add-to-collection form (no purchase). */
let addedCardId = ''
let addedVariantId = ''
/** The second invited person of the isolation step. */
let otherUser: SyntheticUser | undefined

/** A one-row RPC result: every column is a number or a decimal string, compared as text. */
type Totals = Record<string, string | number | null>

const registryUrl = process.env.ERASURE_REGISTRY_URL ?? ''

/**
 * The deletion step is destructive for the account it signs in as, so it runs only when BOTH hold:
 * the Supabase target is a loopback stack, and the erasure registry is a reachable local test sink
 * (the delete-account function refuses every deletion, fail closed, when it is not). Returns the
 * reason it must not run, or null.
 */
async function deletionStepBlocker(): Promise<string | null> {
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]'])
  if (!loopback.has(new URL(supabaseUrl).hostname)) {
    return `SUPABASE_URL host ${new URL(supabaseUrl).hostname} is not loopback`
  }
  if (registryUrl === '') return 'ERASURE_REGISTRY_URL is not set (no test registry sink)'
  const sinkHosts = new Set([...loopback, 'host.docker.internal', '172.17.0.1'])
  const sink = new URL(registryUrl)
  if (!sinkHosts.has(sink.hostname)) return `registry host ${sink.hostname} is not a local sink`
  const local = new URL(registryUrl)
  local.hostname =
    sink.hostname === 'host.docker.internal' || sink.hostname === '172.17.0.1'
      ? '127.0.0.1'
      : sink.hostname
  try {
    await fetch(local, { signal: AbortSignal.timeout(3_000) }) // any HTTP answer: the sink is up
  } catch {
    return `the registry sink at ${local.host} did not answer`
  }
  return null
}

const daysAgo = (n: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

test.beforeAll(async () => {
  const { data: card, error: cardError } = await service
    .from('cards')
    .insert({
      set_id: seedCatalog.cardSetId,
      local_id: CARD_LOCAL_ID,
      name: CARD_NAME,
      language: 'en',
    })
    .select('id')
    .single<{ id: string }>()
  if (cardError) throw new Error(cardError.message)
  cardId = card.id
  const { data: variant, error: variantError } = await service
    .from('card_variants')
    .insert({ card_id: cardId, finish: 'normal', stamp: '', subtype: 'p203', size: 'standard' })
    .select('id')
    .single<{ id: string }>()
  if (variantError) throw new Error(variantError.message)
  variantId = variant.id
  // The second holding is a DIFFERENT card: a second variant of the first one would make the
  // purchase form's catalog search ambiguous (it lists both variants under one name).
  const { data: addedCard, error: addedCardError } = await service
    .from('cards')
    .insert({
      set_id: seedCatalog.cardSetId,
      local_id: `p210-added-${SUFFIX}`,
      name: ADDED_CARD_NAME,
      language: 'en',
    })
    .select('id')
    .single<{ id: string }>()
  if (addedCardError) throw new Error(addedCardError.message)
  addedCardId = addedCard.id
  const { data: added, error: addedError } = await service
    .from('card_variants')
    .insert({
      card_id: addedCardId,
      finish: 'normal',
      stamp: '',
      subtype: 'p210',
      size: 'standard',
    })
    .select('id')
    .single<{ id: string }>()
  if (addedError) throw new Error(addedError.message)
  addedVariantId = added.id

  // A deterministic EUR/NOK rate, old enough that today's snapshot resolves against it.
  const { error: fxError } = await service.from('fx_rates').upsert(
    [
      {
        base_currency: 'EUR',
        quote_currency: 'NOK',
        rate_date: daysAgo(60),
        rate: EUR_NOK_RATE,
        source: 'norges_bank',
      },
    ],
    { onConflict: 'base_currency,quote_currency,rate_date,source' },
  )
  if (fxError) throw new Error(fxError.message)
})

test.afterAll(async () => {
  // The account first: holdings.card_variant_id has no cascade, so the variant cannot go while a
  // holding still points at it.
  if (userId !== '') await deleteSyntheticUser(service, userId)
  if (otherUser) await deleteSyntheticUser(service, otherUser.id)
  for (const id of [variantId, addedVariantId]) {
    if (id === '') continue
    await mustDelete(
      service.from('price_snapshots').delete().eq('card_variant_id', id),
      'journey price_snapshots cleanup',
    )
    await mustDelete(
      service.from('card_variants').delete().eq('id', id),
      'journey card_variants cleanup',
    )
  }
  for (const id of [cardId, addedCardId]) {
    if (id === '') continue
    await mustDelete(service.from('cards').delete().eq('id', id), 'journey cards cleanup')
  }
})

async function signedInHolding(): Promise<{ holdingId: string }> {
  const { data, error } = await service
    .from('holdings')
    .select('id')
    .eq('user_id', userId)
    .eq('card_variant_id', variantId)
    .single<{ id: string }>()
  if (error) throw new Error(`the purchase created no holding: ${error.message}`)
  return { holdingId: data.id }
}

async function lotCostMinor(holdingId: string): Promise<{ unit: string; state: string }> {
  const { data, error } = await service
    .from('acquisition_lots')
    .select('unit_cost_basis_minor::text, cost_basis_state')
    .eq('holding_id', holdingId)
    .is('voided_at', null)
    .single<{ unit_cost_basis_minor: string; cost_basis_state: string }>()
  if (error) throw new Error(error.message)
  return { unit: data.unit_cost_basis_minor, state: data.cost_basis_state }
}

async function expectSignedOutAt(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })
  await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible()
}

test('a new person goes from an invitation to a valued holding, and the session ends cleanly', async ({
  page,
  browser,
}) => {
  test.setTimeout(420_000)

  await test.step('redeem a real invitation and land signed in on Home', async () => {
    const invitation = await createInvitationDirect(service)
    invitedEmail = invitation.email
    await page.goto(`/invite/${invitation.token}`)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByLabel('Confirm password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Create account' }).click()
    await page.waitForURL((url) => url.pathname === '/', { timeout: 20_000 })

    const { data } = await service.auth.admin.listUsers({ perPage: 200 })
    userId = data.users.find((u) => u.email === invitedEmail)?.id ?? ''
    expect(userId, 'the redeemed account exists').not.toBe('')
  })

  await test.step('the empty portfolio is honest: nothing is invented', async () => {
    await page.goto('/portfolio')
    await expect(page.getByText(CARD_NAME)).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  await test.step('search the catalog for the card', async () => {
    await page.goto('/catalog')
    await page.getByLabel('Search for cards').fill(CARD_NAME)
    await expect(page.getByText(CARD_NAME).first()).toBeVisible({ timeout: 20_000 })
  })

  await test.step('record a purchase of two copies through the form', async () => {
    await page.goto('/purchases/new')
    await page.getByLabel('Search catalog').fill(CARD_NAME)
    await page.getByRole('button', { name: new RegExp(CARD_NAME) }).click()
    await page.getByLabel('Quantity').fill(String(QUANTITY))
    await page.getByLabel('Unit price').fill(UNIT_PRICE_INPUT)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}(?:\?created=true)?$/, {
      timeout: 20_000,
    })
    await expect(page.getByText(/100,00/).first()).toBeVisible()

    const purchaseId = /\/purchases\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? ''
    const { data, error } = await service
      .from('purchases')
      .select('total_minor::text')
      .eq('id', purchaseId)
      .single<{ total_minor: string }>()
    if (error) throw new Error(error.message)
    expect(data.total_minor, 'the ledger holds exactly what was typed').toBe(TOTAL_MINOR)
  })

  const { holdingId } = await signedInHolding()

  await test.step('the purchase became a holding, visible in the portfolio, with its cost basis', async () => {
    await page.goto('/portfolio')
    await expect(page.getByText(CARD_NAME).first()).toBeVisible()
    await page.goto(`/portfolio/${holdingId}`)
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()
    const lot = await lotCostMinor(holdingId)
    expect(lot).toEqual({ unit: '5000', state: 'known' })
  })

  await test.step('with no market price the value is absent, not zero', async () => {
    await expect(page.getByText('No market value available yet for this card.')).toBeVisible()
    await expect(page.getByText(MARKET_VALUE)).toHaveCount(0)
    await expect(page.getByText(/Your own estimate, not a market price/)).toHaveCount(0)
  })

  await test.step('a provider price makes a value appear WITH its source, and cost is untouched', async () => {
    const { error } = await service.from('price_snapshots').insert({
      card_variant_id: variantId,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: PROVIDER_EUR_MINOR,
      snapshot_date: daysAgo(1),
      provider_updated_at: new Date().toISOString(),
    })
    if (error) throw new Error(error.message)

    await page.reload()
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Cardmarket, via TCGdex/)).toBeVisible()
    await expect(page.getByText(/Trend/)).toBeVisible()
    await expect(page.getByText(/EUR/)).toBeVisible()
    await expect(page.getByText(/as of /)).toBeVisible()
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()
  })

  await test.step('a price that has not refreshed for ten days is still shown, marked stale, and cost is untouched', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
    const { error } = await service
      .from('price_snapshots')
      .update({ snapshot_date: daysAgo(10), provider_updated_at: tenDaysAgo })
      .eq('card_variant_id', variantId)
    if (error) throw new Error(error.message)
    await page.reload()
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('stale', { exact: true })).toBeVisible()
    await expect(page.getByText(/price hasn.t refreshed recently/)).toBeVisible()
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()
  })

  await test.step('with the price gone the value is absent again, never zero and never the cost', async () => {
    await mustDelete(
      service.from('price_snapshots').delete().eq('card_variant_id', variantId),
      'journey missing-price step',
    )
    await page.reload()
    await expect(page.getByText('No market value available yet for this card.')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(MARKET_VALUE)).toHaveCount(0)
    await expect(page.getByText('stale', { exact: true })).toHaveCount(0)
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()
  })

  await test.step('the price comes back: fresh again, with its source', async () => {
    const { error } = await service.from('price_snapshots').insert({
      card_variant_id: variantId,
      provider: 'tcgdex_cardmarket',
      price_kind: 'cm_trend',
      source_currency: 'EUR',
      value_minor: PROVIDER_EUR_MINOR,
      snapshot_date: daysAgo(1),
      provider_updated_at: new Date().toISOString(),
    })
    if (error) throw new Error(error.message)
    await page.reload()
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(/Cardmarket, via TCGdex/)).toBeVisible()
    await expect(page.getByText('stale', { exact: true })).toHaveCount(0)
  })

  await test.step('a manual valuation replaces the market value but never touches cost', async () => {
    await page.getByLabel('Set manual value (NOK)').fill('2500')
    await page.getByRole('button', { name: 'Set', exact: true }).click()
    await expect(page.getByText(/Your own estimate, not a market price/)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(/Cardmarket, via TCGdex/)).toHaveCount(0)
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()

    expect(await lotCostMinor(holdingId)).toEqual({ unit: '5000', state: 'known' })
    const { data, error } = await service
      .from('purchases')
      .select('total_minor::text')
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    expect(data.map((p) => p.total_minor)).toEqual([TOTAL_MINOR])
  })

  await test.step('returning to market value restores the provider price; cost is still untouched', async () => {
    await page.getByRole('button', { name: 'Return to market value' }).click()
    await expect(page.getByText(/Your own estimate, not a market price/)).toHaveCount(0, {
      timeout: 20_000,
    })
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible()
    await expect(page.getByText(/Cardmarket, via TCGdex/)).toBeVisible()
    expect(await lotCostMinor(holdingId)).toEqual({ unit: '5000', state: 'known' })
  })

  /** The signed-in person's own view of the numbers: the same RPCs the pages call, as that user. */
  const ownTotals = async () => {
    const mine = createAnonClient()
    const { error: signInError } = await mine.auth.signInWithPassword({
      email: invitedEmail,
      password: PASSWORD,
    })
    if (signInError) throw new Error(signInError.message)
    const counts = await mine.rpc('portfolio_counts').single<Totals>()
    if (counts.error) throw new Error(counts.error.message)
    const summary = await mine.rpc('get_dashboard_summary').single<Totals>()
    if (summary.error) throw new Error(summary.error.message)
    await mine.auth.signOut()
    return { counts: counts.data, summary: summary.data }
  }

  await test.step('portfolio and financial totals agree: the page, the own-session RPCs and the ledger', async () => {
    const { counts, summary } = await ownTotals()
    // 2 copies x EUR 10.00 x 11.5 = NOK 230.00 market value; NOK 100.00 paid, none of it hobby.
    expect(String(counts.physical_card_count)).toBe('2')
    expect(String(counts.unique_holding_count)).toBe('1')
    expect(String(counts.priced_holding_count)).toBe('1')
    expect(String(counts.unpriced_holding_count)).toBe('0')
    expect(String(counts.portfolio_value_nok_minor)).toBe('23000')
    expect(String(summary.cs_nok_minor)).toBe(TOTAL_MINOR)
    expect(String(summary.hs_nok_minor)).toBe('0')
    expect(String(summary.gpo_nok_minor)).toBe(TOTAL_MINOR)
    await page.goto('/portfolio')
    await expect(page.getByText(/\b2 cards/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible()
  })

  await test.step('a holding added through the form with unknown cost is counted, unpriced, and costs nothing invented', async () => {
    await page.goto(`/add?variantId=${addedVariantId}`)
    await page.getByLabel('Quantity').fill('3')
    await page
      .getByRole('group', { name: 'Cost' })
      .getByRole('button', { name: 'Unknown', exact: true })
      .click()
    await expect(page.getByText('Recorded with no cost')).toBeVisible()
    await page.getByRole('button', { name: 'Add to collection' }).click()
    // The form returns to the Portfolio list; the new holding is then opened from there.
    await page.waitForURL((url) => url.pathname === '/portfolio', { timeout: 20_000 })
    await expect(page.getByText(ADDED_CARD_NAME).first()).toBeVisible({ timeout: 20_000 })
    const { data: added, error: addedError } = await service
      .from('holdings')
      .select('id')
      .eq('user_id', userId)
      .eq('card_variant_id', addedVariantId)
      .single<{ id: string }>()
    if (addedError) throw new Error(`the add form created no holding: ${addedError.message}`)
    await page.goto(`/portfolio/${added.id}`)
    await expect(page.getByText('No market value available yet for this card.')).toBeVisible()
    await expect(page.getByText('No recorded cost for any lot')).toBeVisible()
    await expect(page.getByText(/Total paid: 0/)).toHaveCount(0)

    const { counts, summary } = await ownTotals()
    expect(String(counts.physical_card_count)).toBe('5')
    expect(String(counts.unique_holding_count)).toBe('2')
    expect(String(counts.priced_holding_count)).toBe('1')
    expect(String(counts.unpriced_holding_count)).toBe('1')
    // The unpriced holding adds nothing to the value, and the unknown cost adds nothing to spend.
    expect(String(counts.portfolio_value_nok_minor)).toBe('23000')
    expect(String(summary.cs_nok_minor)).toBe(TOTAL_MINOR)
    expect(String(summary.uncosted_open_lot_count)).toBe('1')
  })

  await test.step('another invited person sees none of it, in the browser or through the API', async () => {
    const other = await createSyntheticUser(service, 'p210-other')
    otherUser = other
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const otherPage = await context.newPage()
      await otherPage.goto('/login')
      await otherPage.getByLabel('Email').fill(other.email)
      await otherPage.getByLabel('Password').fill(other.password)
      await otherPage.getByRole('button', { name: /sign in/i }).click()
      await otherPage.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })

      await otherPage.goto('/portfolio')
      await expect(otherPage.getByText(CARD_NAME)).toHaveCount(0)
      await otherPage.goto('/purchases')
      await expect(otherPage.getByText(/100,00/)).toHaveCount(0)
      await otherPage.goto(`/portfolio/${holdingId}`)
      await expect(otherPage.getByText(CARD_NAME)).toHaveCount(0)
      await expect(otherPage.getByText(/Total paid/)).toHaveCount(0)
    } finally {
      await context.close()
    }

    // Row-level security, asked directly as the other person.
    const theirs = createAnonClient()
    const { error: signInError } = await theirs.auth.signInWithPassword({
      email: other.email,
      password: other.password,
    })
    if (signInError) throw new Error(signInError.message)
    const holdings = await theirs.from('holdings').select('id').eq('id', holdingId)
    expect(holdings.error).toBeNull()
    expect(holdings.data).toEqual([])
    const lots = await theirs.from('acquisition_lots').select('id').eq('holding_id', holdingId)
    expect(lots.data).toEqual([])
    const theirCounts = await theirs.rpc('portfolio_counts').single<Totals>()
    expect(String(theirCounts.data?.portfolio_value_nok_minor)).toBe('0')
    expect(String(theirCounts.data?.physical_card_count)).toBe('0')
    await theirs.auth.signOut()
  })

  await test.step('signing out ends access: protected routes send the visitor to sign-in', async () => {
    await page.goto('/profile')
    await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 15_000 })
    for (const path of ['/portfolio', `/portfolio/${holdingId}`, '/purchases', '/profile']) {
      await expectSignedOutAt(page, path)
    }
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
    expect(stored, 'no session survives sign-out in this browser').toBeNull()
  })

  await test.step('signing back in finds the data exactly as left', async () => {
    await page.getByLabel('Email').fill(invitedEmail)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    await page.goto(`/portfolio/${holdingId}`)
    await expect(page.getByText(/Total paid: 100,00\s*NOK/)).toBeVisible()
    await expect(page.getByText(MARKET_VALUE).first()).toBeVisible()
  })

  await test.step('an expired session (storage emptied) behaves as signed out, not as a broken page', async () => {
    await page.evaluate((key) => {
      window.localStorage.removeItem(key)
    }, STORAGE_KEY)
    await expectSignedOutAt(page, `/portfolio/${holdingId}`)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  await test.step('a session that is past its expiry with a refresh token the server refuses ends at sign-in, with no stale data left on screen', async () => {
    await page.getByLabel('Email').fill(invitedEmail)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    await page.goto(`/portfolio/${holdingId}`)
    await expect(page.getByText(CARD_NAME).first()).toBeVisible()

    await page.evaluate((key) => {
      const raw = window.localStorage.getItem(key)
      if (raw === null) throw new Error('no stored session to expire')
      const session = JSON.parse(raw) as Record<string, unknown>
      session.expires_at = Math.floor(Date.now() / 1000) - 120
      session.refresh_token = 'revoked-by-the-test'
      window.localStorage.setItem(key, JSON.stringify(session))
    }, STORAGE_KEY)
    await expectSignedOutAt(page, `/portfolio/${holdingId}`)
    await expect(page.getByText(CARD_NAME)).toHaveCount(0)
  })

  await test.step('deleting the account through the UI removes it and everything it owned', async () => {
    const blocker = await deletionStepBlocker()
    if (blocker !== null) {
      // Visible in the report as a skipped step, never counted as exercised.
      test.info().annotations.push({ type: 'deletion-step-skipped', description: blocker })
      return
    }
    await page.getByLabel('Email').fill(invitedEmail)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 })
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Delete account…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
    await expect(dialog).toContainText(invitedEmail)
    await dialog.getByLabel('Your password').fill(PASSWORD)
    await dialog.getByLabel(/I understand this is permanent/).check()
    await dialog.getByRole('button', { name: 'Permanently delete account' }).click()
    await page.waitForURL((url) => url.pathname.startsWith('/login'), { timeout: 60_000 })
    await expect(page.getByText('Your account has been deleted.')).toBeVisible()

    const { data } = await service.auth.admin.getUserById(userId)
    expect(data.user, 'the auth account is gone').toBeNull()
    for (const table of ['holdings', 'acquisition_lots', 'purchases']) {
      const { count, error } = await service
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
      if (error) throw new Error(`${table}: ${error.message}`)
      expect(count, `${table} rows owned by the deleted account`).toBe(0)
    }
    userId = '' // already gone: afterAll must not try again
  })
})
