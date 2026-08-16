# Engineering Journal

A factual record of problems solved and choices made, written for someone reading this
repository later to understand what was actually engineered.

Not a changelog ([CHANGELOG.md](../CHANGELOG.md) covers releases) and not a work log. Entries go
here when there was a real problem with a non-obvious answer.

---

## 2026-08-16 — Every marketplace API is closed; the pricing architecture had to route around it

**Problem.** The application needs European card prices in EUR. The two obvious sources are
Cardmarket and TCGplayer. Both are closed: Cardmarket states it is not accepting API
applications, and TCGplayer's public developer programme has been shut to new entrants since
roughly late 2024. pokemontcg.io, the best-known free catalog, returned HTTP 500 on two separate
probes and its maintainers have moved to a commercial product.

**Investigation.** Rather than trusting comparison articles — most of which turned out to be
content marketing for their own paid APIs — every candidate was probed directly from the
development machine.

**Finding.** TCGdex, a community-maintained MIT-licensed catalog, relays Cardmarket price points
in EUR and TCGplayer price points in USD, per card variant, with no API key. Verified live:
23 444 English cards across 218 sets, 177 Japanese sets, and a `variants_detailed[].pricing`
structure carrying `trend`, `low`, `avg`, `avg1`, `avg7` and `avg30` in EUR with a same-morning
timestamp.

**Consequence.** TCGdex became the catalog and raw-pricing foundation. Because it is
community-run with no SLA, three mitigations were designed in from the start: a provider
abstraction so no business code references provider field paths; internal UUID identity with
provider ids as nullable mapping columns, so the provider disappearing breaks nothing; and our
own snapshot table, so the accumulated price history is ours regardless of what happens upstream.

**Also learned.** The licensing question has three separate answers that are easy to conflate:
the database is MIT, the card artwork is copyright of The Pokémon Company, and the relayed
marketplace price data has undocumented provenance. An MIT licence on the first grants nothing
over the second or third. Recorded as an open uncertainty rather than resolved by assumption.

---

## 2026-08-16 — Pack-opening cost attribution: the zero-cost trap

**Problem.** An ETB costing 799 NOK is opened and produces cards. Those cards must appear in the
collection with a value, without breaking the accounting.

**First answer, wrong.** The opening keeps the cost; pulls get a cost basis of zero. Arithmetically
this produces correct portfolio totals — the 799 is counted once, the pulls are counted once.

**Why it was wrong.** A card with a cost basis of 0 and a market value of 400 displays as
infinite return. Every pulled card becomes a spectacular investment. The number is technically
derived from correct inputs and is completely misleading, which is worse than being obviously
wrong.

**Resolution.** The distinction is between *zero* and *not applicable*. Pull lots store `NULL`,
not `0`, and the system treats `NULL` cost basis as a distinct case throughout: no ROI is
computed, no cost field is displayed, and the UI says "from opening — no individual purchase
cost". Return is computed at opening scope, where the question is well-posed:
retained pull value + proceeds from sold pulls + bulk estimate − cost.

**Consequence.** An invariant that `NULL` money never means zero, enforced by a check constraint
and asserted by test. Every aggregate handles the `NULL` branch explicitly. The cost is
additional care in every query; the benefit is that no screen can show a fabricated return.

**Generalisation.** This is the same class of error as filling a chart's history with today's
price. Both produce a plausible number from an absent fact. The rule adopted across the project:
absent data is displayed as absent.

---

## 2026-08-16 — Condition multipliers: invented precision, caught before implementation

**Problem.** Cards have condition grades. Market prices should presumably reflect them.

**First answer, wrong.** A multiplier table — NM 100%, EX 85%, GD 70%, LP 55%, PL 40%, PO 25%.

**Why it was wrong.** Those percentages had no source. They were plausible-looking numbers with
no derivation, and applying them would produce a portfolio value carrying two decimal places of
apparent precision on top of a guess. Cardmarket's published price points are not
condition-specific, so there was no data to calibrate against either.

**Resolution.** Condition is stored as a real property and used for filtering, sorting and
export. It does not adjust value. The UI states that the reference price is for the printing,
not for the specific copy. Manual valuation covers a played card honestly.

**Consequence.** Less convenient, more truthful. Configurable multipliers remain possible later,
but only as an opt-in, user-set, visibly-marked estimate.

---

## 2026-08-16 — iOS camera lifecycle constrained the routing architecture

**Problem.** Bulk card scanning is a core product goal. The primary platform is an installed iOS
PWA.

**Finding.** WebKit does not persist camera permission across URL changes in standalone mode.
Bug 215884 has been open since 2020 and remains unresolved in 2026. A scanner that navigates per
card would prompt for camera permission on every card. The commonly suggested workaround is
granting Safari blanket camera access, which is not something to require of a user.

**Consequence.** The routing architecture was fixed before any scanner code exists: one route
owns the session and one `MediaStream`, per-card confirmation is an in-route overlay, and no
navigation or URL mutation occurs while the camera is live. This makes the scanner route the one
documented exception to the app-wide convention that filter state lives in the URL.

**Why decide it now.** The scanner is scheduled several phases out. Discovering this constraint
after building it would mean rewriting its routing; encoding it now costs a paragraph of
documentation. The underlying assumption still needs validating on real hardware with a
throwaway page before the scanner phase begins — an open browser bug report is evidence, not
proof of current behaviour.

---

## 2026-08-16 — Storage ceiling shaped the price-history design

**Problem.** Portfolio charts need a real price history, and no free source provides one, so it
must be accumulated. Supabase's free plan caps the database at 500 MB.

**Arithmetic.** Snapshotting all 23 400 English variants daily at roughly 48 bytes per row is
about 410 MB per year — over 80% of the ceiling, for data covering cards nobody owns.

**Resolution.** A `watched_card_variants` view drives ingestion: only variants a user holds or
has held. At an assumed 3 000 watched variants across two price kinds, roughly 105 MB per year,
with rows older than twelve months thinned to weekly.

**Accepted limitation.** A variant's price history begins when it is first acquired, not when
the app started. Documented rather than hidden, and preferable to the alternative of
backfilling with today's price.

---

## Real-device testing log

Recorded as it happens. Emulation is not evidence of Safari behaviour.

| Date | Device / OS | Tested | Result |
|---|---|---|---|
| — | — | — | Not yet performed |
