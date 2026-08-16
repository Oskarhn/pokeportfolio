# Product Specification

Authoritative definition of what PokePortfolio does. Where implementation and this document
disagree, one of them is wrong and the conflict must be resolved, not tolerated.

Monetary behaviour is specified in [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) and is not repeated here.

---

## 1. What this is

A private, invite-only application for tracking a Pokémon TCG collection as both a collection
and a set of financial records.

It answers two families of question that existing apps answer separately or not at all:

1. **What do I own and what is it worth?** — collection, market value, change over time.
2. **What has this hobby actually cost me, and what have I got back?** — a permanent spending
   ledger that survives products being opened, cards being graded, and items being sold.

The distinguishing idea: **money and things have separate lifecycles.** An ETB costing 799 NOK
becomes nine packs which become ninety cards. The 799 NOK does not disappear, does not get
reallocated, and does not become nine cost bases. It stays recorded as money spent, and the
things it produced are tracked separately with their provenance intact.

### 1.1 Target users

The author, plus up to roughly ten invited people. Not a public platform. No social features,
no marketplace, no feeds, no public profiles.

### 1.2 Platforms

| Platform | Status |
|---|---|
| iPhone, installed PWA | Primary. Must be good enough for daily use. |
| Android, installed PWA | Supported by the same codebase. Verified, not separately optimised. |
| Desktop browser | First-class for bulk work, tables, filters, export. |
| Native iOS/Android | Not built. Architecture keeps it possible. |

### 1.3 Non-goals

Explicitly out of scope, now and unless deliberately revisited:

- Tax calculation or tax reporting of any kind
- Deck building
- Marketplace, trading with strangers, price alerts to third parties
- Social features: profiles, follows, comments, chat, feeds
- Trading card games other than Pokémon
- Public signup
- Offline mutation queueing and conflict resolution
- Investment advice, price prediction, "buy/hold/sell" signals

---

## 2. Terminology

Used consistently in code, database, documentation and UI.

| Term | Meaning |
|---|---|
| **Card variant** | A specific printing and finish of a card. The priceable, ownable unit. |
| **Sealed product** | An unopened commercial product: pack, bundle, box, ETB, tin, blister, collection. |
| **Holding** | A distinct thing the user owns in a distinct state — variant + condition + grading state. Carries no money and no quantity. |
| **Acquisition lot** | A quantity of a holding acquired at one time by one means, with its own cost basis. |
| **Purchase** | One receipt. Has one or more lines. Permanent. |
| **Opening** | The event of opening sealed product. Owns the monetary cost; produces pulls. |
| **Pull** | A card obtained from an opening. An acquisition lot with `origin = opening`. |
| **Sale** | One disposal transaction. Has one or more lines, each referencing a specific lot. |
| **Collectible spend** | Money spent on cards, sealed product, grading, and attributable shipping/customs. |
| **Hobby spend** | Money spent on accessories: sleeves, binders, toploaders, tools. |

---

## 3. Scope split

### Foundation — complete

Repository, toolchain, canonical documentation, financial model, data model, architecture,
security model, test strategy, Git/GitHub safety. No application code.

### MVP

The first genuinely usable version. A user can record everything they buy and own, see what it
is worth, sell things, and get their data out.

| Area | Included |
|---|---|
| Auth | Invite-only, email OTP, server-enforced. Admin creates and revokes invitations. |
| Isolation | RLS on every table, verified by automated tests. |
| Catalog | Card search by name, set, collector number. English and Japanese sets. Variant selection. |
| Collection | Add holdings manually. Acquisition lots with date, cost, origin. Condition, language, storage location, tags, favourites. Duplicates as separate lots. |
| Sealed | Sealed products as first-class holdings with their own lots. Manual valuation. |
| Purchases | Multi-line purchases with retailer, shipping, customs, discount, foreign currency, backdating. Deterministic allocation. |
| Spending ledger | Permanent. Collectible vs hobby split. Monthly and per-retailer aggregates. |
| Pricing | Daily Cardmarket-sourced snapshots for held raw cards via TCGdex. Manual valuation for everything else. Freshness states. |
| FX | Daily Norges Bank rates. Historical rates for historical values. Manual override per purchase. |
| Dashboard | Collection value, change, spend figures, position, value history, monthly spend, category breakdown, recent activity. |
| Sales | Multi-line sales with explicit lot selection, fees, shipping. Realized results. |
| Export | CSV export of collection, purchases, sales, lots. |
| Shell | Installable PWA, responsive, dark/light/system, safe areas, offline shell. |

**Deliberately excluded from MVP:** openings, scanner, grading workflow, images, receipts,
bulk desktop editing, JSON backup, import.

### V1

| Area | Included |
|---|---|
| Openings | Full lifecycle with tracked pulls, bulk remainder estimate, opening return, completeness marking. |
| Grading | Submission tracking, state transitions, cost attribution, profitability analysis. |
| Scanner | Camera capture, on-device recognition, bulk session flow. |
| Sealed | Better catalog coverage, improved valuation sources if any become available. |
| Statistics | Richer charts, per-set analysis, best/worst purchases, gainers/losers. |
| Desktop | Multi-select, bulk edit of condition/location/tags, bulk delete. |
| Data | Full JSON backup and restore, CSV import. |
| Images | Own-card photos, receipt attachments. |
| Quality | Real-device iOS testing, Android verification, PWA install polish. |

### Later

Trades, wishlist with target prices, set completion tracking, price alerts, read-only share
links, push notifications, receipt OCR, native clients, configurable condition multipliers,
cross-language card equivalence.

---

## 4. Feature behaviour

Acceptance-level statements. Implementation detail belongs in ARCHITECTURE and DATA_MODEL.

### 4.1 Accounts

- An account exists only if an invitation was redeemed. No other path creates one.
- Login is an email address plus a six-digit code sent to it. The entire flow stays inside the
  installed app.
- The admin can create, label, revoke and expire invitations, and disable accounts.
- The admin cannot view another user's collection or financial data through the application.
- A user can export their data and delete their account. Deletion is irreversible and says so.

### 4.2 Collection

- Cards are found by name, set, or collector number, then a specific variant is chosen.
- Adding a card requires: variant, condition, language (implied by set), quantity, acquisition
  date, and either a cost or an explicit origin that has no cost.
- Three copies of one card bought at three prices are one holding with three lots. The
  collection list shows one row with quantity 3; the detail view shows all three lots with their
  dates and costs.
- A holding never displays an averaged cost basis as if it were a single purchase price.
- Graded copies are separate holdings from raw copies of the same variant.
- Condition is recorded and used for filtering, sorting and export. It does **not** adjust
  market value in MVP, because the price source is not condition-specific, and the UI says so.

### 4.3 Purchases

- A purchase is one receipt with one or more lines. Lines may mix cards, sealed product,
  grading fees and accessories.
- Shipping, customs and discounts are entered once at purchase level and allocated across lines
  automatically. The allocation is visible and explained in the UI, not hidden.
- Purchases may be backdated to any date.
- A purchase in EUR/USD/GBP stores the original amounts and a frozen NOK conversion. The FX rate
  is prefilled from Norges Bank for the purchase date and can be overridden.
- Recording a purchase of a card or sealed product offers to create the corresponding holding
  and lot in the same step.
- **A purchase is never deleted as a side effect of anything else.** Opening a product, selling
  an item, grading a card — none of these alter purchase history.

### 4.4 Sealed inventory

- Sealed products are holdings with lots, priced by manual valuation until a legitimate source
  exists.
- Sealed value is shown as a distinct segment of collection value, never merged silently with
  card value.
- Manual valuations are visibly marked as manual, with the date they were set.

### 4.5 Openings — V1

- An opening links to a sealed lot the user owns, or stands alone with a manually stated cost.
- Opening a linked product reduces the sealed lot and preserves the purchase.
- The user records the pulls worth recording. Recording every card is possible but never required.
- The user declares whether tracking is complete. When it is not, every display of opening
  return carries an incompleteness marker.
- An optional bulk remainder estimate covers cards not individually recorded.
- Opening return compares cost against retained pull value plus proceeds from sold pulls plus
  the bulk estimate.
- **An individual pull never shows a cost basis of 0 NOK, and never shows a per-card ROI.**
  It shows "from opening" with a link.
- Selling a pull remains attributable to its opening permanently.

### 4.6 Sales

- A sale has one or more lines, each referencing a specific acquisition lot.
- The UI suggests oldest-first lot selection and the user can change it. The chosen lot is
  recorded permanently.
- Fees and outbound shipping reduce net proceeds; shipping charged to the buyer offsets it.
- Realized result is shown only where the sold lot had a cost basis. Where it did not, the sale
  is reported as proceeds, not as profit.
- Sold items leave current collection value from the sale date forward and do not retroactively
  vanish from history.

### 4.7 Valuation

- Held raw cards are revalued daily from Cardmarket data via TCGdex, in EUR, converted at that
  day's rate.
- Every value carries provenance: source, source currency, source value, FX rate, and timestamp.
- Values are `fresh`, `stale`, `missing` or `manual`. Stale values are used and marked. Missing
  values are excluded from collection value and the count of unvalued holdings is displayed.
- A provider failure never sets a value to zero.
- Manual valuation always wins and never overwrites the automatic value.
- A graded card is never valued from raw-card prices.

### 4.8 Dashboard

Top-level figures: collection value; latest change in NOK and percent; net invested in
collectibles; overall position; realized sales result; hobby spend this month.

Below: collection value over time (1M/3M/1Y/ALL initially), monthly spend, raw/sealed/graded
breakdown, recent activity.

Value history begins when tracking begins. The chart shows a clear origin point rather than
extrapolating backwards. No figure is labelled as a return unless it mathematically is one.

### 4.9 Search and filtering

Search by card name, Pokémon, set, collector number. Filter by set, rarity, condition, language,
grading state, grader, grade, storage location, tag, favourite, value range, acquisition date
range, origin, holding kind.

Desktop exposes the full filter set; mobile exposes a curated subset plus a search field.
Filter state lives in the URL and is shareable and bookmarkable — except during a scanner
session, where it is component state (see ARCHITECTURE §6).

### 4.10 Export

MVP exports CSV for collection, lots, purchases, purchase lines and sales, with enough
provenance for external analysis: original currency, FX rate and source, cost basis, dates,
origin, disposal records.

V1 adds a complete JSON backup covering everything user-owned.

---

## 5. Interaction principles

- **Correction is cheap.** Every financial record is editable or voidable, and the UI names the
  downstream impact before acting.
- **Uncertainty is visible.** Stale, manual, incomplete and estimated figures are marked at the
  point of display, not in a footnote.
- **Provenance is reachable.** Any number can be traced to its source in at most two taps.
- **Mobile is for capture, desktop is for management.** Adding a purchase must be fast on a
  phone; bulk editing 200 rows belongs on a desktop.

---

## 6. Assumptions recorded

Made to avoid blocking; revisit if any turns out to be wrong.

| Assumption | Basis |
|---|---|
| Collection reaches 2 000–5 000 cards | Stated as the planning target |
| Existing collection data may be imported later | No current export supplied |
| English and Japanese cover realistic needs | Stated V1 priority |
| Trades are not needed in V1 | Deferred; schema is ready |
| No paid pricing API | Zero recurring cost is the stated target |
| Around 5–10 users maximum | Stated |
| Norwegian locale, English UI | Decided; locale and language are decoupled |

---

## 7. Unresolved product questions

None block MVP. Each is recorded where it will be needed.

| Question | Needed by |
|---|---|
| Cost-basis rule for trades — carryover or fair value | Trades (Later) |
| Whether bulk lots should become tracked holdings | Openings (V1) |
| How curated sealed catalog entries get promoted from user-created ones | Sealed improvements (V1) |
| Whether condition multipliers should ever be offered | Later, only with real data |
| Whether a paid pricing source becomes worth its cost | Reassess after 6 months of use |
