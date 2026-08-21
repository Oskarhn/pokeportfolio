export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      acquisition_lots: {
        Row: {
          acquired_on: string
          cost_basis_currency: string | null
          cost_basis_state: Database["public"]["Enums"]["cost_basis_state"]
          created_at: string
          holding_id: string
          id: string
          notes: string | null
          origin: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id: string | null
          quantity: number
          quantity_remaining: number
          residual_minor: number
          storage_location_id: string | null
          unit_cost_basis_minor: number | null
          unit_cost_basis_nok_minor: number | null
          user_id: string
          voided_at: string | null
        }
        Insert: {
          acquired_on: string
          cost_basis_currency?: string | null
          cost_basis_state: Database["public"]["Enums"]["cost_basis_state"]
          created_at?: string
          holding_id: string
          id?: string
          notes?: string | null
          origin: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id?: string | null
          quantity: number
          quantity_remaining: number
          residual_minor?: number
          storage_location_id?: string | null
          unit_cost_basis_minor?: number | null
          unit_cost_basis_nok_minor?: number | null
          user_id: string
          voided_at?: string | null
        }
        Update: {
          acquired_on?: string
          cost_basis_currency?: string | null
          cost_basis_state?: Database["public"]["Enums"]["cost_basis_state"]
          created_at?: string
          holding_id?: string
          id?: string
          notes?: string | null
          origin?: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id?: string | null
          quantity?: number
          quantity_remaining?: number
          residual_minor?: number
          storage_location_id?: string | null
          unit_cost_basis_minor?: number | null
          unit_cost_basis_nok_minor?: number | null
          user_id?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "acquisition_lots_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "acquisition_lots_purchase_line_id_fkey"
            columns: ["purchase_line_id"]
            isOneToOne: false
            referencedRelation: "purchase_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "acquisition_lots_storage_location_id_fkey"
            columns: ["storage_location_id"]
            isOneToOne: false
            referencedRelation: "storage_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      card_series: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          language: string
          last_seen_at: string | null
          name: string
          slug: string
          tcgdex_series_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          language: string
          last_seen_at?: string | null
          name: string
          slug: string
          tcgdex_series_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          last_seen_at?: string | null
          name?: string
          slug?: string
          tcgdex_series_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      card_sets: {
        Row: {
          card_count_official: number | null
          card_count_total: number | null
          created_at: string
          id: string
          is_active: boolean
          language: string
          last_seen_at: string | null
          logo_url: string | null
          name: string
          released_on: string | null
          series_id: string
          slug: string
          symbol_url: string | null
          tcgdex_set_id: string | null
          updated_at: string
        }
        Insert: {
          card_count_official?: number | null
          card_count_total?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          language: string
          last_seen_at?: string | null
          logo_url?: string | null
          name: string
          released_on?: string | null
          series_id: string
          slug: string
          symbol_url?: string | null
          tcgdex_set_id?: string | null
          updated_at?: string
        }
        Update: {
          card_count_official?: number | null
          card_count_total?: number | null
          created_at?: string
          id?: string
          is_active?: boolean
          language?: string
          last_seen_at?: string | null
          logo_url?: string | null
          name?: string
          released_on?: string | null
          series_id?: string
          slug?: string
          symbol_url?: string | null
          tcgdex_set_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_sets_series_id_fkey"
            columns: ["series_id"]
            isOneToOne: false
            referencedRelation: "card_series"
            referencedColumns: ["id"]
          },
        ]
      }
      card_variants: {
        Row: {
          card_id: string
          cardmarket_product_id: string | null
          created_at: string
          finish: Database["public"]["Enums"]["card_finish"]
          id: string
          is_active: boolean
          last_seen_at: string | null
          size: Database["public"]["Enums"]["card_size"]
          stamp: string
          subtype: string
          tcgdex_variant_id: string | null
          tcgplayer_product_id: string | null
          updated_at: string
        }
        Insert: {
          card_id: string
          cardmarket_product_id?: string | null
          created_at?: string
          finish: Database["public"]["Enums"]["card_finish"]
          id?: string
          is_active?: boolean
          last_seen_at?: string | null
          size?: Database["public"]["Enums"]["card_size"]
          stamp?: string
          subtype?: string
          tcgdex_variant_id?: string | null
          tcgplayer_product_id?: string | null
          updated_at?: string
        }
        Update: {
          card_id?: string
          cardmarket_product_id?: string | null
          created_at?: string
          finish?: Database["public"]["Enums"]["card_finish"]
          id?: string
          is_active?: boolean
          last_seen_at?: string | null
          size?: Database["public"]["Enums"]["card_size"]
          stamp?: string
          subtype?: string
          tcgdex_variant_id?: string | null
          tcgplayer_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_variants_card_id_fkey"
            columns: ["card_id"]
            isOneToOne: false
            referencedRelation: "cards"
            referencedColumns: ["id"]
          },
        ]
      }
      cards: {
        Row: {
          category: string | null
          created_at: string
          id: string
          illustrator: string | null
          image_base_url: string | null
          is_active: boolean
          language: string
          last_seen_at: string | null
          local_id: string
          name: string
          rarity: string | null
          set_id: string
          tcgdex_card_id: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          illustrator?: string | null
          image_base_url?: string | null
          is_active?: boolean
          language: string
          last_seen_at?: string | null
          local_id: string
          name: string
          rarity?: string | null
          set_id: string
          tcgdex_card_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          illustrator?: string | null
          image_base_url?: string | null
          is_active?: boolean
          language?: string
          last_seen_at?: string | null
          local_id?: string
          name?: string
          rarity?: string | null
          set_id?: string
          tcgdex_card_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cards_set_id_fkey"
            columns: ["set_id"]
            isOneToOne: false
            referencedRelation: "card_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      catalog_sync_runs: {
        Row: {
          cards_seen: number
          cards_upserted: number
          error: string | null
          finished_at: string | null
          id: number
          language: string
          started_at: string
          status: string
          tcgdex_series_id: string | null
          tcgdex_set_id: string
          variants_upserted: number
        }
        Insert: {
          cards_seen?: number
          cards_upserted?: number
          error?: string | null
          finished_at?: string | null
          id?: never
          language: string
          started_at?: string
          status: string
          tcgdex_series_id?: string | null
          tcgdex_set_id: string
          variants_upserted?: number
        }
        Update: {
          cards_seen?: number
          cards_upserted?: number
          error?: string | null
          finished_at?: string | null
          id?: never
          language?: string
          started_at?: string
          status?: string
          tcgdex_series_id?: string | null
          tcgdex_set_id?: string
          variants_upserted?: number
        }
        Relationships: []
      }
      holdings: {
        Row: {
          card_variant_id: string | null
          cert_number: string | null
          condition: Database["public"]["Enums"]["card_condition"] | null
          created_at: string
          deleted_at: string | null
          grade: number | null
          grader: Database["public"]["Enums"]["grader"] | null
          grading_state: Database["public"]["Enums"]["grading_state"]
          holding_kind: Database["public"]["Enums"]["holding_kind"]
          id: string
          is_favorite: boolean
          manual_card_id: string | null
          notes: string | null
          sealed_intent: Database["public"]["Enums"]["sealed_intent"] | null
          sealed_product_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          card_variant_id?: string | null
          cert_number?: string | null
          condition?: Database["public"]["Enums"]["card_condition"] | null
          created_at?: string
          deleted_at?: string | null
          grade?: number | null
          grader?: Database["public"]["Enums"]["grader"] | null
          grading_state?: Database["public"]["Enums"]["grading_state"]
          holding_kind: Database["public"]["Enums"]["holding_kind"]
          id?: string
          is_favorite?: boolean
          manual_card_id?: string | null
          notes?: string | null
          sealed_intent?: Database["public"]["Enums"]["sealed_intent"] | null
          sealed_product_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          card_variant_id?: string | null
          cert_number?: string | null
          condition?: Database["public"]["Enums"]["card_condition"] | null
          created_at?: string
          deleted_at?: string | null
          grade?: number | null
          grader?: Database["public"]["Enums"]["grader"] | null
          grading_state?: Database["public"]["Enums"]["grading_state"]
          holding_kind?: Database["public"]["Enums"]["holding_kind"]
          id?: string
          is_favorite?: boolean
          manual_card_id?: string | null
          notes?: string | null
          sealed_intent?: Database["public"]["Enums"]["sealed_intent"] | null
          sealed_product_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holdings_card_variant_id_fkey"
            columns: ["card_variant_id"]
            isOneToOne: false
            referencedRelation: "card_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "holdings_manual_card_id_fkey"
            columns: ["manual_card_id"]
            isOneToOne: false
            referencedRelation: "manual_card_definitions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "holdings_sealed_product_id_fkey"
            columns: ["sealed_product_id"]
            isOneToOne: false
            referencedRelation: "sealed_products"
            referencedColumns: ["id"]
          },
        ]
      }
      holding_tags: {
        Row: {
          created_at: string
          holding_id: string
          tag_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          holding_id: string
          tag_id: string
          user_id?: string
        }
        Update: {
          created_at?: string
          holding_id?: string
          tag_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "holding_tags_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "holding_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      manual_card_definitions: {
        Row: {
          collector_number: string | null
          created_at: string
          finish: string | null
          id: string
          language: string | null
          name: string
          notes: string | null
          set_name: string | null
          size: Database["public"]["Enums"]["card_size"] | null
          stamp: string | null
          subtype: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          collector_number?: string | null
          created_at?: string
          finish?: string | null
          id?: string
          language?: string | null
          name: string
          notes?: string | null
          set_name?: string | null
          size?: Database["public"]["Enums"]["card_size"] | null
          stamp?: string | null
          subtype?: string | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          collector_number?: string | null
          created_at?: string
          finish?: string | null
          id?: string
          language?: string | null
          name?: string
          notes?: string | null
          set_name?: string | null
          size?: Database["public"]["Enums"]["card_size"] | null
          stamp?: string | null
          subtype?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      manual_valuations: {
        Row: {
          created_at: string
          currency: string
          effective_from: string
          holding_id: string
          id: string
          note: string | null
          superseded_at: string | null
          user_id: string
          value_minor: number
          value_nok_minor: number
        }
        Insert: {
          created_at?: string
          currency?: string
          effective_from?: string
          holding_id: string
          id?: string
          note?: string | null
          superseded_at?: string | null
          user_id: string
          value_minor: number
          value_nok_minor: number
        }
        Update: {
          created_at?: string
          currency?: string
          effective_from?: string
          holding_id?: string
          id?: string
          note?: string | null
          superseded_at?: string | null
          user_id?: string
          value_minor?: number
          value_nok_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "manual_valuations_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
        ]
      }
      invitation_claims: {
        Row: {
          consumed_at: string | null
          consumed_user_id: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invitation_id: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_user_id?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          invitation_id: string
        }
        Update: {
          consumed_at?: string | null
          consumed_user_id?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invitation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitation_claims_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitation_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_claims_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
        ]
      }
      invitation_redemptions: {
        Row: {
          id: string
          invitation_id: string
          redeemed_at: string
          user_id: string
        }
        Insert: {
          id?: string
          invitation_id: string
          redeemed_at?: string
          user_id: string
        }
        Update: {
          id?: string
          invitation_id?: string
          redeemed_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invitation_redemptions_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitation_overview"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invitation_redemptions_invitation_id_fkey"
            columns: ["invitation_id"]
            isOneToOne: false
            referencedRelation: "invitations"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          created_at: string
          created_by: string | null
          email: string
          expires_at: string
          id: string
          label: string | null
          max_uses: number
          revoked_at: string | null
          token_hash: string
          use_count: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          email: string
          expires_at: string
          id?: string
          label?: string | null
          max_uses?: number
          revoked_at?: string | null
          token_hash: string
          use_count?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          email?: string
          expires_at?: string
          id?: string
          label?: string | null
          max_uses?: number
          revoked_at?: string | null
          token_hash?: string
          use_count?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          collection_default_view: Database["public"]["Enums"]["collection_view"]
          collection_grid_density: number
          created_at: string
          default_condition:
            | Database["public"]["Enums"]["card_condition"]
            | null
          default_language: string | null
          default_storage_location_id: string | null
          disabled_at: string | null
          display_currency: string
          display_name: string | null
          hide_low_value_by_default: boolean
          id: string
          is_admin: boolean
          locale: string
          low_value_threshold_minor: number
          theme: Database["public"]["Enums"]["theme_preference"]
          updated_at: string
        }
        Insert: {
          collection_default_view?: Database["public"]["Enums"]["collection_view"]
          collection_grid_density?: number
          created_at?: string
          default_condition?:
            | Database["public"]["Enums"]["card_condition"]
            | null
          default_language?: string | null
          default_storage_location_id?: string | null
          disabled_at?: string | null
          display_currency?: string
          display_name?: string | null
          hide_low_value_by_default?: boolean
          id: string
          is_admin?: boolean
          locale?: string
          low_value_threshold_minor?: number
          theme?: Database["public"]["Enums"]["theme_preference"]
          updated_at?: string
        }
        Update: {
          collection_default_view?: Database["public"]["Enums"]["collection_view"]
          collection_grid_density?: number
          created_at?: string
          default_condition?:
            | Database["public"]["Enums"]["card_condition"]
            | null
          default_language?: string | null
          default_storage_location_id?: string | null
          disabled_at?: string | null
          display_currency?: string
          display_name?: string | null
          hide_low_value_by_default?: boolean
          id?: string
          is_admin?: boolean
          locale?: string
          low_value_threshold_minor?: number
          theme?: Database["public"]["Enums"]["theme_preference"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_default_storage_location_id_fkey"
            columns: ["default_storage_location_id"]
            isOneToOne: false
            referencedRelation: "storage_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_lines: {
        Row: {
          allocated_customs_minor: number
          allocated_discount_minor: number
          allocated_shipping_minor: number
          attributable_cost_minor: number
          attributable_cost_nok_minor: number
          card_variant_id: string | null
          condition: Database["public"]["Enums"]["card_condition"] | null
          created_at: string
          description: string | null
          id: string
          line_total_minor: number
          line_type: Database["public"]["Enums"]["line_type"]
          purchase_id: string
          quantity: number
          sealed_product_id: string | null
          spend_class: Database["public"]["Enums"]["spend_class"]
          unit_price_minor: number
          updated_at: string
          user_id: string
        }
        Insert: {
          allocated_customs_minor?: number
          allocated_discount_minor?: number
          allocated_shipping_minor?: number
          attributable_cost_minor?: number
          attributable_cost_nok_minor?: number
          card_variant_id?: string | null
          condition?: Database["public"]["Enums"]["card_condition"] | null
          created_at?: string
          description?: string | null
          id?: string
          line_total_minor: number
          line_type: Database["public"]["Enums"]["line_type"]
          purchase_id: string
          quantity: number
          sealed_product_id?: string | null
          spend_class: Database["public"]["Enums"]["spend_class"]
          unit_price_minor: number
          updated_at?: string
          user_id: string
        }
        Update: {
          allocated_customs_minor?: number
          allocated_discount_minor?: number
          allocated_shipping_minor?: number
          attributable_cost_minor?: number
          attributable_cost_nok_minor?: number
          card_variant_id?: string | null
          condition?: Database["public"]["Enums"]["card_condition"] | null
          created_at?: string
          description?: string | null
          id?: string
          line_total_minor?: number
          line_type?: Database["public"]["Enums"]["line_type"]
          purchase_id?: string
          quantity?: number
          sealed_product_id?: string | null
          spend_class?: Database["public"]["Enums"]["spend_class"]
          unit_price_minor?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_lines_card_variant_id_fkey"
            columns: ["card_variant_id"]
            isOneToOne: false
            referencedRelation: "card_variants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_lines_purchase_id_fkey"
            columns: ["purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_lines_sealed_product_id_fkey"
            columns: ["sealed_product_id"]
            isOneToOne: false
            referencedRelation: "sealed_products"
            referencedColumns: ["id"]
          },
        ]
      }
      purchases: {
        Row: {
          created_at: string
          currency: string
          customs_minor: number
          discount_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          id: string
          notes: string | null
          origin: Database["public"]["Enums"]["purchase_origin"]
          purchased_on: string
          retailer_id: string | null
          shipping_minor: number
          subtotal_minor: number
          total_minor: number
          total_nok_minor: number
          updated_at: string
          user_id: string
          voided_at: string | null
        }
        Insert: {
          created_at?: string
          currency: string
          customs_minor?: number
          discount_minor?: number
          fx_rate_date: string
          fx_rate_to_nok?: number
          fx_source?: Database["public"]["Enums"]["fx_source"]
          id?: string
          notes?: string | null
          origin?: Database["public"]["Enums"]["purchase_origin"]
          purchased_on: string
          retailer_id?: string | null
          shipping_minor?: number
          subtotal_minor?: number
          total_minor: number
          total_nok_minor: number
          updated_at?: string
          user_id: string
          voided_at?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          customs_minor?: number
          discount_minor?: number
          fx_rate_date?: string
          fx_rate_to_nok?: number
          fx_source?: Database["public"]["Enums"]["fx_source"]
          id?: string
          notes?: string | null
          origin?: Database["public"]["Enums"]["purchase_origin"]
          purchased_on?: string
          retailer_id?: string | null
          shipping_minor?: number
          subtotal_minor?: number
          total_minor?: number
          total_nok_minor?: number
          updated_at?: string
          user_id?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchases_retailer_id_fkey"
            columns: ["retailer_id"]
            isOneToOne: false
            referencedRelation: "retailers"
            referencedColumns: ["id"]
          },
        ]
      }
      retailers: {
        Row: {
          created_at: string
          id: string
          name: string
          notes: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sealed_products: {
        Row: {
          cardmarket_product_id: string | null
          created_at: string
          created_by_user_id: string | null
          id: string
          image_url: string | null
          language: string
          name: string
          pack_count: number | null
          product_type: Database["public"]["Enums"]["sealed_product_type"]
          set_id: string | null
          tcgplayer_product_id: string | null
          updated_at: string
        }
        Insert: {
          cardmarket_product_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          image_url?: string | null
          language: string
          name: string
          pack_count?: number | null
          product_type: Database["public"]["Enums"]["sealed_product_type"]
          set_id?: string | null
          tcgplayer_product_id?: string | null
          updated_at?: string
        }
        Update: {
          cardmarket_product_id?: string | null
          created_at?: string
          created_by_user_id?: string | null
          id?: string
          image_url?: string | null
          language?: string
          name?: string
          pack_count?: number | null
          product_type?: Database["public"]["Enums"]["sealed_product_type"]
          set_id?: string | null
          tcgplayer_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sealed_products_set_id_fkey"
            columns: ["set_id"]
            isOneToOne: false
            referencedRelation: "card_sets"
            referencedColumns: ["id"]
          },
        ]
      }
      storage_locations: {
        Row: {
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["storage_location_kind"]
          name: string
          sort_order: number
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["storage_location_kind"]
          name: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["storage_location_kind"]
          name?: string
          sort_order?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      invitation_overview: {
        Row: {
          created_at: string | null
          created_by: string | null
          email: string | null
          expires_at: string | null
          id: string | null
          label: string | null
          max_uses: number | null
          revoked_at: string | null
          status: string | null
          use_count: number | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string | null
          label?: string | null
          max_uses?: number | null
          revoked_at?: string | null
          status?: never
          use_count?: number | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          email?: string | null
          expires_at?: string | null
          id?: string | null
          label?: string | null
          max_uses?: number | null
          revoked_at?: string | null
          status?: never
          use_count?: number | null
        }
        Relationships: []
      }
      holding_summaries: {
        Row: {
          card_image_base_url: string | null
          card_language: string | null
          card_local_id: string | null
          card_name: string | null
          card_set_name: string | null
          card_variant_id: string | null
          cert_number: string | null
          condition: Database["public"]["Enums"]["card_condition"] | null
          created_at: string | null
          grade: number | null
          grader: Database["public"]["Enums"]["grader"] | null
          grading_state: Database["public"]["Enums"]["grading_state"] | null
          holding_id: string | null
          holding_kind: Database["public"]["Enums"]["holding_kind"] | null
          is_favorite: boolean | null
          lot_count: number | null
          manual_card_id: string | null
          manual_collector_number: string | null
          manual_language: string | null
          manual_name: string | null
          manual_set_name: string | null
          notes: string | null
          quantity: number | null
          updated_at: string | null
          user_id: string | null
          variant_finish: Database["public"]["Enums"]["card_finish"] | null
          variant_stamp: string | null
          variant_subtype: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      add_card_acquisition: {
        Args: {
          p_acquired_on?: string
          p_card_variant_id?: string
          p_cert_number?: string
          p_condition?: Database["public"]["Enums"]["card_condition"]
          p_cost_basis_state?: Database["public"]["Enums"]["cost_basis_state"]
          p_grade?: number
          p_grader?: Database["public"]["Enums"]["grader"]
          p_grading_state?: Database["public"]["Enums"]["grading_state"]
          p_holding_notes?: string
          p_is_favorite?: boolean
          p_lot_notes?: string
          p_manual_card_id?: string
          p_manual_value_minor?: number
          p_origin?: Database["public"]["Enums"]["lot_origin"]
          p_quantity?: number
          p_storage_location_id?: string
          p_unit_cost_basis_minor?: number
        }
        Returns: {
          holding_id: string
          lot_id: string
        }[]
      }
      before_user_created: { Args: { event: Json }; Returns: Json }
      card_condition_to_text: {
        Args: { value: Database["public"]["Enums"]["card_condition"] }
        Returns: string
      }
      claim_invitation: {
        Args: { p_token: string }
        Returns: {
          claim_id: string
          invited_email: string
        }[]
      }
      create_invitation: {
        Args: { p_email: string; p_expires_in_hours?: number; p_label?: string }
        Returns: {
          expires_at: string
          invitation_id: string
          invited_email: string
          token: string
        }[]
      }
      finalize_invitation_redemption: {
        Args: { p_claim_id: string; p_user_id: string }
        Returns: undefined
      }
      grader_to_text: {
        Args: { value: Database["public"]["Enums"]["grader"] }
        Returns: string
      }
      hash_invitation_token: { Args: { p_token: string }; Returns: string }
      invitation_status: {
        Args: { p_token: string }
        Returns: {
          invited_email: string
          valid: boolean
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      release_invitation_claim: {
        Args: { p_claim_id: string }
        Returns: undefined
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      search_cards: {
        Args: {
          p_language?: string
          p_limit?: number
          p_offset?: number
          p_query: string
        }
        Returns: {
          card_id: string
          category: string
          illustrator: string
          image_base_url: string
          language: string
          local_id: string
          name: string
          rarity: string
          set_id: string
          set_name: string
          total_count: number
          variant_count: number
        }[]
      }
      set_manual_valuation: {
        Args: {
          p_effective_from?: string
          p_holding_id: string
          p_note?: string
          p_value_minor: number
        }
        Returns: {
          created_at: string
          currency: string
          effective_from: string
          holding_id: string
          id: string
          note: string | null
          superseded_at: string | null
          user_id: string
          value_minor: number
          value_nok_minor: number
        }
      }
      void_acquisition_lot: {
        Args: { p_lot_id: string; p_reason?: string }
        Returns: undefined
      }
    }
    Enums: {
      card_condition: "MT" | "NM" | "EX" | "GD" | "LP" | "PL" | "PO"
      card_finish: "normal" | "holo" | "reverse" | "other"
      card_size: "standard" | "oversized"
      collection_view: "grid" | "list" | "table"
      cost_basis_state:
        | "known"
        | "not_paid"
        | "unknown"
        | "unallocated_opening"
        | "trade_in"
      fx_source: "norges_bank" | "manual"
      grader: "psa" | "cgc" | "bgs" | "ace" | "sgc" | "tag" | "other"
      grading_state: "raw" | "pending" | "graded"
      holding_kind: "raw_card" | "graded_card" | "sealed"
      line_type:
        | "card"
        | "sealed"
        | "grading_fee"
        | "grading_shipping"
        | "bulk_lot"
        | "accessory"
        | "shipping_standalone"
        | "customs_standalone"
        | "other"
      lot_origin:
        | "purchase"
        | "gift"
        | "found"
        | "pre_tracking"
        | "other"
        | "opening"
        | "trade_in"
      purchase_origin: "manual" | "provisional_opening"
      sealed_intent: "keep_sealed" | "planned_to_open" | "undecided"
      sealed_product_type:
        | "booster_pack"
        | "booster_bundle"
        | "booster_box"
        | "elite_trainer_box"
        | "collection_box"
        | "tin"
        | "blister"
        | "ultra_premium_collection"
        | "other"
      spend_class: "collectible" | "hobby"
      storage_location_kind:
        | "binder"
        | "box"
        | "toploader_box"
        | "graded_case"
        | "shelf"
        | "other"
      theme_preference: "system" | "light" | "dark"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      card_condition: ["MT", "NM", "EX", "GD", "LP", "PL", "PO"],
      card_finish: ["normal", "holo", "reverse", "other"],
      card_size: ["standard", "oversized"],
      collection_view: ["grid", "list", "table"],
      cost_basis_state: [
        "known",
        "not_paid",
        "unknown",
        "unallocated_opening",
        "trade_in",
      ],
      fx_source: ["norges_bank", "manual"],
      grader: ["psa", "cgc", "bgs", "ace", "sgc", "tag", "other"],
      grading_state: ["raw", "pending", "graded"],
      holding_kind: ["raw_card", "graded_card", "sealed"],
      line_type: [
        "card",
        "sealed",
        "grading_fee",
        "grading_shipping",
        "bulk_lot",
        "accessory",
        "shipping_standalone",
        "customs_standalone",
        "other",
      ],
      lot_origin: [
        "purchase",
        "gift",
        "found",
        "pre_tracking",
        "other",
        "opening",
        "trade_in",
      ],
      purchase_origin: ["manual", "provisional_opening"],
      sealed_intent: ["keep_sealed", "planned_to_open", "undecided"],
      sealed_product_type: [
        "booster_pack",
        "booster_bundle",
        "booster_box",
        "elite_trainer_box",
        "collection_box",
        "tin",
        "blister",
        "ultra_premium_collection",
        "other",
      ],
      spend_class: ["collectible", "hobby"],
      storage_location_kind: [
        "binder",
        "box",
        "toploader_box",
        "graded_case",
        "shelf",
        "other",
      ],
      theme_preference: ["system", "light", "dark"],
    },
  },
} as const
