#!/usr/bin/env node
/**
 * One-off P177 fixture setup: creates ONE sealed holding for user B (planned_to_open, quantity 3,
 * known cost) so the device driver's Record Opening screen has something real to act on.
 *
 * This is NOT a raw SQL hack: it calls the exact same `add_card_acquisition` RPC the write seam
 * uses (with `sealedProductId`/`sealedIntent`, the same fields tests/backend/write-seam.test.ts
 * uses for its own create_opening test), through the real backend, as user B, over a real
 * password-authenticated session. The row is deliberately left in place afterwards (unlike the
 * Jest suite's own afterAll cleanup) so the device driver can open it in a later process.
 *
 * Why this exists at all: Price Check only searches CARDS, so there is no UI path in this app to
 * create a sealed holding — `add_card_acquisition` supports one (sealedProductId/sealedIntent),
 * but no screen exposes it. This script stands in for that missing UI, exactly as far as creating
 * the PRECONDITION Record Opening needs — it does not touch the opening RPC itself, which the
 * device driver calls for real through the app.
 *
 *   node scripts/p177/seed-sealed-fixture.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const readJson = (rel) => JSON.parse(readFileSync(join(appRoot, '.local-backend', rel), 'utf8'))
const fixture = readJson('fixture.json')
const pub = readJson('p177/public-env.json')
const B = fixture.users.b

const anon = createClient(pub.apiUrl, pub.publishableKey)
const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
  email: B.email,
  password: B.password,
})
if (signInError) throw new Error(`sign-in failed: ${signInError.message}`)

const client = createClient(pub.apiUrl, pub.publishableKey, {
  global: { headers: { Authorization: `Bearer ${signIn.session.access_token}` } },
})

const sealedProductRow = await client.from('sealed_products').select('id').limit(1).single()
if (sealedProductRow.error)
  throw new Error(`no sealed_products row: ${sealedProductRow.error.message}`)
const sealedProductId = sealedProductRow.data.id

const { data, error } = await client
  .rpc('add_card_acquisition', {
    p_card_variant_id: undefined,
    p_manual_card_id: undefined,
    p_sealed_product_id: sealedProductId,
    p_grading_state: 'raw',
    p_condition: undefined,
    p_grader: undefined,
    p_grade: undefined,
    p_cert_number: undefined,
    p_is_favorite: undefined,
    p_holding_notes: 'P177 synthetic sealed fixture for on-device Record Opening',
    p_origin: 'other',
    p_cost_basis_state: 'known',
    p_unit_cost_basis_minor: '50000',
    p_quantity: 3,
    p_acquired_on: '2026-01-07',
    p_storage_location_id: undefined,
    p_lot_notes: undefined,
    p_manual_value_minor: undefined,
    p_sealed_intent: 'planned_to_open',
    p_client_request_key: crypto.randomUUID(),
  })
  .single()
if (error) throw new Error(`add_card_acquisition failed: ${error.message}`)
console.log(
  `created sealed holding ${data.holding_id} (lot ${data.lot_id}), quantity 3, planned_to_open`,
)
writeFileSync(
  join(appRoot, '.local-backend', 'p177', 'sealed-fixture.json'),
  JSON.stringify({ holdingId: data.holding_id, lotId: data.lot_id }, null, 2),
)
await anon.auth.signOut()
