import type { Page } from '@playwright/test'
import { installFakeSession } from './fake-session'

/**
 * P202: a generic network-boundary stand-in for the backend plus a synthetic session, so any private
 * route can be reached in a controlled data state without a database.
 *   empty:   every read succeeds with no rows (single-row reads answer PGRST116)
 *   error:   every backend call fails with HTTP 500
 *   expired: the stored session is already expired and the token endpoint refuses to refresh it
 */
export type DataState = 'empty' | 'error' | 'expired'

export async function installBackend(page: Page, state: DataState): Promise<void> {
  await installFakeSession(page, {
    expiresAtSeconds: state === 'expired' ? Math.floor(Date.now() / 1000) - 60 : undefined,
  })
  await page.route(/\/(rest|functions|auth)\/v1\//, async (route) => {
    const request = route.request()
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const url = new URL(request.url())
    if (url.pathname.includes('/auth/v1/')) {
      return route.fulfill({
        status: 400,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_grant', error_description: 'refresh refused' }),
      })
    }
    if (state === 'error') {
      return route.fulfill({
        status: 500,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'synthetic failure' }),
      })
    }
    const wantsObject = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object')
    if (wantsObject) {
      return route.fulfill({
        status: 406,
        headers: cors,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '', hint: null }),
      })
    }
    return route.fulfill({
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: '[]',
    })
  })
}
