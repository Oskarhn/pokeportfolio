import { expect, test, type Page } from '@playwright/test'
import { createFixtureHolding, createFixturePurchase, createFixtureSale } from './fixtures'

/**
 * P144 / P130-25 — a blank price field is "no price entered", never a known 0. The same two
 * states are financially different (docs/FINANCIAL_MODEL.md §1.1): a typed 0 is a real, known
 * zero; an empty field is an omission. create_purchase/create_sale require a known price per line,
 * so the client must refuse to submit an empty one — before P144 it silently substituted `'0'`
 * (`draft.unitPrice || '0'`) and the server stored a fabricated known-zero price.
 *
 * Every test drives the REAL form, in the real browser, against the real local database, and
 * asserts on what actually goes over the wire to the RPC (never on internal component state).
 */

const BLANK_PRICE_MESSAGE = /enter a unit price|enter a sale price/i

interface RpcCall {
  body: Record<string, unknown>
}

/** Records every POST to the named RPC. The request is still allowed through to the backend. */
function recordRpc(page: Page, rpcName: string): RpcCall[] {
  const calls: RpcCall[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/rest/v1/rpc/${rpcName}`)) {
      calls.push({ body: request.postDataJSON() as Record<string, unknown> })
    }
  })
  return calls
}

test.describe('Purchase Add — blank vs explicit-zero unit price', () => {
  test('a blank unit price is refused before anything is sent; a typed 0 is submitted as known 0', async ({
    page,
  }) => {
    const calls = recordRpc(page, 'create_purchase')
    await page.goto('/purchases/new')
    await page.getByLabel('Type').selectOption('accessory')
    await page.getByLabel('Description').fill('Deck box')
    // Unit price left blank on purpose.
    await page.getByRole('button', { name: 'Save purchase' }).click()

    await expect(page.getByText(BLANK_PRICE_MESSAGE)).toBeVisible()
    expect(calls).toHaveLength(0)

    await page.getByLabel('Unit price').fill('0')
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}/)
    expect(calls).toHaveLength(1)
    const lines = calls[0]!.body.p_lines as { unit_price_minor: string }[]
    expect(lines[0]!.unit_price_minor).toBe('0')
  })

  test('a whitespace-only unit price is refused like a blank one', async ({ page }) => {
    const calls = recordRpc(page, 'create_purchase')
    await page.goto('/purchases/new')
    await page.getByLabel('Type').selectOption('accessory')
    await page.getByLabel('Description').fill('Sleeves')
    await page.getByLabel('Unit price').fill('   ')
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page.getByText(BLANK_PRICE_MESSAGE)).toBeVisible()
    expect(calls).toHaveLength(0)
  })

  test('the allocation preview does not show a fabricated 0.00 line while the price is blank', async ({
    page,
  }) => {
    await page.goto('/purchases/new')
    await page.getByLabel('Type').selectOption('accessory')
    await page.getByLabel('Description').fill('Binder')
    await expect(page.getByText('Allocation preview')).toHaveCount(0)
    await page.getByLabel('Unit price').fill('12,50')
    await expect(page.getByText('Allocation preview')).toBeVisible()
    await expect(page.getByText('12.50 NOK').first()).toBeVisible()
  })
})

test.describe('Purchase Edit — blank vs explicit-zero unit price', () => {
  test('clearing an existing unit price is refused; typing 0 saves a known 0', async ({ page }) => {
    const { purchaseId } = await createFixturePurchase({ unitPriceMinor: 5000 })
    const calls = recordRpc(page, 'update_purchase')
    await page.goto(`/purchases/${purchaseId}/edit`)
    await page.getByLabel('Unit price').fill('')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(BLANK_PRICE_MESSAGE)).toBeVisible()
    expect(calls).toHaveLength(0)

    await page.getByLabel('Unit price').fill('0')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseId}$`))
    expect(calls).toHaveLength(1)
    const lines = calls[0]!.body.p_lines as { unit_price_minor: string }[]
    expect(lines[0]!.unit_price_minor).toBe('0')
  })
})

test.describe('Sale Add — blank vs explicit-zero sale price', () => {
  test('a blank sale price is refused before anything is sent; a typed 0 is submitted as known 0', async ({
    page,
  }) => {
    const { holdingId } = await createFixtureHolding()
    const calls = recordRpc(page, 'create_sale')
    await page.goto(`/sales/new?holdingId=${holdingId}`)
    await expect(page.getByText(/pikachu/i).first()).toBeVisible({ timeout: 10_000 })
    await page
      .getByLabel(/^Quantity of .* from the lot acquired/)
      .first()
      .fill('1')
    await page.getByLabel('Sale price per unit').fill('')
    await page.getByRole('button', { name: 'Save sale' }).click()
    await expect(page.getByText(BLANK_PRICE_MESSAGE)).toBeVisible()
    expect(calls).toHaveLength(0)

    await page.getByLabel('Sale price per unit').fill('0')
    await page.getByRole('button', { name: 'Save sale' }).click()
    await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}/)
    expect(calls).toHaveLength(1)
    const lines = calls[0]!.body.p_lines as { unit_gross_minor: string }[]
    expect(lines[0]!.unit_gross_minor).toBe('0')
  })
})

test.describe('Sale Edit — blank vs explicit-zero sale price', () => {
  test('clearing an existing sale price is refused; typing 0 saves a known 0', async ({ page }) => {
    const { saleId } = await createFixtureSale()
    const calls = recordRpc(page, 'update_sale')
    await page.goto(`/sales/${saleId}/edit`)
    const price = page.getByLabel(/^Sale price per unit for/)
    await price.fill('')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByText(BLANK_PRICE_MESSAGE)).toBeVisible()
    expect(calls).toHaveLength(0)

    await price.fill('0')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(new RegExp(`/sales/${saleId}$`))
    expect(calls).toHaveLength(1)
    const lines = calls[0]!.body.p_lines as { unit_gross_minor: string }[]
    expect(lines[0]!.unit_gross_minor).toBe('0')
  })
})
