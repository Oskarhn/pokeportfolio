import { supabase } from './supabase-client'
import type { LeasedDb } from './leased-client'

/**
 * Retailers (DATA_MODEL.md §5.2): user-private, deliberately minimal — a name is enough to answer
 * "where did I buy this?" (M8 prompt §65). No address, no organisation registry, no logo.
 */

export interface Retailer {
  id: string
  name: string
  notes: string | null
}

export async function listRetailers(): Promise<Retailer[]> {
  const { data, error } = await supabase.from('retailers').select('id, name, notes').order('name')
  if (error) throw new Error(error.message)
  return data
}

export async function createRetailer(
  name: string,
  db: LeasedDb,
  notes?: string,
): Promise<Retailer> {
  const { data, error } = await db
    .from('retailers')
    .insert({ name, notes: notes ?? null })
    .select('id, name, notes')
    .single()
  if (error) throw new Error(error.message)
  return data
}
