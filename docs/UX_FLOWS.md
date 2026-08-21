# UX Flows

Behavioural specification for the workflows that matter. Written to be directly testable —
[TESTING.md](TESTING.md) §6 draws its E2E cases from here.

Notation: **→** step · **⚠** failure or edge case · **✓** completion criterion

---

## F0 — Primary navigation (shipped M7)

Five direct destinations, always reachable, plus a central quick-add action (F11.1) that is an
action, never a sixth destination:

| Destination | Route | What it is |
|---|---|---|
| **Home** | `/` | The future investment-style portfolio dashboard (F10). M7 shows only truthful current data — physical/graded/manual counts — with an honestly-marked "not available yet" panel where the value figure and chart will live once M9/M12 exist. |
| **Search** | `/catalog` | The renamed Catalog — Cards and Sets modes, per-result quick-add (F2 below), reserved layout for a future value column (M9). |
| **Portfolio** | `/portfolio` | The user's owned-card browser — grid/list/table, density, sort, quick + full filters, custom collections (F8.2/F8.3). User-facing name for what the schema still calls a holding/collection (DECISIONS.md D-040). |
| **More** | `/more` | Secondary real functionality only — admin invitations when applicable, a link into Profile's display settings. No disabled future-feature entries. |
| **Profile** | `/profile` | Account identity and Portfolio display defaults — display name, theme, low-value threshold, sign out. |

Mobile: a fixed bottom navigation bar with the central **+** raised above it, centred independently
of the five equal-width tabs (`src/features/nav/BottomNav.tsx` — see that file's own comment for
the geometry). Desktop: a single top navigation row covering the same five destinations plus Add
(`DesktopNav.tsx`). Safe-area-aware on both; the bottom bar never covers scrollable content
(AppShell reserves matching bottom padding).

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

---

## F3 — Record a purchase

The flow the product exists for. Must tolerate a messy real receipt.

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
→ Product picker; if the product is missing, "Add product" creates a user-scoped catalog entry
  inline (name, type, set, pack count)
→ On save, a sealed holding and lot are created
✓ Appears under Sealed with cost basis and quantity
✓ Value shows "No valuation" until one is set — never a guess, never zero

→ Set a value: Sealed › item › Set value
✓ Marked "Manual", with the date, visible in the list as well as the detail view

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

## F7 — Sell

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

## F8 — Sell part of a duplicate holding

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

## F8.1 — Browse History

→ History (top-level destination, separate from Collection)
→ Tabs: **Sold** · **Traded** · **Other**

A sold row shows card, quantity, date, marketplace, gross, fees, shipping, net proceeds,
acquisition origin, cost basis if known, and result.

```
Charizard ex · SV03 · NM              Sold 12 Jul 2026 · Finn.no
Net proceeds  1 850 kr    Cost basis  1 200 kr    Result  +650 kr

Pikachu VMAX · SWSH4 · NM             Sold 03 Aug 2026 · Finn.no
Net proceeds    450 kr    Cost basis  unknown     Result  —
```

✓ Sorting: newest, highest proceeds, highest result, largest loss, item, marketplace
✓ **Sorting by result groups unknown-basis rows separately** rather than ranking them as the most
  profitable sales ever made
✓ Traded rows link to the trade, showing both sides, market values at trade date and cash legs
✓ No fabricated profit anywhere in this view

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

---

## F10 — Dashboard (Home)

**M7 status.** This is Home's eventual shape, owned by M9 (value) and M12 (snapshots, chart).
M7 built the `/` destination (F0) with only truthful, currently-available figures — physical card
count, unique holdings, graded count, manual-entry count — and an honestly-marked "Portfolio
value — not available yet" panel exactly where the primary figure and chart below will live. No
sample data, no fabricated total, no placeholder line graph. The owner's stated requirement for
this eventual view, recorded so M12 does not miss it: the current Portfolio value should read as
the single most prominent number, next to a stock/investment-style value-over-time chart — see
DECISIONS/ROADMAP M12 and M7 prompt §17-18/§106 for the full framing. M12 also owns the
chart-library spike (`lightweight-charts`, D-015).

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

→ Settings › Export
→ Choose: collection, lots, purchases, purchase lines, sales, or everything
→ CSV downloads
✓ Includes original currency, amount, FX rate and source, cost basis, origin, dates, disposals
✓ Amounts are decimal strings with an explicit currency column — not raw minor units, and not
  locale-formatted with ambiguous separators
✓ Enough provenance that external tax analysis is possible later

---

## F11.1 — Quick add

**Shipped in M7** as the central **+** in both the mobile bottom navigation and the desktop top
navigation — one shared sheet (`QuickAddMenu`), reached the same way from either. Shows only what
currently exists; new actions appear as their milestones land rather than sitting disabled from
day one (M7 prompt §12 was explicit that a menu of dead actions is worse than a short one).

| Available now (M7) | Action |
|---|---|
| Search cards | Opens Search (`/catalog`) |
| Add card manually | Opens the catalog-missing-card form (`/portfolio/manual/new`) |

| Arrives later | Action |
|---|---|
| M8 | Add purchase |
| M11 | Add sealed product |
| M10 | Record sale |
| After the scanner (M15) | Scan cards |
| After openings (M16) | Open product |
| After trades (M18) | Record trade |

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
