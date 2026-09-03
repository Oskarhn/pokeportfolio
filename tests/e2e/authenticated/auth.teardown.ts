import { test as teardown } from '@playwright/test'
import { createServiceClient, deleteSyntheticUser } from '../../db/setup'

/**
 * P94 §20 — deletes the synthetic user auth.setup.ts created. Reads the id/email
 * auth.setup.ts persisted (a separate process/spec has no shared in-memory state with setup) and
 * removes it via the same service-role deletion helper every DB test's own `afterAll` uses — no
 * account is left behind between authenticated-E2E runs.
 */
const CREDENTIALS_ENV_FILE = 'playwright/.auth/e2e-user-credentials.json'

async function readCredentials(): Promise<{ id: string; email: string } | null> {
  const fs = await import('node:fs/promises')
  try {
    return JSON.parse(await fs.readFile(CREDENTIALS_ENV_FILE, 'utf-8')) as {
      id: string
      email: string
    }
  } catch {
    // Setup never ran (or already cleaned up) — nothing to tear down.
    return null
  }
}

teardown('delete the synthetic E2E user', async () => {
  const credentials = await readCredentials()
  if (credentials === null) return
  const service = createServiceClient()
  await deleteSyntheticUser(service, credentials.id)
  const fs = await import('node:fs/promises')
  await fs.rm(CREDENTIALS_ENV_FILE, { force: true })
})
