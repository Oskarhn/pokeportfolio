-- Integrity snapshot of the ledger tables: row counts and an order-independent content hash per
-- table (md5 over the sorted row texts). Run before and after a migration batch; the hashes of
-- columns that existed before must not change. Reads only; prints no row content.
select t.tbl,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.tbl), false, true, '')))[1]::text as rows,
       (xpath('/row/h/text()', query_to_xml(format('select md5(coalesce(string_agg(x::text, ''|'' order by x::text), '''')) as h from (select * from public.%I) x', t.tbl), false, true, '')))[1]::text as content_md5
from (values ('purchases'),('purchase_lines'),('acquisition_lots'),('lot_disposals'),('sales'),('sale_lines'),
             ('openings'),('holdings'),('manual_valuations'),('sealed_products'),('invitations'),('fx_rates'),
             ('price_snapshots'),('profiles')) as t(tbl)
order by t.tbl;
