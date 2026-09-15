-- P135 independent reproduction of P130-02, against an isolated bare Postgres 17 container
-- (no Supabase stack, no cron, no network, no Production access).
--
-- The formula below is copied VERBATIM from the released base
-- (cff3bbd94447529a10c3a35d93ddb7491cf488b6), create_purchase, m8_purchase_ledger.sql:358
-- and update_purchase, m10_lot_residual_nok_fix.sql:665:
--   v_total_nok := round(v_total::numeric * v_fx_rate)::bigint;
-- and the CHECK constraint at m8_purchase_ledger.sql:20:
--   total_nok_minor = round(total_minor::numeric * fx_rate_to_nok)::bigint
--
-- v_total / total_minor is the purchase total in the SOURCE currency's minor units.
-- v_fx_rate / fx_rate_to_nok is documented (FINANCIAL_MODEL.md §7, D-007, norges-bank.ts's own
-- header comment, src/domain/fx.ts's own header comment) as "NOK per ONE MAJOR unit of the
-- source currency". Neither the RPC body nor the CHECK constraint reads a currency exponent
-- table anywhere (grep across the released migrations for "exponent" inside the RPC bodies
-- returns zero hits) even though D-007 / FINANCIAL_MODEL.md §1 both say the exponent must never
-- be assumed to be 2.

\pset format aligned
\pset border 2

-- Reproduce the EXACT literal SQL formula as its own callable function, unmodified, so every
-- case below runs the released arithmetic itself rather than a hand-transcription of it.
create or replace function repro_v_total_nok(v_total bigint, v_fx_rate numeric(18,8))
returns bigint language sql immutable as $$
  select round(v_total::numeric * v_fx_rate)::bigint
$$;

create table results (
  case_id text,
  currency text,
  source_minor_exponent int,
  target_minor_exponent int,
  amount_major numeric,
  amount_minor bigint,
  fx_rate_to_nok_per_unit numeric(18,8),
  stored_fx_rate_to_nok numeric(18,8),
  released_sql_total_nok_minor bigint,
  correct_total_nok_minor bigint,
  ratio_actual_over_correct numeric,
  note text
);

-- ============================================================
-- CASE A: MANUAL_JPY_BUG — user enters a TRUE per-unit rate exactly as the UI's own label
--   instructs ("NOK per 1 JPY" — PurchaseFormPage.tsx:390), for 10,000 JPY at a real-world-shaped
--   rate of 0.060375 NOK per JPY (matches the P130-02 finding's own fixture).
-- ============================================================
insert into results
select
  'A_MANUAL_JPY', 'JPY', 0, 2, 10000, 10000, 0.060375, 0.060375,
  repro_v_total_nok(10000, 0.060375),
  round(10000 * 0.060375 * 100)::bigint,  -- correct: amount_major * rate * 10^(2-0)
  repro_v_total_nok(10000, 0.060375)::numeric / round(10000 * 0.060375 * 100)::numeric,
  'manual per-unit rate entered exactly as UI instructs -> SQL drops the 10^(targetExp-sourceExp)=100x factor';

-- ============================================================
-- CASE B: AUTO_JPY_DOUBLE_BUG_CANCELLATION — the Norges Bank RAW published number for JPY is
--   "NOK per 100 JPY" (UNIT_MULT=2) because the parser (_shared/norges-bank.ts) never divides by
--   10^UNIT_MULT. That raw number (6.0375) is stored verbatim as fx_rate_to_nok and fed into the
--   SAME buggy SQL formula.
-- ============================================================
insert into results
select
  'B_AUTO_JPY', 'JPY', 0, 2, 10000, 10000, 0.060375, 6.0375,
  repro_v_total_nok(10000, 6.0375),
  round(10000 * 0.060375 * 100)::bigint,  -- the economically correct NOK value for this purchase
  repro_v_total_nok(10000, 6.0375)::numeric / round(10000 * 0.060375 * 100)::numeric,
  'raw Norges Bank number (100x too high vs true per-unit rate) fed into a formula that is itself 100x too low for JPY -> the two 100x errors cancel in total_nok_minor; stored fx_rate_to_nok is still wrong';

-- ============================================================
-- CASE C: EUR control — exponent 0 for both currencies' unit gap (EUR exp 2, NOK exp 2,
--   UNIT_MULT for EUR is 0 per Norges Bank's own series metadata) -> no exponent shift is needed,
--   so the released formula happens to be correct. Manual and auto agree.
-- ============================================================
-- NOTE on the oracle used in the "correct_total_nok_minor" column throughout this script:
--   correct_total_nok_minor = round(amount_minor * rate_per_unit * 10^(target_exp - source_exp))
-- i.e. the SAME exponent-aware formula as src/domain/fx.ts's convert() (independently derived in
-- CANONICAL_FX_CONTRACT below), evaluated here on amount_minor (not amount_major) so the exponent
-- shift is applied exactly once, consistently across every currency.
insert into results
select
  'C_EUR_MANUAL', 'EUR', 2, 2, 45.00, 4500, 11.54, 11.54,
  repro_v_total_nok(4500, 11.54),
  round(4500 * 11.54 * 1)::bigint,  -- shift = target(2)-source(2) = 0 -> 10^0 = 1
  repro_v_total_nok(4500, 11.54)::numeric / round(4500 * 11.54 * 1)::numeric,
  'exponent gap 0 -> released formula correct; matches FINANCIAL_MODEL.md E10 worked example (571.23 NOK on 45+4.50 EUR at 11.54, this row isolates the 45.00 EUR line)';

insert into results
select
  'C_EUR_AUTO', 'EUR', 2, 2, 45.00, 4500, 11.54, 11.54,
  repro_v_total_nok(4500, 11.54),
  round(4500 * 11.54 * 1)::bigint,
  repro_v_total_nok(4500, 11.54)::numeric / round(4500 * 11.54 * 1)::numeric,
  'EUR auto path: Norges Bank UNIT_MULT for EUR is 0, so the parser passes through a genuinely per-unit rate -> no double-bug exists for EUR at all, unlike JPY';

-- ============================================================
-- CASE D: USD control — same reasoning as EUR (exponent 2, UNIT_MULT 0).
-- ============================================================
insert into results
select
  'D_USD_MANUAL', 'USD', 2, 2, 100.00, 10000, 9.50, 9.50,
  repro_v_total_nok(10000, 9.50),
  round(10000 * 9.50 * 1)::bigint,
  repro_v_total_nok(10000, 9.50)::numeric / round(10000 * 9.50 * 1)::numeric,
  'exponent gap 0 -> released formula correct for USD';

-- ============================================================
-- CASE E: NOK control (no FX at all; v_fx_rate forced to 1 by the RPC when currency = NOK)
-- ============================================================
insert into results
select
  'E_NOK', 'NOK', 2, 2, 100.00, 10000, 1, 1,
  repro_v_total_nok(10000, 1),
  10000,
  repro_v_total_nok(10000, 1)::numeric / 10000,
  'currency = NOK -> v_fx_rate forced to 1, formula is an identity';

select * from results order by case_id;

-- Machine-checkable pass/fail summary for the two required flags.
select
  case when (select released_sql_total_nok_minor from results where case_id = 'A_MANUAL_JPY')
          = (select correct_total_nok_minor from results where case_id = 'A_MANUAL_JPY')
       then 'MANUAL_JPY_BUG_REPRODUCED=no (bug not present?!)'
       else 'MANUAL_JPY_BUG_REPRODUCED=yes' end as flag_a,
  case when (select released_sql_total_nok_minor from results where case_id = 'B_AUTO_JPY')
          = (select correct_total_nok_minor from results where case_id = 'B_AUTO_JPY')
       then 'AUTO_JPY_DOUBLE_BUG_CANCELLATION_REPRODUCED=yes'
       else 'AUTO_JPY_DOUBLE_BUG_CANCELLATION_REPRODUCED=no (cancellation not observed)' end as flag_b,
  case when (select released_sql_total_nok_minor from results where case_id = 'C_EUR_MANUAL')
          = (select correct_total_nok_minor from results where case_id = 'C_EUR_MANUAL')
       then 'EUR_CONTROL_UNAFFECTED=yes' else 'EUR_CONTROL_UNAFFECTED=no' end as flag_c,
  case when (select released_sql_total_nok_minor from results where case_id = 'D_USD_MANUAL')
          = (select correct_total_nok_minor from results where case_id = 'D_USD_MANUAL')
       then 'USD_CONTROL_UNAFFECTED=yes' else 'USD_CONTROL_UNAFFECTED=no' end as flag_d;
