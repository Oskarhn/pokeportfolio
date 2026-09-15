-- P135 §10: coordinated-deployment adversarial analysis for P130-02, computed against an isolated
-- bare Postgres 17 container (no Supabase, no Production, no network).
--
-- "old SQL"    = the RELEASED formula, verbatim from cff3bbd: round(v_total::numeric * v_fx_rate)
-- "new SQL"    = an exponent-aware formula: round(v_total::numeric * v_fx_rate * 10^(target_exp-source_exp))
-- "old parser" = the RELEASED norges-bank.ts: passes the raw SDMX number through unmodified
-- "new parser" = a UNIT_MULT-aware parser: divides the raw SDMX number by 10^UNIT_MULT before storing
--
-- Fixed input for every cell: a genuine JPY auto-sourced purchase, 10000 JPY, raw Norges Bank
-- observation for JPY = 6.0375 (UNIT_MULT=2, i.e. "NOK per 100 JPY" -> true per-unit rate
-- 0.060375). Economically correct total_nok_minor = 60375 (603.75 NOK) in every cell — a
-- correctly-deployed system must reach 60375 regardless of which combination is live at write
-- time; anything else is silent financial corruption of a NEW row (existing frozen rows, F11, are
-- a separate question — see HOSTED_DATA_DECISION_TREE in output_135.txt).

drop table if exists deploy_matrix;
create table deploy_matrix (
  cell text,
  sql_version text,
  parser_version text,
  stored_fx_rate_to_nok numeric(18,8),
  total_nok_minor bigint,
  correct_total_nok_minor bigint,
  error_factor numeric,
  verdict text
);

-- old SQL: round(total_minor * rate)          -- no exponent shift
-- new SQL: round(total_minor * rate * 100)    -- exponent shift baked in for this JPY/NOK pair
-- old parser stores raw 6.0375; new parser stores normalized 0.060375

insert into deploy_matrix values
  ('1_OLD_SQL_OLD_PARSER', 'old', 'old', 6.0375,
   round(10000 * 6.0375)::bigint, 60375,
   round(10000 * 6.0375)::bigint::numeric / 60375,
   null),
  ('2_NEW_SQL_OLD_PARSER', 'new', 'old', 6.0375,
   round(10000 * 6.0375 * 100)::bigint, 60375,
   round(10000 * 6.0375 * 100)::bigint::numeric / 60375,
   null),
  ('3_OLD_SQL_NEW_PARSER', 'old', 'new', 0.060375,
   round(10000 * 0.060375)::bigint, 60375,
   round(10000 * 0.060375)::bigint::numeric / 60375,
   null),
  ('4_NEW_SQL_NEW_PARSER', 'new', 'new', 0.060375,
   round(10000 * 0.060375 * 100)::bigint, 60375,
   round(10000 * 0.060375 * 100)::bigint::numeric / 60375,
   null);

update deploy_matrix set verdict = case
  when error_factor = 1 then 'CORRECT'
  when error_factor > 1 then 'OVERSTATED x' || error_factor::text
  else 'UNDERSTATED (x' || (1/error_factor)::text || ' too small)'
end;

\pset border 2
select cell, sql_version, parser_version, stored_fx_rate_to_nok, total_nok_minor,
       correct_total_nok_minor, verdict
from deploy_matrix order by cell;
