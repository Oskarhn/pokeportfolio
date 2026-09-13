import { supabase } from './supabase-client'
import { parseMinorUnits } from './money'
import type { CardCondition } from './collection'
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
  displayCurrency: string
  defaultLanguage: string | null
  /** Capture default (DATA_MODEL §capture): the add-flow's and the scanner's initial condition.
   *  Null means "no preference stored" — consumers fall back to their own canonical default. */
  defaultCondition: CardCondition | null
  /** Capture default: preselected storage location for new acquisitions. */
  defaultStorageLocationId: string | null
  /** M7.1 §19: the Home/Portfolio value-privacy "eye" preference. Display-only — never changes
   *  what is computed, only whether an honest figure or its mask is rendered. */
  hideValues: boolean
  /** M7.1 §56: "use European pricing when available". Stored ahead of M9 — genuinely inert until
   *  a resolver reads it; never claim it changes a value yet. */
  useEuPricing: boolean
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
  display_currency: string
  default_language: string | null
  default_condition: CardCondition | null
  default_storage_location_id: string | null
  hide_values: boolean
  use_eu_pricing: boolean
}

const SELECT_COLUMNS =
  'id, display_name, is_admin, theme, collection_grid_density, collection_default_view, ' +
  'collection_default_sort, low_value_threshold_minor::text, hide_low_value_by_default, ' +
  'display_currency, default_language, default_condition, default_storage_location_id, ' +
  'hide_values, use_eu_pricing'

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
    displayCurrency: row.display_currency,
    defaultLanguage: row.default_language,
    defaultCondition: row.default_condition,
    defaultStorageLocationId: row.default_storage_location_id,
    hideValues: row.hide_values,
    useEuPricing: row.use_eu_pricing,
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
  displayCurrency?: string
  defaultLanguage?: string | null
  hideValues?: boolean
  useEuPricing?: boolean
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
  if (update.displayCurrency !== undefined) patch.display_currency = update.displayCurrency
  if ('defaultLanguage' in update) patch.default_language = update.defaultLanguage
  if (update.hideValues !== undefined) patch.hide_values = update.hideValues
  if (update.useEuPricing !== undefined) patch.use_eu_pricing = update.useEuPricing

  const { data: userData } = await supabase.auth.getUser()
  const userId = userData.user?.id
  if (!userId) throw new Error('not authenticated')

  const { error } = await supabase
    .from('profiles')
    .update(patch as Database['public']['Tables']['profiles']['Update'])
    .eq('id', userId)
  if (error) throw new Error(error.message)
}
