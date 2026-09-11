/**
 * P117 standalone stress harness — purchase idempotency under concurrency.
 *
 * NOT part of `pnpm test:db` or CI. Ad-hoc, like `scanner:visual:benchmark`. Run with:
 *   tsx scripts/p117-purchase-idempotency-stress.ts
 * against a running local Supabase stack (SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY
 * exported, matching tests/db/setup.ts's own contract).
 */
import {
  createServiceClient,
  createSyntheticUser,
  deleteSyntheticUser,
  seedCatalog,
  signInAs,
  type TestClient,
} from '../tests/db/setup'

const today = new Date().toISOString().slice(0, 10)

function sealedArgs(key: string, overrides: Record<string, unknown> = {}) {
  return {
    p_purchased_on: today,
    p_currency: 'NOK',
    p_idempotency_key: key,
    p_lines: [
      {
        line_type: 'sealed',
        sealed_product_id: seedCatalog.sealedProductId,
        quantity: 2,
        unit_price_minor: 5000,
      },
    ],
    ...overrides,
  }
}

async function callCreate(client: TestClient, args: Record<string, unknown>) {
  return client.rpc('create_purchase', args).single<{ id: string; notes: string | null }>()
}

/** Runs `total` calls in waves of at most `concurrency` in flight at once. */
async function runWaves<T>(total: number, concurrency: number, fn: (i: number) => Promise<T>) {
  const results: T[] = []
  for (let start = 0; start < total; start += concurrency) {
    const batch = Math.min(concurrency, total - start)
    const wave = await Promise.all(
      Array.from({ length: batch }, (_, j) => fn(start + j)),
    )
    results.push(...wave)
  }
  return results
}

async function exactReplayLadder(service: TestClient, clientA: TestClient) {
  console.log('\n=== A. Exact-replay ladder (same key, identical payload) ===')
  const totals = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000]
  for (const total of totals) {
    const key = crypto.randomUUID()
    const args = sealedArgs(key)
    const waveSize = Math.min(total, 100) // bounded concurrency waves for large totals
    const t0 = Date.now()
    const results = await runWaves(total, waveSize, () => callCreate(clientA, args))
    const elapsed = Date.now() - t0
    const errors = results.filter((r) => r.error)
    const ids = new Set(results.filter((r) => !r.error).map((r) => r.data!.id))
    const { data: rows } = await service.from('purchases').select('id').eq('idempotency_key', key)
    const { data: lines } = await service
      .from('purchase_lines')
      .select('id')
      .eq('purchase_id', rows?.[0]?.id ?? '00000000-0000-0000-0000-000000000000')
    const { data: lots } = await service
      .from('acquisition_lots')
      .select('id')
      .in('purchase_line_id', (lines ?? []).map((l) => l.id))
    console.log(
      `total=${total} wave=${waveSize} elapsed=${elapsed}ms errors=${errors.length} ` +
        `distinct_ids_returned=${ids.size} purchase_rows=${rows?.length} lines=${lines?.length} lots=${lots?.length}` +
        (errors.length ? ` first_error=${errors[0]!.error!.message}` : ''),
    )
    if (rows?.length !== 1) console.log(`  !! ANOMALY: expected exactly 1 purchase row, got ${rows?.length}`)
    if (ids.size > 1) console.log(`  !! ANOMALY: divergent returned ids: ${[...ids].join(',')}`)
  }
}

async function trueSimultaneousSaturation(service: TestClient, clientA: TestClient) {
  console.log('\n=== B. True simultaneous saturation (no waves, find the local ceiling) ===')
  for (const total of [200, 500, 1000, 2000]) {
    const key = crypto.randomUUID()
    const args = sealedArgs(key)
    const t0 = Date.now()
    const settled = await Promise.allSettled(
      Array.from({ length: total }, () => callCreate(clientA, args)),
    )
    const elapsed = Date.now() - t0
    let ok = 0
    let transportRejections = 0
    const errorMessages = new Map<string, number>()
    const distinctIds = new Set<string>()
    for (const s of settled) {
      if (s.status === 'rejected') {
        transportRejections++
      } else if (s.value.error) {
        errorMessages.set(s.value.error.message, (errorMessages.get(s.value.error.message) ?? 0) + 1)
      } else {
        ok++
        distinctIds.add(s.value.data!.id)
      }
    }
    const { data: rows, count } = await service
      .from('purchases')
      .select('id', { count: 'exact' })
      .eq('idempotency_key', key)
    console.log(
      `total=${total} elapsed=${elapsed}ms ok=${ok} transport_rejections=${transportRejections} ` +
        `distinct_ids_returned=${distinctIds.size} purchase_rows_in_db=${count}`,
    )
    if (rows?.length !== 1) console.log(`  !! ANOMALY: expected exactly 1 purchase row, got ${rows?.length}`)
    if (distinctIds.size > 1) console.log(`  !! ANOMALY: divergent returned ids: ${[...distinctIds].join(',')}`)
    for (const [msg, n] of errorMessages) console.log(`  error x${n}: ${msg}`)
    if (transportRejections > total * 0.5) {
      console.log(`  local transport ceiling reached around total=${total}; stopping saturation ladder`)
      break
    }
  }
}

async function materialMismatchMatrix(clientA: TestClient) {
  console.log('\n=== C. Changed-payload reuse (material vs non-material) ===')
  const cases: { label: string; overrides: Record<string, unknown>; expectRejected: boolean }[] = [
    { label: 'identical (control)', overrides: {}, expectRejected: false },
    { label: 'different notes (non-material)', overrides: { p_notes: 'edited' }, expectRejected: false },
    {
      label: 'different amount (material)',
      overrides: {
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 2,
            unit_price_minor: 9999,
          },
        ],
      },
      expectRejected: true,
    },
    { label: 'different date (material)', overrides: { p_purchased_on: '2020-01-01' }, expectRejected: true },
    { label: 'different currency (material)', overrides: { p_currency: 'EUR', p_fx_rate_to_nok: '11.5', p_fx_rate_date: today, p_fx_source: 'manual' }, expectRejected: true },
    {
      label: 'different quantity (material)',
      overrides: {
        p_lines: [
          {
            line_type: 'sealed',
            sealed_product_id: seedCatalog.sealedProductId,
            quantity: 3,
            unit_price_minor: 5000,
          },
        ],
      },
      expectRejected: true,
    },
  ]
  for (const c of cases) {
    const key = crypto.randomUUID()
    const { error: firstError } = await callCreate(clientA, sealedArgs(key))
    if (firstError) {
      console.log(`  ${c.label}: SETUP FAILED — ${firstError.message}`)
      continue
    }
    const { data, error } = await callCreate(clientA, sealedArgs(key, c.overrides))
    const rejected = !!error
    const match = rejected === c.expectRejected
    console.log(
      `  ${c.label}: expected_rejected=${c.expectRejected} actual_rejected=${rejected} ` +
        `${match ? 'OK' : '!! MISMATCH'} ${error ? `(${error.message})` : `(id=${data?.id})`}`,
    )
  }
}

async function abortedRequestRetry(service: TestClient, clientA: TestClient) {
  console.log('\n=== D. Client aborts before/during response, then retries with the same key ===')
  const {
    data: { session },
  } = await clientA.auth.getSession()
  const url = `${process.env.SUPABASE_URL}/rest/v1/rpc/create_purchase`
  const anonKey = process.env.SUPABASE_ANON_KEY!
  for (const abortAfterMs of [0, 5, 15, 40]) {
    const key = crypto.randomUUID()
    const args = sealedArgs(key)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), abortAfterMs)
    let aborted = false
    try {
      await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: `Bearer ${session!.access_token}`,
        },
        body: JSON.stringify(args),
      })
    } catch {
      aborted = true
    }
    // Give the server time to finish committing (or not) the aborted request in the background —
    // the client gave up, but the transaction it started may still complete server-side.
    await new Promise((r) => setTimeout(r, 300))
    const { data: retry, error: retryError } = await callCreate(clientA, args)
    const { count } = await service
      .from('purchases')
      .select('id', { count: 'exact', head: true })
      .eq('idempotency_key', key)
    console.log(
      `abortAfterMs=${abortAfterMs} clientSawAbort=${aborted} retryError=${retryError?.message ?? 'none'} ` +
        `retryReturnedId=${retry?.id ?? 'n/a'} purchase_rows_in_db=${count}`,
    )
    if (count !== 1) console.log(`  !! ANOMALY: expected exactly 1 purchase row after abort+retry, got ${count}`)
  }
}

async function main() {
  const service = createServiceClient()
  const userA = await createSyntheticUser(service, 'p117-idem-stress')
  const clientA = await signInAs(userA)
  try {
    await exactReplayLadder(service, clientA)
    await trueSimultaneousSaturation(service, clientA)
    await materialMismatchMatrix(clientA)
    await abortedRequestRetry(service, clientA)
  } finally {
    await deleteSyntheticUser(service, userA.id)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
