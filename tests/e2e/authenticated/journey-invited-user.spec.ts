import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import {
  createInvitationDirect,
  createServiceClient,
  deleteSyntheticUser,
  mustDelete,
  seedCatalog,
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
 */

test.use({ storageState: { cookies: [], origins: [] } })

const supabaseUrl = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
// supabase-js derives its storage key from the first label of the host name.
const STORAGE_KEY = `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`

const SUFFIX = randomUUID().slice(0, 8)
const CARD_NAME = `P203 Journey ${SUFFIX}`
const CARD_LOCAL_ID = `p203-journey-${SUFFIX}`
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
  if (variantId !== '') {
    await mustDelete(
      service.from('price_snapshots').delete().eq('card_variant_id', variantId),
      'journey price_snapshots cleanup',
    )
    await mustDelete(
      service.from('card_variants').delete().eq('id', variantId),
      'journey card_variants cleanup',
    )
  }
  if (cardId !== '') {
    await mustDelete(service.from('cards').delete().eq('id', cardId), 'journey cards cleanup')
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
}) => {
  test.setTimeout(240_000)

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
})
