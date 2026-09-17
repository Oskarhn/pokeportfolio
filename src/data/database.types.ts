export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      acquisition_lots: {
        Row: {
          acquired_on: string
          client_request_key: string | null
          cost_basis_currency: string | null
          cost_basis_state: Database["public"]["Enums"]["cost_basis_state"]
          created_at: string
          holding_id: string
          id: string
          notes: string | null
          opening_id: string | null
          origin: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id: string | null
          quantity: number
          quantity_remaining: number
          residual_minor: number
          residual_nok_minor: number
          sealed_intent: Database["public"]["Enums"]["sealed_intent"] | null
          storage_location_id: string | null
          unit_cost_basis_minor: number | null
          unit_cost_basis_nok_minor: number | null
          user_id: string
          voided_at: string | null
        }
        Insert: {
          acquired_on: string
          client_request_key?: string | null
          cost_basis_currency?: string | null
          cost_basis_state: Database["public"]["Enums"]["cost_basis_state"]
          created_at?: string
          holding_id: string
          id?: string
          notes?: string | null
          opening_id?: string | null
          origin: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id?: string | null
          quantity: number
          quantity_remaining: number
          residual_minor?: number
          residual_nok_minor?: number
          sealed_intent?: Database["public"]["Enums"]["sealed_intent"] | null
          storage_location_id?: string | null
          unit_cost_basis_minor?: number | null
          unit_cost_basis_nok_minor?: number | null
          user_id: string
          voided_at?: string | null
        }
        Update: {
          acquired_on?: string
          client_request_key?: string | null
          cost_basis_currency?: string | null
          cost_basis_state?: Database["public"]["Enums"]["cost_basis_state"]
          created_at?: string
          holding_id?: string
          id?: string
          notes?: string | null
          opening_id?: string | null
          origin?: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id?: string | null
          quantity?: number
          quantity_remaining?: number
          residual_minor?: number
          residual_nok_minor?: number
          sealed_intent?: Database["public"]["Enums"]["sealed_intent"] | null
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
            referencedRelation: "holding_summaries"
            referencedColumns: ["holding_id"]
          },
          {
            foreignKeyName: "acquisition_lots_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "acquisition_lots_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
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
      custom_collection_members: {
        Row: {
          added_at: string
          collection_id: string
          holding_id: string
          sort_order: number
          user_id: string
        }
        Insert: {
          added_at?: string
          collection_id: string
          holding_id: string
          sort_order?: number
          user_id?: string
        }
        Update: {
          added_at?: string
          collection_id?: string
          holding_id?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_collection_members_collection_id_fkey"
            columns: ["collection_id"]
            isOneToOne: false
            referencedRelation: "custom_collections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custom_collection_members_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holding_summaries"
            referencedColumns: ["holding_id"]
          },
          {
            foreignKeyName: "custom_collection_members_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_collections: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          id: string
          name: string
          sort_order: number
          user_id: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          sort_order?: number
          user_id?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          sort_order?: number
          user_id?: string
        }
        Relationships: []
      }
      environment_ingest_config: {
        Row: {
          base_url: string | null
          configured_at: string | null
          configured_note: string | null
          id: boolean
        }
        Insert: {
          base_url?: string | null
          configured_at?: string | null
          configured_note?: string | null
          id?: boolean
        }
        Update: {
          base_url?: string | null
          configured_at?: string | null
          configured_note?: string | null
          id?: boolean
        }
        Relationships: []
      }
      fx_rates: {
        Row: {
          base_currency: string
          id: number
          quote_currency: string
          rate: number
          rate_date: string
          retrieved_at: string
          source: Database["public"]["Enums"]["fx_source"]
        }
        Insert: {
          base_currency: string
          id?: number
          quote_currency: string
          rate: number
          rate_date: string
          retrieved_at?: string
          source: Database["public"]["Enums"]["fx_source"]
        }
        Update: {
          base_currency?: string
          id?: number
          quote_currency?: string
          rate?: number
          rate_date?: string
          retrieved_at?: string
          source?: Database["public"]["Enums"]["fx_source"]
        }
        Relationships: []
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
            referencedRelation: "holding_summaries"
            referencedColumns: ["holding_id"]
          },
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
      lot_cost_adjustments: {
        Row: {
          amount_minor: number
          amount_nok_minor: number
          created_at: string
          currency: string
          id: string
          kind: Database["public"]["Enums"]["lot_cost_adjustment_kind"]
          lot_id: string
          note: string | null
          occurred_on: string
          purchase_line_id: string
          user_id: string
        }
        Insert: {
          amount_minor: number
          amount_nok_minor: number
          created_at?: string
          currency: string
          id?: string
          kind: Database["public"]["Enums"]["lot_cost_adjustment_kind"]
          lot_id: string
          note?: string | null
          occurred_on: string
          purchase_line_id: string
          user_id: string
        }
        Update: {
          amount_minor?: number
          amount_nok_minor?: number
          created_at?: string
          currency?: string
          id?: string
          kind?: Database["public"]["Enums"]["lot_cost_adjustment_kind"]
          lot_id?: string
          note?: string | null
          occurred_on?: string
          purchase_line_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lot_cost_adjustments_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "acquisition_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_cost_adjustments_purchase_line_id_fkey"
            columns: ["purchase_line_id"]
            isOneToOne: false
            referencedRelation: "purchase_lines"
            referencedColumns: ["id"]
          },
        ]
      }
      lot_disposals: {
        Row: {
          cost_basis_at_disposal_nok_minor: number | null
          created_at: string
          disposed_on: string
          id: string
          kind: Database["public"]["Enums"]["disposal_kind"]
          lot_id: string
          opening_id: string | null
          quantity: number
          sale_line_id: string | null
          user_id: string
          voided_at: string | null
        }
        Insert: {
          cost_basis_at_disposal_nok_minor?: number | null
          created_at?: string
          disposed_on: string
          id?: string
          kind: Database["public"]["Enums"]["disposal_kind"]
          lot_id: string
          opening_id?: string | null
          quantity: number
          sale_line_id?: string | null
          user_id: string
          voided_at?: string | null
        }
        Update: {
          cost_basis_at_disposal_nok_minor?: number | null
          created_at?: string
          disposed_on?: string
          id?: string
          kind?: Database["public"]["Enums"]["disposal_kind"]
          lot_id?: string
          opening_id?: string | null
          quantity?: number
          sale_line_id?: string | null
          user_id?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lot_disposals_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "acquisition_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_disposals_opening_id_fkey"
            columns: ["opening_id"]
            isOneToOne: false
            referencedRelation: "openings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lot_disposals_sale_line_id_fkey"
            columns: ["sale_line_id"]
            isOneToOne: false
            referencedRelation: "sale_lines"
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
            referencedRelation: "holding_summaries"
            referencedColumns: ["holding_id"]
          },
          {
            foreignKeyName: "manual_valuations_holding_id_fkey"
            columns: ["holding_id"]
            isOneToOne: false
            referencedRelation: "holdings"
            referencedColumns: ["id"]
          },
        ]
      }
      openings: {
        Row: {
          bulk_remainder_count: number | null
          bulk_remainder_estimate_nok_minor: number | null
          cost_nok_minor: number | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at: string
          idempotency_key: string
          notes: string | null
          opened_on: string
          provisional_purchase_id: string | null
          quantity_opened: number
          reconciled_at: string | null
          reconciled_to_purchase_id: string | null
          sealed_product_id: string
          source_lot_id: string
          tracking_completeness: Database["public"]["Enums"]["opening_tracking"]
          user_id: string
          voided_at: string | null
        }
        Insert: {
          bulk_remainder_count?: number | null
          bulk_remainder_estimate_nok_minor?: number | null
          cost_nok_minor?: number | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at?: string
          idempotency_key?: string
          notes?: string | null
          opened_on: string
          provisional_purchase_id?: string | null
          quantity_opened: number
          reconciled_at?: string | null
          reconciled_to_purchase_id?: string | null
          sealed_product_id: string
          source_lot_id: string
          tracking_completeness?: Database["public"]["Enums"]["opening_tracking"]
          user_id: string
          voided_at?: string | null
        }
        Update: {
          bulk_remainder_count?: number | null
          bulk_remainder_estimate_nok_minor?: number | null
          cost_nok_minor?: number | null
          cost_source?: Database["public"]["Enums"]["opening_cost_source"]
          created_at?: string
          idempotency_key?: string
          notes?: string | null
          opened_on?: string
          provisional_purchase_id?: string | null
          quantity_opened?: number
          reconciled_at?: string | null
          reconciled_to_purchase_id?: string | null
          sealed_product_id?: string
          source_lot_id?: string
          tracking_completeness?: Database["public"]["Enums"]["opening_tracking"]
          user_id?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "openings_provisional_purchase_id_fkey"
            columns: ["provisional_purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "openings_reconciled_to_purchase_id_fkey"
            columns: ["reconciled_to_purchase_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "openings_sealed_product_id_fkey"
            columns: ["sealed_product_id"]
            isOneToOne: false
            referencedRelation: "sealed_products"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "openings_source_lot_id_fkey"
            columns: ["source_lot_id"]
            isOneToOne: false
            referencedRelation: "acquisition_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "openings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      portfolio_recompute_queue: {
        Row: {
          dirty_from: string
          updated_at: string
          user_id: string
        }
        Insert: {
          dirty_from: string
          updated_at?: string
          user_id: string
        }
        Update: {
          dirty_from?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      portfolio_recompute_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: number
          snapshots_written: number
          started_at: string
          users_processed: number
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: number
          snapshots_written?: number
          started_at?: string
          users_processed?: number
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: number
          snapshots_written?: number
          started_at?: string
          users_processed?: number
        }
        Relationships: []
      }
      portfolio_snapshots: {
        Row: {
          attributed_value_nok_minor: number
          collectible_spend_to_date_nok_minor: number
          computed_at: string
          cost_basis_nok_minor: number
          market_value_nok_minor: number
          open_lot_count: number
          sales_proceeds_to_date_nok_minor: number
          snapshot_date: string
          unvalued_lot_count: number
          user_id: string
        }
        Insert: {
          attributed_value_nok_minor?: number
          collectible_spend_to_date_nok_minor?: number
          computed_at?: string
          cost_basis_nok_minor?: number
          market_value_nok_minor?: number
          open_lot_count?: number
          sales_proceeds_to_date_nok_minor?: number
          snapshot_date: string
          unvalued_lot_count?: number
          user_id: string
        }
        Update: {
          attributed_value_nok_minor?: number
          collectible_spend_to_date_nok_minor?: number
          computed_at?: string
          cost_basis_nok_minor?: number
          market_value_nok_minor?: number
          open_lot_count?: number
          sales_proceeds_to_date_nok_minor?: number
          snapshot_date?: string
          unvalued_lot_count?: number
          user_id?: string
        }
        Relationships: []
      }
      price_snapshots: {
        Row: {
          card_variant_id: string
          id: number
          price_kind: Database["public"]["Enums"]["price_kind"]
          provider: Database["public"]["Enums"]["price_provider"]
          provider_updated_at: string | null
          retrieved_at: string
          snapshot_date: string
          source_currency: string
          value_minor: number
        }
        Insert: {
          card_variant_id: string
          id?: number
          price_kind: Database["public"]["Enums"]["price_kind"]
          provider: Database["public"]["Enums"]["price_provider"]
          provider_updated_at?: string | null
          retrieved_at?: string
          snapshot_date: string
          source_currency: string
          value_minor: number
        }
        Update: {
          card_variant_id?: string
          id?: number
          price_kind?: Database["public"]["Enums"]["price_kind"]
          provider?: Database["public"]["Enums"]["price_provider"]
          provider_updated_at?: string | null
          retrieved_at?: string
          snapshot_date?: string
          source_currency?: string
          value_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "price_snapshots_card_variant_id_fkey"
            columns: ["card_variant_id"]
            isOneToOne: false
            referencedRelation: "card_variants"
            referencedColumns: ["id"]
          },
        ]
      }
      price_sync_runs: {
        Row: {
          ambiguous_mapping_count: number
          batch_size: number
          cards_fetched: number
          created_at: string
          error: string | null
          finished_at: string | null
          id: number
          kind: string
          missing_provider_count: number
          provider_error_count: number
          snapshots_unchanged: number
          snapshots_written: number
          started_at: string
          status: string
          variants_considered: number
        }
        Insert: {
          ambiguous_mapping_count?: number
          batch_size?: number
          cards_fetched?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: number
          kind: string
          missing_provider_count?: number
          provider_error_count?: number
          snapshots_unchanged?: number
          snapshots_written?: number
          started_at: string
          status: string
          variants_considered?: number
        }
        Update: {
          ambiguous_mapping_count?: number
          batch_size?: number
          cards_fetched?: number
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: number
          kind?: string
          missing_provider_count?: number
          provider_error_count?: number
          snapshots_unchanged?: number
          snapshots_written?: number
          started_at?: string
          status?: string
          variants_considered?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          collection_default_sort: Database["public"]["Enums"]["portfolio_sort_order"]
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
          hide_values: boolean
          id: string
          is_admin: boolean
          locale: string
          low_value_threshold_minor: number
          theme: Database["public"]["Enums"]["theme_preference"]
          updated_at: string
          use_eu_pricing: boolean
        }
        Insert: {
          collection_default_sort?: Database["public"]["Enums"]["portfolio_sort_order"]
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
          hide_values?: boolean
          id: string
          is_admin?: boolean
          locale?: string
          low_value_threshold_minor?: number
          theme?: Database["public"]["Enums"]["theme_preference"]
          updated_at?: string
          use_eu_pricing?: boolean
        }
        Update: {
          collection_default_sort?: Database["public"]["Enums"]["portfolio_sort_order"]
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
          hide_values?: boolean
          id?: string
          is_admin?: boolean
          locale?: string
          low_value_threshold_minor?: number
          theme?: Database["public"]["Enums"]["theme_preference"]
          updated_at?: string
          use_eu_pricing?: boolean
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
          idempotency_key: string | null
          idempotency_request: Json | null
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
          idempotency_key?: string | null
          idempotency_request?: Json | null
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
          idempotency_key?: string | null
          idempotency_request?: Json | null
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
          user_id?: string
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
      sale_lines: {
        Row: {
          allocated_fees_minor: number
          allocated_shipping_charged_minor: number
          allocated_shipping_minor: number
          cost_basis_at_sale_nok_minor: number | null
          created_at: string
          id: string
          line_gross_minor: number
          lot_id: string
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          quantity: number
          realized_result_nok_minor: number | null
          sale_id: string
          unit_gross_minor: number
          user_id: string
        }
        Insert: {
          allocated_fees_minor?: number
          allocated_shipping_charged_minor?: number
          allocated_shipping_minor?: number
          cost_basis_at_sale_nok_minor?: number | null
          created_at?: string
          id?: string
          line_gross_minor: number
          lot_id: string
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          quantity: number
          realized_result_nok_minor?: number | null
          sale_id: string
          unit_gross_minor: number
          user_id: string
        }
        Update: {
          allocated_fees_minor?: number
          allocated_shipping_charged_minor?: number
          allocated_shipping_minor?: number
          cost_basis_at_sale_nok_minor?: number | null
          created_at?: string
          id?: string
          line_gross_minor?: number
          lot_id?: string
          net_proceeds_minor?: number
          net_proceeds_nok_minor?: number
          quantity?: number
          realized_result_nok_minor?: number | null
          sale_id?: string
          unit_gross_minor?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sale_lines_lot_id_fkey"
            columns: ["lot_id"]
            isOneToOne: false
            referencedRelation: "acquisition_lots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sale_lines_sale_id_fkey"
            columns: ["sale_id"]
            isOneToOne: false
            referencedRelation: "sales"
            referencedColumns: ["id"]
          },
        ]
      }
      sales: {
        Row: {
          created_at: string
          currency: string
          fees_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          gross_minor: number
          id: string
          idempotency_key: string
          idempotency_request: Json | null
          marketplace: string | null
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          notes: string | null
          proceeds_from_uncosted_nok_minor: number
          realized_result_nok_minor: number | null
          shipping_charged_minor: number
          shipping_cost_minor: number
          sold_on: string
          updated_at: string
          user_id: string
          voided_at: string | null
        }
        Insert: {
          created_at?: string
          currency: string
          fees_minor?: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          gross_minor: number
          id?: string
          idempotency_key: string
          idempotency_request?: Json | null
          marketplace?: string | null
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          notes?: string | null
          proceeds_from_uncosted_nok_minor?: number
          realized_result_nok_minor?: number | null
          shipping_charged_minor?: number
          shipping_cost_minor?: number
          sold_on: string
          updated_at?: string
          user_id: string
          voided_at?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          fees_minor?: number
          fx_rate_date?: string
          fx_rate_to_nok?: number
          fx_source?: Database["public"]["Enums"]["fx_source"]
          gross_minor?: number
          id?: string
          idempotency_key?: string
          idempotency_request?: Json | null
          marketplace?: string | null
          net_proceeds_minor?: number
          net_proceeds_nok_minor?: number
          notes?: string | null
          proceeds_from_uncosted_nok_minor?: number
          realized_result_nok_minor?: number | null
          shipping_charged_minor?: number
          shipping_cost_minor?: number
          sold_on?: string
          updated_at?: string
          user_id?: string
          voided_at?: string | null
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
          qty_keep_sealed: number | null
          qty_planned_to_open: number | null
          qty_undecided: number | null
          sealed_image_url: string | null
          sealed_is_custom: boolean | null
          sealed_pack_count: number | null
          sealed_product_id: string | null
          sealed_product_language: string | null
          sealed_product_name: string | null
          sealed_product_type: Database["public"]["Enums"]["sealed_product_type"] | null
          sealed_set_id: string | null
          sealed_set_name: string | null
          updated_at: string | null
          user_id: string | null
          variant_finish: Database["public"]["Enums"]["card_finish"] | null
          variant_stamp: string | null
          variant_subtype: string | null
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
        ]
      }
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
      watched_card_variants: {
        Row: {
          card_variant_id: string | null
        }
        Insert: {
          card_variant_id?: string | null
        }
        Update: {
          card_variant_id?: string | null
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
          p_client_request_key?: string
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
          p_sealed_intent?: Database["public"]["Enums"]["sealed_intent"]
          p_sealed_product_id?: string
          p_storage_location_id?: string
          p_unit_cost_basis_minor?: number
        }
        Returns: {
          holding_id: string
          lot_id: string
        }[]
      }
      allocate_largest_remainder: {
        Args: { p_total: number; p_weights: number[] }
        Returns: number[]
      }
      allocate_largest_remainder_signed: {
        Args: { p_total: number; p_weights: number[] }
        Returns: number[]
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
      clear_manual_valuation: {
        Args: { p_holding_id: string }
        Returns: undefined
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
      create_opening: {
        Args: {
          p_bulk_remainder_count?: number | null
          p_bulk_remainder_estimate_nok_minor?: number | null
          p_idempotency_key?: string | null
          p_notes?: string | null
          p_opened_on?: string
          p_provisional_purchase_id?: string | null
          p_pulls?: Json
          p_quantity: number
          p_source_lot_id: string
          p_tracking_completeness?: Database["public"]["Enums"]["opening_tracking"]
        }
        Returns: {
          bulk_remainder_count: number | null
          bulk_remainder_estimate_nok_minor: number | null
          cost_nok_minor: number | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at: string
          id: string
          idempotency_key: string
          notes: string | null
          opened_on: string
          provisional_purchase_id: string | null
          quantity_opened: number
          reconciled_at: string | null
          reconciled_to_purchase_id: string | null
          sealed_product_id: string
          source_lot_id: string
          tracking_completeness: Database["public"]["Enums"]["opening_tracking"]
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "openings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_opening_from_provisional: {
        Args: {
          p_bulk_remainder_count?: number | null
          p_bulk_remainder_estimate_nok_minor?: number | null
          p_idempotency_key?: string | null
          p_notes?: string | null
          p_opened_on?: string | null
          p_pulls?: Json
          p_purchased_on: string
          p_quantity: number
          p_sealed_product_id: string
          p_total_paid_minor: number
          p_tracking_completeness?: Database["public"]["Enums"]["opening_tracking"]
        }
        Returns: {
          bulk_remainder_count: number | null
          bulk_remainder_estimate_nok_minor: number | null
          cost_nok_minor: number | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at: string
          id: string
          idempotency_key: string
          notes: string | null
          opened_on: string
          provisional_purchase_id: string | null
          quantity_opened: number
          reconciled_at: string | null
          reconciled_to_purchase_id: string | null
          sealed_product_id: string
          source_lot_id: string
          tracking_completeness: Database["public"]["Enums"]["opening_tracking"]
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "openings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_purchase: {
        Args: {
          p_currency: string
          p_customs_minor?: number
          p_discount_minor?: number
          p_fx_rate_date?: string
          p_fx_rate_to_nok?: string
          p_fx_source?: Database["public"]["Enums"]["fx_source"]
          p_idempotency_key?: string
          p_lines: Json
          p_notes?: string
          p_purchased_on: string
          p_retailer_id?: string
          p_shipping_minor?: number
        }
        Returns: {
          created_at: string
          currency: string
          customs_minor: number
          discount_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          id: string
          idempotency_key: string | null
          idempotency_request: Json | null
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
        SetofOptions: {
          from: "*"
          to: "purchases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_sale: {
        Args: {
          p_currency: string
          p_fees_minor?: number
          p_fx_rate_date?: string
          p_fx_rate_to_nok?: string
          p_fx_source?: Database["public"]["Enums"]["fx_source"]
          p_idempotency_key: string
          p_lines: Json
          p_marketplace?: string
          p_notes?: string
          p_shipping_charged_minor?: number
          p_shipping_cost_minor?: number
          p_sold_on: string
        }
        Returns: {
          created_at: string
          currency: string
          fees_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          gross_minor: number
          id: string
          idempotency_key: string
          idempotency_request: Json | null
          marketplace: string | null
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          notes: string | null
          proceeds_from_uncosted_nok_minor: number
          realized_result_nok_minor: number | null
          shipping_charged_minor: number
          shipping_cost_minor: number
          sold_on: string
          updated_at: string
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sales"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_invitation_redemption: {
        Args: { p_claim_id: string; p_user_id: string }
        Returns: undefined
      }
      get_opening: {
        Args: { p_opening_id: string }
        Returns: {
          bulk_remainder_count: number | null
          bulk_remainder_estimate_nok_minor: string | null
          cost_nok_minor: string | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at: string
          id: string
          net_proceeds_from_sold_pulls_nok_minor: string
          notes: string | null
          opened_on: string
          opening_return_nok_minor: string | null
          priced_pull_lot_count: number
          provisional_purchase_id: string | null
          quantity_opened: number
          reconciled_at: string | null
          reconciled_to_purchase_id: string | null
          retained_tracked_value_nok_minor: string
          sealed_product_id: string
          sealed_product_name: string
          sold_pull_lot_count: number
          source_lot_id: string
          tracking_completeness: Database["public"]["Enums"]["opening_tracking"]
          unpriced_pull_lot_count: number
          voided_at: string | null
        }[]
      }
      get_card_variant_price_history: {
        Args: { p_card_variant_id: string; p_since?: string }
        Returns: {
          price_kind: Database["public"]["Enums"]["price_kind"]
          provider: Database["public"]["Enums"]["price_provider"]
          snapshot_date: string
          value_nok_minor: string
        }[]
      }
      get_dashboard_summary: {
        Args: never
        Returns: {
          attributed_value_nok_minor: string | null
          auto_priced_holding_count: string
          collectible_spend_to_date_nok_minor: string | null
          cost_basis_nok_minor: string | null
          cs_nok_minor: string
          first_tracked_date: string | null
          graded_holding_count: string
          graded_value_nok_minor: string
          gpo_nok_minor: string
          hs_nok_minor: string
          latest_snapshot_date: string | null
          manual_entry_count: string
          manual_valued_holding_count: string
          market_value_has_coverage: boolean | null
          market_value_nok_minor: string | null
          ncco_nok_minor: string
          nsp_nok_minor: string
          pending_recompute: boolean
          physical_card_count: string
          priced_holding_count: string
          pud_nok_minor: string
          raw_value_nok_minor: string
          rrc_nok_minor: string
          sealed_holding_count: string
          sealed_unit_count: string
          sealed_value_nok_minor: string
          sales_proceeds_to_date_nok_minor: string | null
          snapshot_open_lot_count: string | null
          snapshot_unvalued_lot_count: string | null
          thco_nok_minor: string
          thp_nok_minor: string | null
          ttep_nok_minor: string | null
          unique_holding_count: string
          uncosted_open_lot_count: string
          unrealized_result_nok_minor: string | null
          unpriced_holding_count: string
        }[]
      }
      get_holding_value_provenance: {
        Args: { p_holding_id: string }
        Returns: {
          fx_rate: number | null
          holding_value_nok_minor: string | null
          price_kind: Database["public"]["Enums"]["price_kind"] | null
          price_state: string
          provider: Database["public"]["Enums"]["price_provider"] | null
          provider_updated_at: string | null
          quantity: string
          snapshot_date: string | null
          source_currency: string | null
          source_value_minor: string | null
          unit_value_nok_minor: string | null
        }[]
      }
      get_market_movers: {
        Args: {
          p_limit?: number
          p_period_days?: number
          p_sort?: Database["public"]["Enums"]["market_mover_sort"]
        }
        Returns: {
          card_image_base_url: string | null
          card_name: string | null
          card_variant_id: string
          change_nok_minor: string
          change_pct: number | null
          current_value_nok_minor: string
          holding_id: string
          holding_impact_nok_minor: string
          previous_value_nok_minor: string
          quantity: number
        }[]
      }
      get_monthly_spend: {
        Args: { p_months?: number }
        Returns: {
          collectible_nok_minor: string
          hobby_nok_minor: string
          month: string
          total_nok_minor: string
        }[]
      }
      get_portfolio_history: {
        Args: { p_display_currency?: string; p_from?: string; p_to?: string }
        Returns: {
          display_value_minor: string | null
          has_coverage: boolean
          market_value_nok_minor: string | null
          open_lot_count: string | null
          snapshot_date: string
          unvalued_lot_count: string | null
        }[]
      }
      get_recent_activity: {
        Args: { p_limit?: number }
        Returns: {
          activity_type: string
          amount_nok_minor: string | null
          occurred_on: string | null
          primary_id: string
          secondary_id: string | null
        }[]
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
      list_history_events: {
        Args: {
          p_before_at?: string
          p_before_id?: string
          p_include_voided?: boolean
          p_kind?: string
          p_limit?: number
        }
        Returns: {
          amount_nok_minor: string | null
          event_kind: string
          href: string
          occurred_on: string
          primary_id: string
          recorded_at: string
          secondary_id: string | null
          status: string
          subtitle: string
          title: string
        }[]
      }
      list_opening_sources: {
        Args: {
          p_holding_id?: string | null
        }
        Returns: {
          acquired_on: string
          cost_known: boolean
          effective_unit_basis_nok_minor: string | null
          exhaustion_residual_nok_minor: string | null
          holding_id: string
          image_url: string | null
          lot_id: string
          product_name: string
          product_type: string | null
          purchase_id: string | null
          purchase_origin: string | null
          purchased_on: string | null
          quantity_available: number
          sealed_product_id: string
        }[]
      }
      list_portfolio: {
        Args: {
          p_condition?: Database["public"]["Enums"]["card_condition"]
          p_cursor_acquired_on?: string
          p_cursor_added_at?: string
          p_cursor_has_value?: boolean
          p_cursor_holding_id?: string
          p_cursor_name?: string
          p_cursor_number_key?: string
          p_cursor_quantity?: number
          p_cursor_set_name?: string
          p_cursor_value_minor?: number
          p_custom_collection_id?: string
          p_favorite?: boolean
          p_grader?: Database["public"]["Enums"]["grader"]
          p_graded?: boolean
          p_holding_kind?: Database["public"]["Enums"]["holding_kind"]
          p_language?: string
          p_limit?: number
          p_low_value?: boolean
          p_manual_only?: boolean
          p_missing_value?: boolean
          p_query?: string
          p_sealed_intent?: Database["public"]["Enums"]["sealed_intent"]
          p_sealed_product_type?: Database["public"]["Enums"]["sealed_product_type"]
          p_set_id?: string
          p_sort?: Database["public"]["Enums"]["portfolio_sort_order"]
          p_storage_location_id?: string
          p_tag_id?: string
        }
        Returns: {
          acquired_on_max: string | null
          acquired_on_min: string | null
          card_image_base_url: string | null
          card_language: string | null
          card_local_id: string | null
          card_name: string | null
          card_set_id: string | null
          card_set_name: string | null
          card_variant_id: string | null
          cert_number: string | null
          condition: Database["public"]["Enums"]["card_condition"] | null
          created_at: string
          grade: number | null
          grader: Database["public"]["Enums"]["grader"] | null
          grading_state: Database["public"]["Enums"]["grading_state"]
          has_multiple_storage_locations: boolean | null
          holding_id: string
          holding_kind: Database["public"]["Enums"]["holding_kind"]
          is_favorite: boolean
          lot_count: number
          manual_card_id: string | null
          manual_collector_number: string | null
          manual_language: string | null
          manual_name: string | null
          manual_set_name: string | null
          holding_value_nok_minor: string | null
          notes: string | null
          number_sort_key: string | null
          price_state: string | null
          quantity: number
          qty_keep_sealed: number
          qty_planned_to_open: number
          qty_undecided: number
          sealed_image_url: string | null
          sealed_is_custom: boolean | null
          sealed_pack_count: number | null
          sealed_product_id: string | null
          sealed_product_language: string | null
          sealed_product_name: string | null
          sealed_product_type: Database["public"]["Enums"]["sealed_product_type"] | null
          sealed_set_id: string | null
          sealed_set_name: string | null
          unit_value_nok_minor: string | null
          variant_finish: Database["public"]["Enums"]["card_finish"] | null
          variant_stamp: string | null
          variant_subtype: string | null
        }[]
      }
      natural_sort_key: {
        Args: { p_text: string }
        Returns: string
      }
      portfolio_counts: {
        Args: { p_custom_collection_id?: string }
        Returns: {
          cards_value_nok_minor: string
          graded_count: string
          manual_count: string
          physical_card_count: string
          portfolio_value_nok_minor: string
          priced_holding_count: string
          sealed_holding_count: string
          sealed_priced_holding_count: string
          sealed_unit_count: string
          sealed_unpriced_holding_count: string
          sealed_value_nok_minor: string
          unique_holding_count: string
          unpriced_holding_count: string
        }[]
      }
      purchase_spending_summary: {
        Args: never
        Returns: {
          cs_nok_minor: string
          gpo_nok_minor: string
          hs_nok_minor: string
          purchase_count: number
        }[]
      }
      reduce_holding_quantity: {
        Args: {
          p_holding_id: string
          p_lot_reductions: { lot_id: string; remove_quantity: number }[]
        }
        Returns: { owned_quantity: number }[]
      }
      reconcile_opening_cost: {
        Args: { p_opening_id: string; p_real_source_lot_id: string }
        Returns: {
          bulk_remainder_count: number | null
          bulk_remainder_estimate_nok_minor: number | null
          cost_nok_minor: number | null
          cost_source: Database["public"]["Enums"]["opening_cost_source"]
          created_at: string
          id: string
          idempotency_key: string
          notes: string | null
          opened_on: string
          provisional_purchase_id: string | null
          quantity_opened: number
          reconciled_at: string | null
          reconciled_to_purchase_id: string | null
          sealed_product_id: string
          source_lot_id: string
          tracking_completeness: Database["public"]["Enums"]["opening_tracking"]
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "openings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_invitation_claim: {
        Args: { p_claim_id: string }
        Returns: undefined
      }
      remove_holdings_from_portfolio: {
        Args: { p_holding_ids: string[] }
        Returns: {
          blocked: boolean
          blocked_reason: string | null
          holding_id: string
          physical_count: number
        }[]
      }
      reset_my_portfolio_data: {
        Args: never
        Returns: {
          acquisition_lots_deleted: number
          holdings_deleted: number
          lot_disposals_deleted: number
          manual_valuations_deleted: number
          opening_pull_lots_deleted: number
          openings_deleted: number
          purchase_lines_deleted: number
          purchases_deleted: number
          sale_lines_deleted: number
          sales_deleted: number
          snapshots_deleted: number
        }[]
      }
      resolve_variant_market_values: {
        Args: { p_card_variant_ids: string[] }
        Returns: {
          card_variant_id: string
          fx_rate: number | null
          price_kind: Database["public"]["Enums"]["price_kind"] | null
          price_state: string
          provider: Database["public"]["Enums"]["price_provider"] | null
          provider_updated_at: string | null
          snapshot_date: string | null
          source_currency: string | null
          source_value_minor: string | null
          value_nok_minor: string | null
        }[]
      }
      revoke_invitation: {
        Args: { p_invitation_id: string }
        Returns: undefined
      }
      sales_summary: {
        Args: never
        Returns: {
          buyer_shipping_nok_minor: string
          fees_nok_minor: string
          gross_nok_minor: string
          nsp_nok_minor: string
          outbound_shipping_nok_minor: string
          pud_nok_minor: string
          rrc_nok_minor: string
          sale_count: number
        }[]
      }
      void_opening: {
        Args: { p_opening_id: string; p_reason?: string | null }
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
        SetofOptions: {
          from: "*"
          to: "manual_valuations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_sealed_lot_intent: {
        Args: {
          p_intent: Database["public"]["Enums"]["sealed_intent"]
          p_lot_id: string
          p_quantity?: number
        }
        Returns: {
          acquired_on: string
          client_request_key: string | null
          cost_basis_currency: string | null
          cost_basis_state: Database["public"]["Enums"]["cost_basis_state"]
          created_at: string
          holding_id: string
          id: string
          notes: string | null
          opening_id: string | null
          origin: Database["public"]["Enums"]["lot_origin"]
          purchase_line_id: string | null
          quantity: number
          quantity_remaining: number
          residual_minor: number
          residual_nok_minor: number
          sealed_intent: Database["public"]["Enums"]["sealed_intent"] | null
          storage_location_id: string | null
          unit_cost_basis_minor: number | null
          unit_cost_basis_nok_minor: number | null
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "acquisition_lots"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_purchase: {
        Args: {
          p_currency: string
          p_customs_minor?: number
          p_discount_minor?: number
          p_fx_rate_date?: string
          p_fx_rate_to_nok?: string
          p_fx_source?: Database["public"]["Enums"]["fx_source"]
          p_lines: Json
          p_notes?: string
          p_purchase_id: string
          p_purchased_on: string
          p_retailer_id?: string
          p_shipping_minor?: number
        }
        Returns: {
          created_at: string
          currency: string
          customs_minor: number
          discount_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          id: string
          idempotency_key: string | null
          idempotency_request: Json | null
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
        SetofOptions: {
          from: "*"
          to: "purchases"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_sale: {
        Args: {
          p_currency: string
          p_fees_minor?: number
          p_fx_rate_date?: string
          p_fx_rate_to_nok?: string
          p_fx_source?: Database["public"]["Enums"]["fx_source"]
          p_lines: Json
          p_marketplace?: string
          p_notes?: string
          p_sale_id: string
          p_shipping_charged_minor?: number
          p_shipping_cost_minor?: number
          p_sold_on: string
        }
        Returns: {
          created_at: string
          currency: string
          fees_minor: number
          fx_rate_date: string
          fx_rate_to_nok: number
          fx_source: Database["public"]["Enums"]["fx_source"]
          gross_minor: number
          id: string
          idempotency_key: string
          idempotency_request: Json | null
          marketplace: string | null
          net_proceeds_minor: number
          net_proceeds_nok_minor: number
          notes: string | null
          proceeds_from_uncosted_nok_minor: number
          realized_result_nok_minor: number | null
          shipping_charged_minor: number
          shipping_cost_minor: number
          sold_on: string
          updated_at: string
          user_id: string
          voided_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "sales"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      void_acquisition_lot: {
        Args: { p_lot_id: string; p_reason?: string }
        Returns: undefined
      }
      void_purchase: {
        Args: { p_purchase_id: string; p_reason?: string }
        Returns: undefined
      }
      void_sale: {
        Args: { p_reason?: string; p_sale_id: string }
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
      disposal_kind: "sale" | "opened" | "traded_away" | "write_off" | "correction"
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
      lot_cost_adjustment_kind: "grading_fee" | "grading_shipping" | "restoration" | "other"
      lot_origin:
        | "purchase"
        | "gift"
        | "found"
        | "pre_tracking"
        | "other"
        | "opening"
        | "trade_in"
      opening_cost_source: "from_lot" | "unknown"
      opening_tracking: "all_cards" | "selected_pulls" | "unknown"
      portfolio_sort_order:
        | "value_desc"
        | "value_asc"
        | "name_asc"
        | "name_desc"
        | "set_asc"
        | "quantity_desc"
        | "acquired_newest"
        | "acquired_oldest"
        | "added_newest"
        | "added_oldest"
        | "number_asc"
        | "number_desc"
      market_mover_sort:
        | "most_movement"
        | "least_movement"
        | "highest_increase"
        | "largest_decrease"
      price_kind: "cm_trend" | "cm_avg30" | "cm_avg7" | "cm_avg" | "tp_market"
      price_provider: "tcgdex_cardmarket" | "tcgdex_tcgplayer"
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
      disposal_kind: ["sale", "opened", "traded_away", "write_off", "correction"],
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
      lot_cost_adjustment_kind: ["grading_fee", "grading_shipping", "restoration", "other"],
      lot_origin: [
        "purchase",
        "gift",
        "found",
        "pre_tracking",
        "other",
        "opening",
        "trade_in",
      ],
      opening_cost_source: ["from_lot", "unknown"],
      opening_tracking: ["all_cards", "selected_pulls", "unknown"],
      portfolio_sort_order: [
        "value_desc",
        "value_asc",
        "name_asc",
        "name_desc",
        "set_asc",
        "quantity_desc",
        "acquired_newest",
        "acquired_oldest",
        "added_newest",
        "added_oldest",
        "number_asc",
        "number_desc",
      ],
      market_mover_sort: [
        "most_movement",
        "least_movement",
        "highest_increase",
        "largest_decrease",
      ],
      price_kind: ["cm_trend", "cm_avg30", "cm_avg7", "cm_avg", "tp_market"],
      price_provider: ["tcgdex_cardmarket", "tcgdex_tcgplayer"],
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

