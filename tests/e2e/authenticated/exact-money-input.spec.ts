import { expect, test, type Page } from '@playwright/test'
import { signInAsE2eUser } from './fixtures'

/**
 * P146 / P130-19 — a typed amount above 2^53 minor units is stored, and shown, exactly.
 *
 * The audit's original browser reproduction (output_130.txt, "typed 90071992547409,93 -> sent
 * ...992"): 90 071 992 547 409,93 kr is 9007199254740993 minor units, the first integer a
 * JavaScript number cannot hold. The released client converted it with `Number()` and the server
 * stored 9007199254740992. This drives the REAL purchase form in the real browser against the real
 * local database and checks three things independently: what went over the wire (a decimal string,
 * never a JSON number), what the ledger stored, and what the page shows.
 */

const TYPED = '90071992547409,93'
const EXACT_MINOR = '9007199254740993'
// nb-NO groups with a (narrow) no-break space; \s matches both.
const EXACT_DISPLAY = /90\s071\s992\s547\s409,93/

function recordRpc(page: Page, rpcName: string): { body: Record<string, unknown> }[] {
  const calls: { body: Record<string, unknown> }[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/rest/v1/rpc/${rpcName}`)) {
      calls.push({ body: request.postDataJSON() as Record<string, unknown> })
    }
  })
  return calls
}

async function storedTotalMinor(purchaseId: string): Promise<string> {
  const client = await signInAsE2eUser()
  const { data, error } = await client
    .from('purchases')
    .select('total_minor::text')
    .eq('id', purchaseId)
    .single()
  if (error) throw new Error(error.message)
  return data.total_minor
}

test.describe('Purchase form — an amount above 2^53 minor units', () => {
  test('is sent as text, stored exactly, and shown exactly; an edit keeps it exact', async ({
    page,
  }) => {
    const created = recordRpc(page, 'create_purchase')
    await page.goto('/purchases/new')
    await page.getByLabel('Type').selectOption('accessory')
    await page.getByLabel('Description').fill('P146 exact amount')
    await page.getByLabel('Unit price').fill(TYPED)
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}(?:\?created=true)?$/)

    expect(created).toHaveLength(1)
    const lines = created[0]!.body.p_lines as { unit_price_minor: unknown }[]
    expect(lines[0]!.unit_price_minor).toBe(EXACT_MINOR)
    expect(typeof lines[0]!.unit_price_minor).toBe('string')

    const purchaseId = /\/purchases\/([0-9a-f-]{36})/.exec(page.url())![1]!
    expect(await storedTotalMinor(purchaseId)).toBe(EXACT_MINOR)
    await expect(page.getByText(EXACT_DISPLAY).first()).toBeVisible()

    // Editing without touching the price re-sends the read-back value: it must not drift.
    const updated = recordRpc(page, 'update_purchase')
    await page.goto(`/purchases/${purchaseId}/edit`)
    await expect(page.getByLabel('Unit price')).toHaveValue(
      /90[\s ]?071[\s ]?992[\s ]?547[\s ]?409[.,]93|90071992547409[.,]93/,
    )
    await page.getByLabel('Notes').fill('unchanged amount')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page).toHaveURL(new RegExp(`/purchases/${purchaseId}$`))
    expect(updated).toHaveLength(1)
    const sent = (updated[0]!.body.p_lines as { unit_price_minor: unknown }[])[0]!
    expect(sent.unit_price_minor).toBe(EXACT_MINOR)
    expect(await storedTotalMinor(purchaseId)).toBe(EXACT_MINOR)
  })

  test('an amount the ledger cannot hold is refused with a message, and nothing is sent', async ({
    page,
  }) => {
    const created = recordRpc(page, 'create_purchase')
    await page.goto('/purchases/new')
    await page.getByLabel('Type').selectOption('accessory')
    await page.getByLabel('Description').fill('P146 too large')
    // 10^17 kr = 10^19 minor units, above the 9.22 x 10^18 a bigint holds.
    await page.getByLabel('Unit price').fill('100000000000000000')
    await page.getByRole('button', { name: 'Save purchase' }).click()
    await expect(page.getByRole('alert')).toContainText(/outside the supported money range/i)
    expect(created).toHaveLength(0)
  })
})
