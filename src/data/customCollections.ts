import { supabase } from './supabase-client'

/**
 * Custom collections: user-defined, playlist-like groups (DATA_MODEL.md §5.2.1). Plain owner-RLS
 * table access — no RPC layer, since every operation here is exactly what RLS + WITH CHECK is for
 * (M7 prompt §74). Membership is purely organisational (invariant C1): nothing here ever touches
 * ownership, cost basis or storage.
 */

export interface CustomCollection {
  id: string
  name: string
  description: string | null
  sortOrder: number
  color: string | null
  createdAt: string
}

export async function listCustomCollections(): Promise<CustomCollection[]> {
  const { data, error } = await supabase
    .from('custom_collections')
    .select('id, name, description, sort_order, color, created_at')
    .order('sort_order')
    .order('name')
  if (error) throw new Error(error.message)
  return data.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    color: row.color,
    createdAt: row.created_at,
  }))
}

export async function createCustomCollection(input: {
  name: string
  description?: string
}): Promise<CustomCollection> {
  const { data, error } = await supabase
    .from('custom_collections')
    .insert({ name: input.name, description: input.description ?? null })
    .select('id, name, description, sort_order, color, created_at')
    .single()
  if (error) throw new Error(error.message)
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    sortOrder: data.sort_order,
    color: data.color,
    createdAt: data.created_at,
  }
}

export async function renameCustomCollection(
  id: string,
  input: { name: string; description?: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('custom_collections')
    .update({ name: input.name, description: input.description })
    .eq('id', id)
  if (error) throw new Error(error.message)
}

/** Removes the collection and, via `on delete cascade`, its membership rows only — invariant C1:
 *  no holding, lot or transaction is ever affected (DATA_MODEL.md §5.2.1). */
export async function deleteCustomCollection(id: string): Promise<void> {
  const { error } = await supabase.from('custom_collections').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function addHoldingToCollection(
  collectionId: string,
  holdingId: string,
): Promise<void> {
  const { error } = await supabase
    .from('custom_collection_members')
    .insert({ collection_id: collectionId, holding_id: holdingId })
  if (error) throw new Error(error.message)
}

export async function removeHoldingFromCollection(
  collectionId: string,
  holdingId: string,
): Promise<void> {
  const { error } = await supabase
    .from('custom_collection_members')
    .delete()
    .eq('collection_id', collectionId)
    .eq('holding_id', holdingId)
  if (error) throw new Error(error.message)
}

/** Which collections a single holding currently belongs to — used by the holding detail page and
 *  the "add to collection" action sheet to show current membership. */
export async function getHoldingCollectionIds(holdingId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('custom_collection_members')
    .select('collection_id')
    .eq('holding_id', holdingId)
  if (error) throw new Error(error.message)
  return data.map((row) => row.collection_id)
}
