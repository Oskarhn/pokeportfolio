# Product Specification

Authoritative definition of what PokePortfolio does. Where implementation and this document
disagree, one of them is wrong and the conflict must be resolved, not tolerated.

Monetary behaviour is specified in [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) and is not repeated here.

**Terminology note (M7, DECISIONS.md D-040).** "Collection" below is the ordinary noun — a
person's collection of cards — describing product behaviour. Where this document means the
specific user-facing screen that browses owned cards, that screen is named **Portfolio**
(`/portfolio`) in the actual UI, navigation and copy. Internal domain/table naming
(`holdings`, `holding_summaries`, the `custom_collection` concept itself) is unaffected — only the
one owned-card-browsing screen's user-facing name changed.

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
| **Acquisition origin** | How a lot was obtained: purchased, pulled, gifted, traded in, pre-tracking, other. |
| **Cost-basis state** | Whether a lot's cost is `known`, or absent because it is `unallocated_opening`, `not_paid`, `unknown` or `trade_in`. Never zero. |
| **Custom collection** | A user-named group of holdings. Purely organisational; many per holding. |
| **Smart filter** | A rule evaluated at read time, such as "below 10 kr" or "no price". Never stored as membership. |
| **History** | The area for items no longer owned: sold, traded, other disposals. |

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
| Auth | Invite-only, email + password, server-enforced. Admin creates and revokes invitations. |
| Isolation | RLS on every table, verified by automated tests. |
| Catalog | Card search by name, set, collector number. English and Japanese sets. Variant selection. Basic Energy and every other card are ordinary catalog entries. |
| Collection | **Every physical card individually trackable**, including energies, commons and duplicates. Holdings with acquisition lots. Condition, language, storage location, tags, favourites. |
| Acquisition | Explicit origin: purchased / pulled / gifted / traded in / pre-tracking / other, with cost state rather than a nullable amount. |
| Organisation | User-defined custom collections (many-to-many), smart value filters, configurable low-value threshold, "no price" filter. |
| Display | Mobile gallery, **2 columns by default**, user-settable 1–4. List and desktop table views. |
| Sealed | Sealed products as first-class holdings with their own lots and a `keep / plan to open` intent. Manual valuation. |
| Graded | Graded cards as a collection type: grader, grade, optional cert number, manual value, normal portfolio inclusion. |
| Purchases | Multi-line purchases with retailer, shipping, customs, discount, foreign currency, backdating. Deterministic allocation. |
| Spending ledger | Permanent. Collectible vs hobby split. Monthly and per-retailer aggregates. |
| Pricing | Daily Cardmarket-sourced snapshots for held raw cards via TCGdex. Manual valuation elsewhere. Freshness states. Missing price surfaced, never zero. |
| FX | Daily Norges Bank rates. Historical rates for historical values. Manual override per purchase. |
| Dashboard | Collection value primary, position prominent. Change, spend figures, realized result, value history, monthly spend, breakdowns, data-quality counts. |
| Sales | Multi-line sales with explicit lot selection, fees, shipping. Realized results where a cost basis exists. |
| History | Dedicated area for items no longer owned: sold, traded, other disposals. |
| Export | CSV exports **and** full versioned JSON backup. |
| Shell | Installable PWA, responsive, dark/light/system, safe areas, offline shell. |

**Deliberately excluded from MVP:** openings, scanner, full grading workflow, trade workflow,
images and receipts, bulk desktop editing, CSV import.

### V1 — in priority order

| # | Area | Included |
|---|---|---|
| 1 | **Scanner** | Camera capture, on-device recognition, bulk session flow with session defaults. Highest post-MVP priority because manual entry is the bottleneck created by all-card tracking. |
| 2 | **Openings** | Full lifecycle, all-cards tracking by default, hits-only option, bulk remainder estimate, opening return with completeness marking, provisional-cost reconciliation UI. |
| 3 | Grading workflow | Submission, pending, return, cost attribution, profitability analysis. |
| 4 | Trades | Full workflow over the schema already in place; item-leg accounting rule decided first. |
| 5 | Desktop bulk tooling | Multi-select, batch condition/location/tags/collections, bulk delete. |
| 6 | Statistics | Per-set analysis, best/worst purchases, gainers and losers. |
| 7 | Images | Own-card photos, receipt attachments. |
| 8 | Data | CSV import, restore from JSON backup. |
| 9 | Quality | Real-device iOS testing, Android verification, PWA install polish. |

### Later

Wishlist with target prices, set completion tracking, price alerts, opt-in read-only share
links, push notifications, receipt OCR, native clients, configurable condition multipliers,
cross-language card equivalence.

---

## 4. Feature behaviour

Acceptance-level statements. Implementation detail belongs in ARCHITECTURE and DATA_MODEL.

### 4.1 Accounts

- An account exists only if an invitation was redeemed. No other path creates one.
- Login is email plus password. No email is sent during normal login, so the flow works entirely
  inside the installed app and does not depend on mail delivery.
- Invitations are one-time links the admin generates in the app and shares over whatever
  messaging channel they prefer. The app does not send invitation email.
- Password reset is rare at this scale and uses the platform's low-volume built-in email, with
  an admin-assisted recovery path as the documented fallback.
- The admin can create, label, revoke and expire invitations, and disable accounts.
- The admin cannot view another user's collection or financial data through the application.
- A user can export their data and delete their account. Deletion is irreversible and says so.

### 4.2 Portfolio

**Every physical card is trackable.** Basic Energy, commons, uncommons, duplicates, cards worth
two øre, cards with no market price at all — all are ordinary first-class inventory. Nothing is
forced into a bulk aggregate to keep the interface tidy; organisation solves that instead (§4.3).
A user who wants to register ten thousand individual cards can.

The one bulk concept that exists is an optional per-opening remainder estimate for cards the user
chose not to enter individually. It is a convenience, never a substitute.

- Cards are found by name, set, or collector number, then a specific variant is chosen.
- Adding a card requires: variant, condition, quantity, acquisition date, and an explicit
  acquisition origin. Language is implied by the set.
- **Acquisition origin is always explicit** — purchased, pulled, gifted, traded in, pre-tracking,
  other. For a purchase the cost is prominent and normally required; the user may choose "cost
  unknown" deliberately. For every other origin no cost field is shown at all.
- **A missing cost is never displayed as 0 NOK.** The card shows why there is no cost: "from
  opening", "gift", "cost unknown".
- Three copies bought at three prices are one holding with three lots. The list shows one row
  with quantity 3; the detail view shows every lot with its date, cost and origin.
- A holding never displays an averaged cost basis as if it were a single purchase price.
- Graded copies are separate holdings from raw copies of the same variant.
- Condition is recorded and used for filtering, sorting and export. It does **not** adjust
  market value in MVP, because the price source is not condition-specific, and the UI says so.
- Two counts are shown and are different numbers: **physical cards owned** and **unique variants**.
- **Quantity can be corrected or removed directly from a holding's detail page** (P28): quantity
  1 offers "Remove from Portfolio"; quantity > 1 offers "Adjust quantity" and "Remove all".
  Removal follows the void lifecycle; reduction shrinks the explicitly-chosen non-purchase lot(s)
  and never touches money. A purchased lot's quantity belongs to its receipt — the UI routes to
  purchase correction instead. A correction here is **not** a sale: no proceeds, no realized
  result. An adjustment can never empty a holding; dropping one specific lot while siblings keep
  units goes through that lot's own Void action (D-072).

### 4.3 Organising a large collection

Because nothing is aggregated away, organisation carries the weight that bulk aggregation
normally would. Four distinct concepts, deliberately not merged:

| Concept | Question it answers |
|---|---|
| Storage location | Where is this card physically? One per card. |
| Custom collection | What group did I put it in? Many per card. |
| Tag | Free-form label. Many per card. |
| Smart filter | What matches this rule right now? Computed, never stored. |

- **Custom collections** are user-named groups: *Trade Binder*, *Favourites*, *151 Master Set*,
  *Childhood Cards*, *Sell*. A card can be in several. Adding or removing changes nothing about
  ownership, value or cost.
- **Smart filters** include a user-configurable low-value threshold (default 10 NOK) and a
  separate "no price" filter. These are different things and are never conflated: a card with no
  price is not a cheap card.
- Low-value cards remain in the collection, in the physical card count, and in collection value.
  The user may collapse them out of the default browsing view; the count of hidden cards stays
  visible. **Hiding is not deletion.**

### 4.4 Portfolio display

- Mobile default is an image-led gallery at **2 cards per row**, user-settable to 1, 2, 3 or 4
  and persisted per user. Higher densities show compact tiles with less metadata; that is the
  explicit trade the setting makes, and it is not overridden by design preference.
- List view and desktop table view are available for tasks where scanning rows beats images.
- Tapping a card always opens full detail with its lots.
- Images are lazy-loaded and sized to the current density. A large collection must never issue
  thousands of image requests on mount.

### 4.5 Purchases

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

### 4.6 Sealed inventory

- Sealed products are holdings with lots, priced by manual valuation until a legitimate source
  exists.
- Sealed value is shown as a distinct segment of collection value, never merged silently with
  card value.
- Manual valuations are visibly marked as manual, with the date they were set.

### 4.7 Openings — V1

- An opening links to a sealed lot the user owns, or stands alone with a manually stated cost.
- **A manually stated cost creates a real ledger entry** so the money appears in lifetime
  spending. Linking the real purchase later voids the provisional entry — the money is never
  counted twice. See [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §5.5.
- Opening a linked product reduces the sealed lot and preserves the purchase.
- **Default tracking mode is every card**, consistent with all-card tracking. A hits-only mode
  exists for users who do not want to enter 360 cards from a booster box.
- The user declares whether tracking is complete. When it is not, every display of opening
  return carries an incompleteness marker.
- Opening result is shown in kroner first, percentage second.
- An optional bulk remainder estimate covers cards not individually recorded.
- Opening return compares cost against retained pull value plus proceeds from sold pulls plus
  the bulk estimate.
- **An individual pull never shows a cost basis of 0 NOK, and never shows a per-card ROI.**
  It shows "from opening" with a link.
- Selling a pull remains attributable to its opening permanently.

### 4.8 Sales

- A sale has one or more lines, each referencing a specific acquisition lot.
- The UI suggests oldest-first lot selection and the user can change it. The chosen lot is
  recorded permanently.
- Fees and outbound shipping reduce net proceeds; shipping charged to the buyer offsets it.
- Realized result is shown only where the sold lot had a cost basis. Where it did not, the result
  column reads **—** with "cost basis unknown" — never a profit figure derived from a missing cost.
- Sold items leave current collection value from the sale date forward and do not retroactively
  vanish from history.

### 4.8.1 History — what I no longer own

A dedicated area, separate from Portfolio. Portfolio answers *what do I own now*; History
answers *what did I own, and what happened to it*. Disposed items never clutter the active
Portfolio view by default.

Sections: **Sold**, **Traded**, **Other disposals** (write-offs, corrections).

A sold entry shows: card, quantity, sale date, marketplace, gross, fees, shipping, net proceeds,
acquisition origin, cost basis if known, and realized result if defensible.

Sorting includes newest, highest proceeds, highest result, largest loss, item and marketplace.
**Sorting by result must place unknown-basis rows in their own group** rather than treating them
as zero cost — otherwise every sold gift ranks as the most profitable sale ever made.

A traded-away entry shows the trade it belonged to, the items on both sides, market values at
trade date where recorded, and the cash legs. No fabricated profit figure.

### 4.9 Valuation

- Held raw cards are revalued daily from Cardmarket data via TCGdex, in EUR, converted at that
  day's rate.
- Every value carries provenance: source, source currency, source value, FX rate, and timestamp.
- Values are `fresh`, `stale`, `missing` or `manual`. Stale values are used and marked. Missing
  values are excluded from collection value and the count of unvalued holdings is displayed.
- A provider failure never sets a value to zero.
- Manual valuation always wins and never overwrites the automatic value.
- A graded card is never valued from raw-card prices.

### 4.10 Dashboard

**Collection value is the visually primary number.** This remains a collection application first.
But spending is never buried: overall position sits immediately alongside it, large enough that
the cost of the hobby is impossible to miss.

Six top-level figures, using the exact terms defined in
[FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §9:

1. Collection value — primary
2. Latest market-value change, NOK and percent
3. Total hobby spend
4. Net invested in collectibles
5. Realized sales result
6. Overall position — prominent, adjacent to (1)

**Data quality is shown with the value, not hidden.** Directly beneath collection value:

```
Collection value        42 580 kr
Automatic pricing       35 200 kr
Manual valuation         7 380 kr
4 649 priced · 74 without a price
```

Secondary: value over time (1M/3M/1Y/ALL initially), monthly spend, raw/sealed/graded split,
physical card count and unique variant count, cards without a recorded cost, recent activity.

Value history begins when tracking begins. The chart shows a clear origin point rather than
extrapolating backwards. No figure is labelled as a return unless it mathematically is one.

### 4.11 Search and filtering

Filtering carries more weight here than in most collection apps, because nothing is aggregated
away — it is the mechanism that keeps ten thousand cards navigable.

Search by card name, Pokémon, set, collector number. Filter by set, rarity, condition, language,
variant, grading state, grader, grade, storage location, custom collection, tag, favourite, value
range, low-value threshold, **missing price**, acquisition origin, cost-basis state, purchase date
range, quantity, holding kind, and currently owned versus previously owned.

Desktop exposes the full filter set; mobile exposes a curated subset plus a search field.
Filter state lives in the URL and is shareable and bookmarkable — except during a scanner
session, where it is component state (see ARCHITECTURE §6).

### 4.12 Export

Both formats ship in MVP.

**CSV** for collection, lots, purchases, purchase lines and sales, with enough provenance for
external analysis: original currency, FX rate and source, cost basis and its state, dates,
origin, disposal records.

**JSON backup** covering everything user-owned. This is the primary portable emergency backup, so
it carries a schema version and an export timestamp in its envelope. A backup that becomes
unreadable after one migration is not a backup; the version field is what makes forward migration
of old exports possible.

The application never claims that backups happen automatically. They do not — see
[COST_POLICY.md](COST_POLICY.md). MVP includes a periodic in-app reminder to export, and the
repository includes a local script for a full logical dump.

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
| Collection may reach 10 000+ physical cards across perhaps 3 000–4 000 distinct variants | Follows from every card being individually tracked |
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
| Cost-basis rule for the item legs of a trade — carryover or fair value | Trades (V1) |
| Whether TCGdex models Basic Energy printings well enough for per-printing tracking | Catalog ingest (MVP) |
| How curated sealed catalog entries get promoted from user-created ones | Sealed improvements (V1) |
| Whether condition multipliers should ever be offered | Later, only with real data |
| Whether a paid pricing source becomes worth its cost | Reassess after 6 months of use |
