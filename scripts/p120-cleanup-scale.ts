/**
 * P120 §8/§9/§10 (Gap A): cleanup at scale — dedicated stress that P117 explicitly did not build.
 *
 * Exercises the REAL teardown path (`deleteSyntheticUser`, which calls
 * `deleteNonCascadingUserRows`) against `sealed_products.created_by_user_id` — one of its five
 * batched targets — at increasing row counts, with a sentinel user B present throughout to prove
 * cross-user isolation, plus a fault-injection resume case.
 *
 * Rows are seeded via a direct bulk INSERT under the service role, not through `create_purchase`
 * et al: the cleanup helper's own logic (`deleteByColumnInBatches`) only cares about
 * `created_by_user_id`/row count, not how the rows got there, and generating 10,000+ rows through
 * real RPCs (each its own HTTP round trip enforcing full business validation) would turn this into
 * an hours-long run for no evidence this specific test needs. Business-rule-shaped population is
 * exercised separately (purchase/sale/opening property fuzz).
 *
 * Usage: pnpm exec tsx scripts/p120-cleanup-scale.ts
 */
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  type TestClient,
} from '../tests/db/setup'

const SCALES = [0, 1, 99, 100, 101, 999, 1000, 5000, 10000, 25000]

let requestCount = 0
let maxUrlLength = 0
const originalFetch = globalThis.fetch
function withRequestCounting<T>(fn: () => Promise<T>): Promise<T> {
  requestCount = 0
  maxUrlLength = 0
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requestCount++
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    maxUrlLength = Math.max(maxUrlLength, url.length)
    return originalFetch(input, init)
  }
  return fn().finally(() => {
    globalThis.fetch = originalFetch
  })
}

async function seedSealedProducts(service: TestClient, userId: string, count: number) {
  if (count === 0) return
  const BATCH = 500
  for (let i = 0; i < count; i += BATCH) {
    const n = Math.min(BATCH, count - i)
    const rows = Array.from({ length: n }, (_, j) => ({
      product_type: 'booster_box' as const,
      name: `p120-cleanup-scale ${userId} #${i + j}`,
      language: 'EN',
      created_by_user_id: userId,
    }))
    const { error } = await service.from('sealed_products').insert(rows)
    if (error) throw new Error(`seed failed: ${error.message}`)
  }
}

async function countSealedProducts(service: TestClient, userId: string): Promise<number> {
  const { count, error } = await service
    .from('sealed_products')
    .select('id', { count: 'exact', head: true })
    .eq('created_by_user_id', userId)
  if (error) throw new Error(`count failed: ${error.message}`)
  return count ?? 0
}

async function main() {
  const service = createServiceClient()
  const results: Record<string, unknown>[] = []

  // Sentinel user B: seeded once, checked untouched after EVERY tier below.
  const userB = await createSyntheticUser(service, 'p120-cleanup-sentinel-b')
  const SENTINEL_COUNT = 7
  await seedSealedProducts(service, userB.id, SENTINEL_COUNT)
  const sentinelRowsBefore = await service
    .from('sealed_products')
    .select('id, name')
    .eq('created_by_user_id', userB.id)
    .order('name')
  if (sentinelRowsBefore.error) throw new Error(sentinelRowsBefore.error.message)

  for (const n of SCALES) {
    const userA = await createSyntheticUser(service, `p120-cleanup-a-${n}`)
    await seedSealedProducts(service, userA.id, n)
    const actualSeeded = await countSealedProducts(service, userA.id)

    const start = Date.now()
    await withRequestCounting(() => deleteSyntheticUser(service, userA.id))
    const durationMs = Date.now() - start

    const remainingA = await countSealedProducts(service, userA.id)
    const sentinelRowsAfter = await service
      .from('sealed_products')
      .select('id, name')
      .eq('created_by_user_id', userB.id)
      .order('name')
    if (sentinelRowsAfter.error) throw new Error(sentinelRowsAfter.error.message)
    const sentinelIntact =
      JSON.stringify(sentinelRowsBefore.data) === JSON.stringify(sentinelRowsAfter.data)

    results.push({
      n,
      actualSeeded,
      durationMs,
      requestCount,
      maxUrlLength,
      remainingA,
      sentinelIntact,
    })
    console.log(
      `n=${n} seeded=${actualSeeded} duration=${durationMs}ms requests=${requestCount} maxUrlLen=${maxUrlLength} remainingA=${remainingA} sentinelIntact=${sentinelIntact}`,
    )
  }

  // Interrupt/resume: seed 250 rows, delete HALF of them directly (simulating a crash mid-batch,
  // since deleteByColumnInBatches has no way to tell "interrupted" from "genuinely fewer rows
  // exist" — that IS the property under test: it must not assume a prior run completed or didn't).
  console.log('\n=== interrupt/resume ===')
  const userC = await createSyntheticUser(service, 'p120-cleanup-interrupt-c')
  await seedSealedProducts(service, userC.id, 250)
  const { data: someIds, error: someIdsError } = await service
    .from('sealed_products')
    .select('id')
    .eq('created_by_user_id', userC.id)
    .limit(120)
    .overrideTypes<{ id: string }[], { merge: false }>()
  if (someIdsError) throw new Error(someIdsError.message)
  await service
    .from('sealed_products')
    .delete()
    .in(
      'id',
      someIds.map((r) => r.id),
    )
  const midCount = await countSealedProducts(service, userC.id)
  console.log(`after simulated partial cleanup: ${midCount} rows remain (expected 130)`)
  await deleteSyntheticUser(service, userC.id)
  const finalCount = await countSealedProducts(service, userC.id)
  console.log(`after resumed deleteSyntheticUser: ${finalCount} rows remain (expected 0)`)

  // Re-run deleteSyntheticUser AGAIN on an already-fully-deleted user — must stay idempotent
  // (P107's own documented contract: a 404 from admin.deleteUser is not an error).
  await deleteSyntheticUser(service, userC.id)
  console.log('second deleteSyntheticUser call on an already-gone user: no throw (idempotent)')

  const finalSentinelCheck = await service
    .from('sealed_products')
    .select('id, name')
    .eq('created_by_user_id', userB.id)
    .order('name')
  if (finalSentinelCheck.error) throw new Error(finalSentinelCheck.error.message)
  const sentinelStillIntact =
    JSON.stringify(sentinelRowsBefore.data) === JSON.stringify(finalSentinelCheck.data)
  console.log(`\nsentinel B intact after everything: ${sentinelStillIntact}`)

  await deleteSyntheticUser(service, userB.id)

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(results, null, 2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
