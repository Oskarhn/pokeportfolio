# UX Flows

Behavioural specification for the workflows that matter. Written to be directly testable —
[TESTING.md](TESTING.md) §6 draws its E2E cases from here.

Notation: **→** step · **⚠** failure or edge case · **✓** completion criterion

---

## F1 — Invitation and first login

**Admin creates an invitation**

→ Settings › Invitations › Create
→ Optional label for the admin's own bookkeeping
→ Choose expiry (default 7 days) and uses (default 1)
→ The token is displayed **once**, with a copy button and a plain warning that it will not be
  shown again
✓ Only the hash is stored; the plaintext is never retrievable

**Recipient redeems**

→ Opens the link on their phone
→ Enters their email address
→ Receives a six-digit code, enters it in the same screen
→ Account and profile created; landed on an empty dashboard
✓ Empty state explains the first useful action rather than showing zeroes in a grid

⚠ Expired, revoked or already-used token → a specific message naming which, not a generic failure
⚠ No token at all → signup is rejected server-side, not merely hidden

**Returning login**

→ Email → code → in
✓ The whole flow stays inside the installed app. No browser hand-off.
✓ Session survives app switch, cold start and reload

---

## F2 — Add a card manually

The most-used flow after the ledger. Target: under 20 seconds on a phone.

→ Collection › Add
→ Search by name, or by set plus collector number
→ Results show thumbnail, name, set, number, rarity
→ Select the card, then the variant (normal / reverse / holo)
→ Set condition, quantity, acquisition date (defaults to today), origin
→ If origin is a purchase: cost, currency (defaults NOK), optional link to an existing purchase
→ Optional: storage location, tags, favourite, notes
→ Save
✓ Appears in the collection with the correct lot
✓ Dashboard figures move by exactly the expected amount

⚠ The card already exists in the same state → the same holding gains **a new lot**. The UI says
  so explicitly: "Adding a second lot to an existing holding." It never averages.
⚠ No cost and origin is `purchase` → blocked, because that combination violates M1
⚠ Origin is `gift` or `unknown` → cost field disappears entirely rather than defaulting to 0

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
→ Choose tracking mode: *Selected pulls* (default) or *Every card*
→ Add pulls: search, or scan once the scanner exists. Each pull is a lot with no cost.
→ Optional: bulk remainder — count and estimated value
→ Save
✓ Sealed lot quantity drops; the lot itself remains with `quantity_remaining = 0`
✓ Collectible spend is **unchanged** — verifiable on the dashboard before and after
✓ Pull cards appear in the collection, each marked "From opening"
✓ Opening shows cost, tracked value, and return with an incompleteness marker when tracking is
  not `all_cards`

⚠ Opening without a recorded purchase → cost entered manually, flagged as unverified, and
  excluded from collectible spend because that money never passed through the ledger
⚠ Voiding an opening after a pull has been sold → blocked, naming the sale

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
→ Headline figures render from the latest portfolio snapshot — no per-card computation on load
→ Value chart, default 3M, with 1M / 1Y / ALL
→ Below: monthly spend, raw/sealed/graded breakdown, recent activity

✓ Every figure is traceable: tapping "Realized result" opens the sales that produced it
✓ Stale or missing valuations are surfaced: "3 holdings without a valuation"
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

## F12 — Bulk scan (V1)

Specified now so the scanner is built against a defined target, not improvised.

→ Collection › Scan
→ Camera starts. **One permission prompt for the whole session.**
→ Session defaults set once: condition, language, and optionally a purchase or opening to
  attribute everything to
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
