# UX Flows

Behavioural specification for the workflows that matter. Written to be directly testable —
[TESTING.md](TESTING.md) §6 draws its E2E cases from here.

Notation: **→** step · **⚠** failure or edge case · **✓** completion criterion

---

## F0 — Primary navigation (M7.1, supersedes M7's five-tab bar — DECISIONS.md D-043)

Four direct destinations, always reachable, plus a central quick-add action (F11.1) that is an
action, never a fifth destination. Intentionally symmetrical: two either side of **+**.

| Destination | Route | What it is |
|---|---|---|
| **Home** | `/` | The investment-style portfolio dashboard (F10). Scope selector, currency preference and value-privacy control; honestly-marked "not available yet" wherever a real value or chart would render once M9/M12 exist. |
| **Search** | `/catalog` | Cards and Sets modes, a dominant top search field, a vertical English-only set showcase, per-result quick-add (F2 below), a camera affordance reserved for M15 (F11.1), reserved layout for a future value column (M9). |
| **Portfolio** | `/portfolio` | The user's owned-card browser — a top search field scoped to owned cards, favourite filter, an action menu (sort/select), grid/list/table, density, quick + full filters, custom collections (F8.2/F8.3), select-mode bulk actions (F8.4). User-facing name for what the schema still calls a holding/collection (DECISIONS.md D-040). |
| **Profile** | `/profile` | Account identity and settings hub — display name, theme (now functional, light/dark/system), Portfolio display defaults, low-value threshold, European-pricing preference, preferred card language, admin invitations (admins only), sign out, provider attribution and app version. |

**More is gone (D-043).** Its one real function — admin invitations — moved into Profile;
`/more` remains as a redirect to `/profile` so no bookmarked link breaks. Mobile: a fixed,
translucent bottom navigation bar with the central **+** raised above it, centred over the gap
between Search and Portfolio (`src/features/nav/BottomNav.tsx`). Desktop: a single top navigation
row covering the same four destinations plus Add (`DesktopNav.tsx`). Safe-area-aware on both; the
bottom bar never covers scrollable content (AppShell reserves matching bottom padding). No global
"PokePortfolio" wordmark in authenticated chrome any more — brand appears only on Home (mobile)
and the authentication screens.

---

## F1 — Invitation and first login

**Admin creates an invitation**

→ Invitations › enter the recipient's email address
→ Optional note for the admin's own bookkeeping
→ Expiry defaults to 7 days, uses to 1
→ The link is displayed **once**, with a copy button and a plain statement that this is the only
  time it is shown
→ The admin sends it over a channel they already trust — Signal, iMessage, in person. The
  application never emails it.
✓ Only the hash is stored; the plaintext is never retrievable, by anyone, including the admin
✓ The outstanding list shows address, status and expiry, and offers Revoke while a link is active

**Recipient redeems**

→ Opens the link on their phone
→ Sees the address the account will be created for — they do not type it, and cannot change it
→ Chooses a password twice, with the platform password manager offering to generate and save one
→ Account and profile created, signed in, landed on the app
✓ No email, no code to wait for, nothing to rate-limit
✓ The invitation URL is replaced rather than pushed, so the raw token is not one Back press away

⚠ Expired, revoked, already used or simply wrong → one message: the link is not valid, ask for a
  new one. The distinction is visible to the admin in the invitations list, not to the public
  caller, because naming which one confirms facts about invitations to someone who may not hold a
  valid token.
⚠ A password below the minimum → the invitation stays usable; a typo does not burn a link
⚠ No token at all → account creation is rejected server-side by two independent gates, not merely
  hidden. There is no "create account" control anywhere in the interface, but its absence is
  presentation, not the control.

**Returning login**

→ Email → password → in
✓ No email is sent. Nothing to wait for, nothing to rate-limit.
✓ Works with the platform password manager on iOS
✓ Session survives app switch, cold start and reload

⚠ Forgotten password → reset email via the built-in low-volume provider. Rare by design. The form
  confirms the same way whether or not the address has an account.
⚠ If delivery fails, the owner confirms identity out of band and generates a recovery link by
  hand — documented in SECURITY.md §5.8, not improvised. An admin never sets someone's password.

---

## F2 — Add a card manually

**M6/M7 status.** The central mobile **+** and its bottom navigation shipped in M7
(`src/features/nav/BottomNav.tsx`/`QuickAddMenu.tsx`) — see F13 below. Two differences remain
worth recording rather than silently deviating from: (1) F2.1's session defaults are still not
implemented — `add_card_acquisition`'s argument shape was deliberately designed so the scanner
(M15) can supply them later without a business-logic change, but nothing pre-fills them yet;
(2) "Existing collection" is this document's `pre_tracking` origin, cost-unknown by construction.
See HANDOVER.md for the exact routes (`/portfolio` as of M7, D-040).

The most-used flow after the ledger. Target: under 20 seconds on a phone.

→ Collection › Add (or the central **+** on mobile)
→ Search by name, or by set plus collector number
→ Results show thumbnail, name, set, number, rarity
→ Select the card, then the variant (normal / reverse / holo)
→ Set condition, quantity, acquisition date (defaults to today)
→ **Choose acquisition origin** — a segmented control, not a dropdown, because it drives what
  appears next:

| Origin | What the form shows |
|---|---|
| Purchased | Cost field, prominent and focused. Currency defaults NOK. Optional link to an existing purchase. A "cost unknown" toggle exists but must be chosen deliberately. |
| Pulled | Optional opening reference. **No cost field at all.** |
| Gifted | No cost field. |
| Traded in | Optional trade reference. No cost field. |
| Pre-tracking | No cost field. Copy: "cost not recorded". |

→ Optional: storage location, custom collections, tags, favourite, notes
→ Save
✓ Appears in the collection with the correct lot and origin
✓ Dashboard figures move by exactly the expected amount

⚠ The card already exists in the same state → the same holding gains **a new lot**. The UI says
  so explicitly: "Adding a second lot to an existing holding." It never averages.
⚠ Origin is `purchased` with no cost and no explicit "cost unknown" → blocked (M2)
⚠ Any non-purchase origin → the cost field is **absent**, not empty and not zero

### F2.1 — Fast repeated entry

Entering hundreds of cards by hand is the reality until the scanner ships, so the add flow keeps
session defaults: origin, condition, language, storage location, target custom collection and
cost handling persist between saves within a session and are shown as a compact header the user
can change. Saving returns focus to the search field.

**No accounting form for an energy card.** Adding a Basic Energy with session defaults set should
be: search, tap, save. The scanner will reuse exactly these session defaults.

### F2.2 — Search: cards, sets and per-result quick-add (shipped M7)

→ Search (F0) › Cards/Sets segmented control
→ **Cards mode**: results as before, each row now carries a **+** independent of the row's own
  tap target (M7 prompt §15-17) — tapping the row opens card detail, tapping **+** starts adding
  it
→ A card with exactly one ownable variant: **+** preselects it and goes straight to `/add`
→ A card with several variants: **+** opens card detail, which already lists every variant with
  its own add action — the required variant-selection step, not duplicated
→ **Sets mode**: real set metadata (name, language, symbol/logo, release date, card count) —
  `card_sets`, a plain authenticated read, not a new RPC
→ Selecting a set opens its card list, with the same per-row **+**
✓ No card value is shown yet (M9); the result row layout reserves the space so adding it later is
  a small change, not a redesign

### F2.3 — Search top bar, set showcase and favourite filter (M7.1; showcase reworked P27/PR #41)

→ A dominant top search field ("Search for cards") with a magnifying-glass icon and a clear ×,
  plus a camera affordance and a star beside it
→ **Camera**: establishes the scanner's future position; tapping it shows "Card scanner is not
  available yet" — no permission request, no capture code (M15 owns the real behaviour, D-006)
→ **Star**: filters results to catalog cards behind a holding the user has marked Favourite — a
  direct read of existing favourite state (`holdings.is_favorite`), never a second wishlist system
→ Below the search controls, quick filters (Cards/Sets, language) and, when browsing with no
  query, a vertical downward grid of real sets — newest first, English sets only (owner decision,
  D-073; language chips govern text search results only), larger tiles with real set logo/symbol
  art loaded via the TCGdex set-asset convention (API_SOURCES.md). The original horizontal
  carousel is gone.
→ A compact sort menu offers Product name A→Z/Z→A and Card number low→high/high→low (natural
  order — DECISIONS.md's number-sort reasoning, §41/§72 below applies the same way here) over the
  already-fetched result set. Price-based sort stays absent until M9.
✓ Card results are image-led units (artwork, name, set, rarity · number, language/variant count,
  independent +), not a generic list row
✓ Catalog reads retry once on a transient auth failure (`PGRST301`) and never retry other errors —
  a defensive backstop for an unreproduced cold-start report, not a confirmed-bug fix (P27)

---

## F3 — Record a purchase · **implemented M8**

The flow the product exists for. Must tolerate a messy real receipt.

Shipped shape, two deliberate deviations from the description below (DECISIONS.md D-047/D-048):
a card/sealed line always creates its holding — no per-line checkbox; a user who does not want
individual entry yet uses a `bulk_lot` line instead. Editing a saved purchase can change dates,
retailer, per-line quantity/price/spend-class and purchase-level charges, but not which lines
exist — void and re-enter for that correction, same as "Purchase entered twice" further down this
document.

→ Purchases › New
→ Date (backdating allowed), retailer, currency
→ Add lines. Each line: type, and then a card or sealed product picker, or a free-text
  description for accessories and fees
→ Per line: quantity, unit price. Line total computes.
→ Purchase level: shipping, customs, discount
→ **Allocation preview appears as soon as a charge is entered** — a small table showing each
  line's share, so the user sees where the 100 kr shipping went before saving
→ For a non-NOK currency: the Norges Bank rate for that date prefills, editable, with the source
  shown
→ Save
→ Offered: "Create holdings for the 4 card and sealed lines?" — checkbox per line, on by default
✓ Purchase appears in the ledger with the right total
✓ Collectible and hobby figures both move; their sum equals the purchase total (F1)
✓ Created lots carry the allocated cost basis, not the bare unit price

⚠ Line totals do not match the stated total → block with the discrepancy named
⚠ No lines → cannot save
⚠ Shipping on a purchase whose lines sum to zero → allocated equally, and the UI says so

---

## F4 — Buy sealed product

→ Same as F3, line type "Sealed"
→ Product picker (real Search over the curated + own custom catalog, M11); if the product is
  missing, "Add product" creates a user-scoped catalog entry inline (name, type, set, pack count —
  no image field, see DATA_MODEL.md §3.3)
→ Optional: intent (Keep sealed / Planned to open / Undecided, default Undecided) — organisational
  only, never a financial choice
→ On save, a sealed holding and lot are created
✓ Appears under Sealed with cost basis and quantity
✓ Value shows "No valuation" until one is set — never a guess, never zero

→ Set a value: Sealed › item › Set value
✓ Marked "Manual", with the date, visible in the list as well as the detail view

**M11 also ships a direct route to the same result, without a purchase**: the central + menu's
"Add sealed product" → product picker (or arriving pre-filled from a product's detail page) →
quantity, intent, origin (Purchased/Gifted/Existing collection/Other — the same acquisition
semantics F3's card flow already uses, never a second origin vocabulary), acquired date, storage.
Gifted/Existing collection never fabricate a cost (`not_paid`/`unknown`, no purchase row) — same
rule as a card added the same way.

**Mixed intent among identical copies** (three otherwise-identical boxes, two "keep sealed" and one
"planned to open") is real and must read correctly: the product's one Portfolio tile shows a
breakdown ("2 Keep sealed · 1 Planned to open"), never a single collapsed label, and Holding Detail
lists each lot with its own intent and a lightweight "Change intent" action that can move part of a
lot's quantity to a different intent without touching cost basis, spend, or market value
(DATA_MODEL.md §5.5, DECISIONS.md D-061).

---

## F5 — Open sealed product (V1)

→ Sealed › item › Open
→ Confirm quantity (default 1) and pack count (prefilled from the product)
→ **The dialog states plainly: "The purchase stays in your spending history. This product leaves
  sealed inventory."** — because this is exactly the behaviour users of other apps do not expect
→ Choose tracking mode: *Every card* (default) or *Hits only*
→ Add pulls: search, or scan once the scanner exists. Each pull is a lot with no cost.
→ Optional: bulk remainder — count and estimated value
→ Save
✓ Sealed lot quantity drops; the lot itself remains with `quantity_remaining = 0`
✓ Collectible spend is **unchanged** — verifiable on the dashboard before and after
✓ Pull cards appear in the collection, each marked "From opening"
✓ Opening shows cost, tracked value, and return with an incompleteness marker when tracking is
  not `all_cards`

⚠ Opening without a recorded purchase → the manually entered cost **creates a real ledger entry**
  so the money appears in lifetime spending. The opening is marked "Cost entered manually — not
  linked to a purchase" with a **Link purchase** action.
⚠ Voiding an opening after a pull has been sold → blocked, naming the sale

**Linking a provisional opening to its real purchase**

→ Opening › Link purchase → pick from recent purchases → confirm
✓ Total spend does **not** change twice — the provisional entry is voided in the same transaction
✓ Opening cost updates to the real attributable cost, including that purchase's shipping share
✓ The confirmation states plainly which figure replaces which, before committing

**A pulled card's detail view** shows: "From opening — Prismatic Evolutions ETB, 14 Mar 2026"
with a link. It shows no cost basis field, no "0 NOK", and no ROI.

---

## F6 — Send a card for grading (V1)

→ Collection › card › Send for grading
→ Grader, service level, submission date
→ **The current raw value is captured automatically** and shown: "Raw value recorded: 900 kr —
  used later to assess whether grading paid off"
→ Holding state becomes `pending`; it stays in the collection, marked, and keeps its value

→ On return: Grading › submission › Record return
→ Grade, cert number, return date
→ The lot transfers to a new graded holding; cost basis travels with it untouched
→ Grading fee and shipping are recorded as a purchase, which attaches to the lot as adjustments
✓ Effective cost basis = original + grading costs
✓ Value is "No valuation" until set manually — a raw price is never substituted (F10)
✓ Grading delta available: graded value − raw value at submission − grading costs

---

## F7 — Sell · **implemented M10**

→ Sales › New, or Collection › item › Sell
→ Date, marketplace, currency
→ Add lines. For each: pick the holding, then **pick the lot**
→ The lot selector shows every open lot with its date, cost and quantity. Oldest is
  pre-selected, with a quiet "FIFO suggested" note. Changing it is one tap.
→ Quantity, sale price per unit
→ Sale level: fees, shipping paid, shipping charged to buyer
→ Net proceeds compute and are shown before saving
→ Save
✓ Lot quantities decrease; a disposal row is written
✓ Realized result appears **only** where the lot had a cost basis
✓ Where it did not: "450 kr proceeds — from an opening pull", not a profit figure
✓ The sold item leaves collection value from the sale date forward; earlier history is unchanged

⚠ Selling more than is held → blocked, with the available quantity shown
⚠ Selling a lot from a voided purchase → blocked

---

## F8 — Sell part of a duplicate holding · **implemented M10**

The case that justifies the whole lot model. Called out separately because it is where naive
implementations produce wrong numbers.

→ A holding with 5 units across 4 lots at different costs
→ Sell 2
→ The lot selector shows all four with dates and costs. Default selects the oldest two units.
→ The user changes one — they know which physical copy they sold
✓ `cost_basis_at_sale` is frozen per line from the chosen lots
✓ Remaining cost basis reflects the lots that were actually kept
✓ Later editing the original purchase does not rewrite this realized result

---

## F8.1 — Browse History · **reworked P43: unified correction-aware feed**

→ History (top-level destination, separate from Collection)
→ One feed over canonical events, with kind chips: **All · Purchases · Sales · Added · Values**
→ Toggle: **Show corrections / voided** (off by default; presentation only — hiding an entry
  never alters any total, D-074)

An event row shows a kind badge, the item or receipt title, origin/item-count subtitle, business
date, amount in NOK when one honestly exists (**—** otherwise), and a Voided badge under the
toggle. Every row navigates to its existing correction surface — purchase → purchase detail
(edit/void), sale → sale detail (edit/void), acquisition/valuation → Holding Detail — so History
is never itself a delete console.

```
[Purchase]  Finn.no · 3 item(s)                    12 Jul 2026    2 350 kr
[Sale]      Finn.no · 1 item(s)                    03 Aug 2026    1 850 kr
[Added]     Gift · ×1   Charizard                  10 Aug 2026    —
[Value]     Manual value · Charizard               10 Aug 2026    12 345 kr
```

✓ Only event kinds backed by real canonical data appear; Openings/Trades/Grading join when M16/
  M17/M18 land (D-075) — no placeholder chips pretending they exist
✓ Keyset pagination ("Load more") — stable order even across same-day events
✓ Voided/corrected entries hidden by default, revealed by the toggle with status badges
✓ No fabricated profit anywhere in this view

### F8.1a — Reset portfolio data (Profile → Danger zone) · **implemented P43**

→ Profile → Danger zone → **Reset portfolio data**
→ Confirmation sheet: "Are you sure? This cannot be undone." — states plainly what is removed
  (cards/sealed inventory, purchases and spending, sales and results, acquisition history,
  valuations, value history) and what is kept (account/settings, admin access, retailers,
  storage locations, tags and collections — emptied of members, manual card definitions, own
  sealed product definitions)
→ Buttons: **Cancel** · **Yes, reset portfolio** (disabled while running; errors stay visible)
→ ONE atomic server call (`reset_my_portfolio_data`, D-074); on success every cached query is
  invalidated and Home renders the honest empty state

---

## F8.2 — Organise with custom collections

**Shipped in M7**, exactly as specified below plus one addition: a horizontal collection chip
row sits directly on the Portfolio page (owner requirement, M7 prompt §86) so opening a binder
never requires a detour through More.

→ Portfolio › collection chip row → pick an existing chip, or "+ Collections" to create one
→ Holding detail › Collections section → toggle chips to add/remove this holding
✓ Nothing about ownership, value or cost changes
✓ A card can be in several collections at once
✓ Removing from a collection removes the membership only

→ Portfolio › a collection chip → the same grid/list/table, filtered to that collection, with the
  ordinary Sort by control (no manual reordering — playlist-like, not drag-and-drop, M7 prompt §41)
→ Deleting a collection (via the chip row's "Collections" manager) asks for confirmation and
  states explicitly: **"This removes the group. The cards in it stay in your Portfolio."**

**M7.1 addition.** Home's scope selector ("Portfolio Main ▼" or a named collection,
`src/ui/ScopeSelector.tsx`) reads and writes the exact same `custom_collections` model — never a
second grouping system (M7.1 prompt §17/§44/§74). Pre-M9 it changes which real count/top-cards
data Home shows; once M9/M12 exist, the same selected scope drives valuation and history too.

## F8.3 — Low-value and unpriced cards

→ Profile › set a low-value threshold (default 10 kr)
→ Portfolio › Filters › *Low value* — a graded holding's manual value at or under the threshold.
  Raw-card market pricing does not exist before M9, so this filter is honestly scoped to
  manually-valued holdings only until then (DECISIONS.md D-041) — never the acquisition cost
  standing in for it.
→ Portfolio › Filters › *Missing value* — a **separate** filter, because a card with no price is
  not a cheap card

✓ Both sets remain in the physical card count
✓ Priced low-value cards still contribute their value to collection value
✓ Unpriced cards are excluded from collection value and counted where the value is shown
✓ Optionally collapsed from the default browsing view, with the hidden count visible:
  *"1 284 low-value cards hidden — show"*
✓ Hiding is never deletion, and the UI never implies otherwise

## F8.4 — Portfolio select mode and bulk actions (M7.1)

→ Portfolio's action menu (beside the search field) → Select
→ Grid/List/Table each grow a per-tile selection affordance (checkbox-style), keyed by holding id
  so a selection survives a virtualized tile unmounting and remounting on scroll
→ A sticky bar shows the selected count, Cancel, and the actions currently safe to run in bulk:
  **Add to collection** (picks a collection, upserts membership), **Remove from this collection**
  (only when currently scoped to one), **Favourite**
✓ Every bulk action here is purely organisational (C1) — nothing financial changes
⚠ Bulk **removal from the Portfolio** (voiding lots) is deliberately not offered yet — it needs a
  transaction-safe batch-void operation this milestone did not build rather than an unsafe
  approximation (DECISIONS.md D-045, BACKLOG.md)

## F8.5 — The value display contract (M7.1)

One component (`src/ui/MoneyDisplay.tsx`) renders every monetary figure across Home, Portfolio and
Profile, in exactly one of three states, never conflated:

```
known    NOK 12 450
hidden   ••••          (the value-privacy eye is on — src/ui/ScopeSelector.tsx's sibling control)
missing  —              (no code path fabricates a number here)
```

A future price resolver (M9) or chart (M12) wires into this component unchanged — only the value
it is handed changes, never its states or their meaning.

---

## F9 — Fix a mistake

Correction must be cheap, or the ledger will drift from reality.

**Wrong card identity** → item › Change card → re-pick → lots, costs and disposals untouched;
only the catalog reference and the valuation source change. Audited.

**Wrong purchase amount** → edit → allocation recomputes → downstream lot cost bases update
→ **realized results on past sales do not change**, because those were frozen at sale time

**Purchase entered twice** → Void → confirmation names any downstream impact → if a lot from it
has been sold, blocked with the sale named

**Wrong condition** → edit → if it collides with an existing holding in that state, offer to
merge the lots into it

### F9.1 — Holding-level quantity correction and removal (P28, PR #42)

From a holding's detail page, without going through Portfolio select mode:

- **quantity = 1** → one action, **Remove from Portfolio**.
- **quantity > 1** → **Adjust quantity** and **Remove all**.

**Remove / Remove all** reuses M8.1's removal lifecycle exactly
(`remove_holdings_from_portfolio` → `void_acquisition_lot`); the holding disappears from
Portfolio and every current-state figure, and its void history remains in acquisition history.

**Adjust quantity** opens a sheet that names each live lot with its provenance (origin label,
date, remaining count, cost wording). The owner picks the lot(s) explicitly — there is no
server-side selection rule. Routing:

- **Purchased lot** → refused by the RPC; the sheet routes to `/purchases/$id/edit`, the
  established purchase-correction lifecycle. A purchased AND partially-sold lot shows "Can't
  adjust" (both paths refuse; correct it void-sale-first).
- **Non-purchase lot, partial shrink** → `reduce_holding_quantity` shrinks the chosen lot(s);
  no sale row, no proceeds, no realized result — a correction is not a sale (D-072). The M12
  dashboard recomputes from the change automatically.
- **Full-lot removal request** → refused with "would be left with zero copies"; the sheet points
  at the per-lot **Void** control (Acquisition History) for dropping exactly one lot while
  siblings keep their units, or Remove-all for the whole holding.

Every refusal is all-or-nothing: validation happens under locks before any write, so a failed
correction leaves quantities, money and disposals byte-identical.

---

## F10 — Dashboard (Home)

**M12 status (implementation candidate on `feat/m12-dashboard`, awaiting review).** The
structure below is now live: headline value from the latest snapshot via one bounded
`get_dashboard_summary` request, a real Lightweight-Charts value-over-time chart with
1D/1W/1M/3M/6M/1Y/MAX ranges (default 3M), period change amount+percentage (zero base renders
"—%", never a fake number), Total tracked economic position as the secondary figure, data
quality beneath the headline, raw/graded/sealed breakdown, monthly-spend bars, sales/net
figures, recent activity, and honest empty/no-history states. Custom-collection scope shows
correct current figures and says historical membership is not tracked (D-065). The eye masks
headline, change, chart axis/tooltips and the accessible summary together.

Missing-vs-zero honesty on this screen: before a user's first snapshot exists — new accounts,
and every pre-existing account during initial deployment's backfill window — the headline and
Total tracked economic position both render "—" ("not computed yet"), never "0 kr"
(FINANCIAL_MODEL.md §6.5). A snapshot-derived genuine zero still renders as 0. Beneath the chart
sits one restrained disclosure sentence: "Older market-value history uses weekly retained market
observations" (D-070) — it qualifies MARKET-VALUE history only; purchases, sales and cost basis
are exact frozen records and are never described as approximate.

**Automatic settle after an owner mutation (P42, D-082).** A correction anywhere in the app
(add/remove/adjust/void) enqueues a snapshot recompute; Home marks the state honestly with the
"Updating…" badge and then settles BY ITSELF: the summary query polls only while
`pending_recompute` is true (3 s cadence; no idle polling), the every-minute worker drains the
queue within about a minute of the mutation, the badge disappears on its own when pending flips
false, and that same transition refetches the value history so the chart can never sit stale
under a vanished badge. No reload, no navigation, no fake progress bar. If a recompute ever
takes unusually long, the badge's own tooltip already says what is happening; it does not imply
an error at any point.

Original structure (M7.1) for reference:

```
[brand, mobile only]
Portfolio Main ▼                              [NOK ▾]
—                                                 [eye]
Market value becomes available once pricing is enabled.
[value-over-time chart placeholder]   1D 1W 1M 3M 6M 1Y MAX

Physical cards   Unique holdings   Graded   Manual entries   (or, scoped to a collection: its count)

Most valuable cards                                    View all →
[four cards, only if a real manual valuation exists — otherwise an honest empty state]

[Search cards]  [Open Portfolio]
```

Every element that depends on M9 (raw pricing) or M12 (snapshots/chart) is honestly unavailable —
no sample data, no fabricated total, no placeholder line graph. "Most valuable cards" only ever
shows holdings with a real resolved value (currently: a graded holding's manual valuation); it
never ranks by acquisition cost. "View all" links to `/portfolio?sort=value_desc`. The scope
selector and currency/privacy controls are shared components with Portfolio (F8.2/F8.5) — not a
second implementation. The owner's stated requirement for the still-missing pieces, recorded so
M9/M12 do not miss them: the current Portfolio value should read as the single most prominent
number, next to a stock/investment-style value-over-time chart — see DECISIONS/ROADMAP M12 and M7
prompt §17-18/§106 for the full framing. M12 also owns the chart-library spike
(`lightweight-charts`, D-015).

→ Open the app
→ Collection value is the largest figure; overall position sits immediately beside it
→ Data quality renders directly beneath the value — automatic versus manual, priced versus not
→ Headline figures render from the latest portfolio snapshot — no per-card computation on load
→ Value chart, default 3M, with 1M / 1Y / ALL
→ Below: monthly spend, raw/sealed/graded breakdown, card counts, recent activity

✓ Every figure is traceable: tapping "Realized result" opens the sales that produced it
✓ Both counts are shown and are different numbers: physical cards owned, unique variants
✓ Stale or missing valuations are surfaced: "74 cards without a price"
✓ Cards with no recorded cost are surfaced too: "1 284 cards without a recorded cost"
✓ The chart's origin is explicit — the first tracked date, not an implied earlier zero
✓ No figure is labelled a return unless it mathematically is one

**Empty account:** one clear next action, not six zeroed cards. **New account with data but no
price history yet:** the chart says so rather than drawing a flat line.

---

## F11 — Export

**Shipped in M13** as Profile › Data › **Export & backup** (`/profile/export`), plus the retained
M7.1 quick Portfolio CSV (D-081). The M13 screen is a deliberate TWO-STEP flow (D-078) so
`navigator.share()` always runs inside fresh transient user activation — sharing across awaited
generation threw NotAllowedError on installed iOS PWAs:

→ Step 1: choose **Prepare CSV export** (ten analysis files: holdings, acquisition lots, manual
valuations, purchases, purchase lines, sales, sale lines, lot disposals, lot cost adjustments,
custom collections) or **Create backup** (one versioned JSON envelope)
→ status shows honest phases only ("Preparing…", then "Ready") — no fake percentage
→ READY state lists every filename and the file count before anything is delivered
→ Step 2: tap **Save / Share …** → Web Share Level 2 with all files when the platform accepts them
(one invocation), else save picker (single file, desktop Chromium), else sequential downloads with
every object URL revoked; a multi-file download fallback states the count beforehand and mentions
that the browser may ask permission to download multiple files
✓ CSV amounts are decimal strings with an explicit currency column — not raw minor units, not
locale-formatted with ambiguous separators; empty means unknown (never 0)
✓ JSON backup carries format id + schema_version + exported_at; money travels as exact integer
minor-unit strings past 2^53; canonical timestamps stay verbatim wire strings
✓ NotAllowedError is surfaced with explicit "Try sharing again" / "Download instead" choices
(D-079); a dismissed sheet is quiet cancellation, never styled as an error
✓ Generated artifacts live in memory only until delivered — nothing persisted, nothing uploaded
Restore/import does NOT exist yet; copy says so. A periodic local-only export reminder nudge on
Profile (D-080).

---

## F11.1 — Quick add

**Shipped in M7** as the central **+** in both the mobile bottom navigation and the desktop top
navigation — one shared sheet (`QuickAddMenu`), reached the same way from either. Shows only what
currently exists; new actions appear as their milestones land rather than sitting disabled from
day one (M7 prompt §12 was explicit that a menu of dead actions is worse than a short one).

| Available now | Action |
|---|---|
| Search cards | Opens Search (`/catalog`) |
| Add card manually | Opens the catalog-missing-card form (`/portfolio/manual/new`) |
| Record purchase (M8) | Opens the multi-line purchase ledger form (`/purchases/new`) |
| Scan card (M7.1) | Establishes the scanner's future position in this menu; shows "Card scanner is not available yet" — no permission request, no capture code (D-006 still governs the real implementation) |

| Arrives later | Action |
|---|---|
| M11 | Add sealed product |
| M15 | The Scan card entry above becomes real |
| After openings (M16) | Open product |
| After trades (M18) | Record trade |

**Record sale shipped in M10** — a fifth entry in this menu, plus Portfolio's select-mode "Sell"
action and a Holding Detail "Sell" button, all opening `/sales/new` with the relevant holding(s)
pre-loaded.

---

## F12 — Bulk scan (V1, first post-MVP milestone)

Specified now so the scanner is built against a defined target, not improvised.

→ Collection › Scan
→ Camera starts. **One permission prompt for the whole session.**
→ Session defaults set once and shown as a persistent header:

```
Origin      Pulled
Opening     Surging Sparks Booster Box
Condition   NM
Language    English
Collection  Binder 3
```
→ Point at a card → identity proposed in an overlay → tap to accept → immediately ready for the
  next card
→ Low confidence → up to three candidates → tap one, or search manually without leaving the session
→ A running counter shows the batch
→ End session → review the batch as a list → adjust anything → save all
✓ No navigation and no URL change at any point while the camera is live (D-006)
✓ Faster than manual search, measured against a real stack of cards
✓ Nothing is saved until the review step is confirmed

---

## F15 — Trade Analyzer (future, recorded M7.1 prompt §48 — needs M9 values + M18 trade workflow)

The owner's exact specification, recorded now so a future session builds this and not something
approximate:

→ Portfolio → Trade Analyzer → Create new trade → name the trade
→ Two sides, **YOU** and **THEM**, each: add products (cards), a running total value, and an
  optional cash amount
→ A fairness scale renders as a horizontal bar from "very good for user" through "fair" to
  "bad for user", with an indicator positioned by the two sides' real values
→ Save, or discard on back/exit — asked explicitly, not silently dropped

Depends on M9 (a real card value to sum) and M18 (the trade workflow/schema already exists,
DATA_MODEL.md §5.8.2). No fairness figure may ever be fabricated or estimated from acquisition
cost — the same "never a value that isn't real" rule as every other figure in this document.

## F16 — Market Movers — **complete as of M9.1** (owner spec recorded M7.1 prompt §49)

`get_market_movers(p_period_days, p_limit, p_sort)`:

→ Portfolio → "Market movers" shortcut, or Home → "Market movers · 7 days" → "View all" →
  `/market-movers` → owned, currently-priced raw-card holdings ranked by real period-over-period
  price movement
✓ Period: 1D / 7D / 30D, in the URL (`?period=`)
✓ Sort: highest increase / largest decrease / most movement / least movement, in the URL
  (`?sort=`) — every mode ranks by per-unit `change_pct` (D-056), never by holding-total kroner, so
  quantity never distorts the ranking; the holding-total impact (unit change × quantity) is shown
  as a secondary figure only
✓ Ranks only holdings with a real historical observation on/before the window start; a holding
  with no such observation is excluded, never shown as 0% movement (F9/F14's same principle) — an
  early-days empty state says so honestly ("not enough price history yet"), never a fake 0%
✓ No cross-user ranking — always scoped to the caller's own Portfolio
✓ Price movement only, never a realized/sale figure (invariant F13's neighbour — see FINANCIAL_
  MODEL.md §10's explicit-non-claims list; a mover is not a disposal)
✓ A real zero current value is a genuine mover (e.g. −100%), never conflated with "no data"

Home keeps its compact fixed-7-day/most-movement preview (`get_market_movers(7, 5)`, unchanged)
as a dashboard glance; the dedicated screen is where period/sort actually apply.

---

## Cross-cutting rules

| Rule | Applies to |
|---|---|
| Destructive confirmations name the concrete downstream impact | Every void and delete |
| Uncertainty is marked where the number is displayed | Stale, manual, estimated, incomplete |
| Money inputs use a numeric keypad on mobile and accept both `,` and `.` | Every amount field |
| Dates default to today and allow any past date | Every date field |
| Long lists are virtualised | Collection, purchases, sales |
| Every destructive action is undoable, or blocked | Financial records |
| Offline: reads work from cache, writes fail with a clear message | Whole app |
