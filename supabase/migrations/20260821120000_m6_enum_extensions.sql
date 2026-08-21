-- M6 (DATA_MODEL.md §12, prompt §24/§27/§30) pulls two lot_origin/cost_basis_state pairs forward
-- from their originally-planned milestones.
--
-- DATA_MODEL.md §12 said 'opening' arrives with the openings table (M16) and 'trade_in' with the
-- trades table (M18), each alongside the column (opening_id/trade_line_id) that origin needs. But
-- D-017 ("every physical card is trackable") and the M6 gate both require that a pulled card or a
-- traded-in card be recordable the moment M6 ships, not after M16/M18 — a collector opening packs
-- today cannot be told "come back once openings exist" without violating the all-cards guarantee.
--
-- Resolution, recorded as a deliberate deviation from the M3 sequencing note rather than a silent
-- one (see DECISIONS.md D-036): the enum values ship now, the supporting columns do not.
-- acquisition_lots gets no opening_id/trade_line_id in M6 — a lot with origin='opening' simply has
-- no opening reference yet, exactly as DATA_MODEL.md §5.5 already anticipates for a lot whose
-- linking column doesn't exist yet ("later opening reconciliation/linking must remain possible").
-- When M16/M18 add those columns, existing 'opening'/'trade_in' lots are candidates for linking,
-- not a migration hazard.
--
-- Split into its own migration/transaction: PostgreSQL only allows a value added by
-- ALTER TYPE ... ADD VALUE to be used in the same transaction that added it so long as it never
-- backs an index in that same transaction (relaxed since PG12) — M6's check-constraint use below
-- is safe either way, but a separate file removes any doubt rather than relying on the nuance.

alter type public.lot_origin add value if not exists 'opening';
alter type public.lot_origin add value if not exists 'trade_in';

alter type public.cost_basis_state add value if not exists 'unallocated_opening';
alter type public.cost_basis_state add value if not exists 'trade_in';
