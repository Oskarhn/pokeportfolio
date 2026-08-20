# UX Flows

Behavioural specification for the workflows that matter. Written to be directly testable —
[TESTING.md](TESTING.md) §6 draws its E2E cases from here.

Notation: **→** step · **⚠** failure or edge case · **✓** completion criterion

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

→ Collection › select cards → Add to collection → pick or create
✓ Nothing about ownership, value or cost changes
✓ A card can be in several collections at once
✓ Removing from a collection removes the membership only

→ Collections › a collection → its own view with a total value and card count
→ Deleting a collection asks for confirmation and states explicitly: **"This removes the group.
  The 214 cards in it stay in your collection."**

## F8.3 — Low-value and unpriced cards

→ Settings › set a low-value threshold (default 10 kr)
→ Collection › filter *Low value* — cards currently below the threshold
→ Collection › filter *No price* — a **separate** filter, because a card with no price is not a
  cheap card

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

## F10 — Dashboard

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

The central **+** in the mobile navigation. Shows only what currently exists; new actions appear
as their milestones land rather than sitting disabled from day one.

| Available | Action |
|---|---|
| MVP | Add card · Add purchase · Add sealed product · Record sale |
| After the scanner | Scan cards |
| After openings | Open product |
| After trades | Record trade |

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
