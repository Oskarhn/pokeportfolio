import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { Database } from './database.types'

/**
 * The signed-in user's own profile row (DATA_MODEL.md §5.1) — display preferences, Portfolio
 * defaults and account identity. `is_admin`/`id`/`created_at`/`disabled_at` are read-only here on
 * purpose: the column-level UPDATE grant excludes them at the SQL privilege level regardless of
 * what this layer sends (SECURITY.md §5.9).
 */

export type ThemePreference = Database['public']['Enums']['theme_preference']
export type CollectionView = Database['public']['Enums']['collection_view']

export interface Profile {
  id: string
  displayName: string | null
  isAdmin: boolean
  theme: ThemePreference
  collectionGridDensity: number
  collectionDefaultView: CollectionView
  collectionDefaultSort: Database['public']['Enums']['portfolio_sort_order']
  lowValueThresholdMinor: bigint
  hideLowValueByDefault: boolean
}

interface ProfileRow {
  id: string
  display_name: string | null
  is_admin: boolean
  theme: ThemePreference
  collection_grid_density: number
  collection_default_view: CollectionView
  collection_default_sort: Database['public']['Enums']['portfolio_sort_order']
  low_value_threshold_minor: string
  hide_low_value_by_default: boolean
}

const SELECT_COLUMNS =
  'id, display_name, is_admin, theme, collection_grid_density, collection_default_view, ' +
  'collection_default_sort, low_value_threshold_minor::text, hide_low_value_by_default'

function mapProfile(row: ProfileRow): Profile {
  return {
    id: row.id,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    theme: row.theme,
    collectionGridDensity: row.collection_grid_density,
    collectionDefaultView: row.collection_default_view,
    collectionDefaultSort: row.collection_default_sort,
    lowValueThresholdMinor: parseMinorUnits(row.low_value_threshold_minor),
    hideLowValueByDefault: row.hide_low_value_by_default,
  }
}

export async function getMyProfile(): Promise<Profile> {
  const { data, error } = await supabase
    .from('profiles')
    .select(SELECT_COLUMNS)
    .single()
    .overrideTypes<ProfileRow, { merge: false }>()
  if (error) throw new Error(error.message)
  return mapProfile(data)
}

export interface ProfileUpdate {
  displayName?: string | null
  theme?: ThemePreference
  collectionGridDensity?: number
  collectionDefaultView?: CollectionView
  collectionDefaultSort?: Database['public']['Enums']['portfolio_sort_order']
  lowValueThresholdMinor?: bigint
  hideLowValueByDefault?: boolean
}

export async function updateMyProfile(update: ProfileUpdate): Promise<void> {
  const patch: Record<string, unknown> = {}
  if ('displayName' in update) patch.display_name = update.displayName
  if (update.theme !== undefined) patch.theme = update.theme
  if (update.collectionGridDensity !== undefined) {
    patch.collection_grid_density = update.collectionGridDensity
  }
  if (update.collectionDefaultView !== undefined) {
    patch.collection_default_view = update.collectionDefaultView
  }
  if (update.collectionDefaultSort !== undefined) {
    patch.collection_default_sort = update.collectionDefaultSort
  }
  if (update.lowValueThresholdMinor !== undefined) {
    patch.low_value_threshold_minor = Number(update.lowValueThresholdMinor)
  }
  if (update.hideLowValueByDefault !== undefined) {
    patch.hide_low_value_by_default = update.hideLowValueByDefault
  }

  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('not authenticated')

  const { error } = await supabase
    .from('profiles')
    .update(patch as Database['public']['Tables']['profiles']['Update'])
    .eq('id', userId)
  if (error) throw new Error(error.message)
}
