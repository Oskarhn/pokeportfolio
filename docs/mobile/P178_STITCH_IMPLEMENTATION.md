# P178 native-vs-Stitch implementation comparison

Every major screen touched this phase, its closest accepted P174 reference (if any), what was
kept, what changed, and why. Direction: **Utility structure + Foil visual identity** (the owner's
explicit P178 choice — a hybrid, not a straight pick of one of the three P174 directions).
Reference material: `docs/design/p174/` in the `p174` worktree (`gallery.html`,
`CANONICAL_FIXTURES.md`, `STITCH_PROMPTS.md`, `OWNER_DECISION.md`).

Native correctness beats screenshot fidelity throughout (per the mission's own §23): every
deviation below is a deliberate choice, not an oversight.

| Native screen | P174 reference | Kept | Changed | Reason |
|---|---|---|---|---|
| `CollectionScreen` (Collection tab root) | Foil/Utility "1 Home" | Value hero first, counts line, unpriced-count callout, list rows with art+qty+value | No search/sort/filter chips, no "Recently added" art shelf, no "Money in and out" breakdown section | Those need either new collection-store query capability (client-side filtering across an infinite-scroll, potentially thousands-of-rows list would either be dishonestly partial or require new server work) or acquisition/sale aggregate reads this screen's read model does not expose. Building an unfinished filter/sort UI that only acts on the currently-loaded page would be exactly the "fake/unfinished... simply because Stitch showed one" the mission itself says to avoid (§10, applied here by the same logic). Disclosed as a gap for a future phase, not fabricated. |
| `CardDetailScreen` | Foil/Utility "3 Card detail" | Art tile, identity, `PriceBlock` (value + price-state caption + per-card line), provenance card, ownership line, two-equal-action row (Check price / Record a sale) plus the two existing secondary actions | No "Recorded cost" row (fixtures §4) | `HoldingDetail` (the read model this screen consumes) has no cost-basis field — acquisition cost is not currently projected to this screen at all. Showing a fabricated "— Cost unknown" for every holding regardless of its real state would be dishonest by this project's own rule (never fabricate a value or a state); adding the real field is a data-layer change outside a visual-redesign phase's scope. Disclosed, not hidden. |
| `CardPriceScreen` (Price Check, printing chosen or being chosen) | Foil/Utility "4a/4b Price Check" | Two-state structure (choice vs. result), nothing preselected, no price before a choice, graded section's fixed unavailable sentence, read-only reminder line | Printing choice list is `RadioRow` (true radios) instead of `ActionButton` pills; "other printings" quick-switch uses `FilterChip` pills instead of full-width buttons; price source toggle uses `SegmentedControl` instead of two selectable buttons | Closer to the P174 pictures' own described radios/segmented control while keeping every existing testID and behavior (P169/P173's own contract, unchanged) |
| `PriceCheckHomeScreen` (Price Check tab landing) | none (P174 did not draw an N2 Price-Check-tab landing screen) | — | Restyled with the shared design system; read-only line promoted to `InlineNotice` | This screen is P169's own addition (the app's actual N2-shaped navigation, chosen back in P170/P173 before P174 existed); no Stitch picture to compare against |
| `CatalogSearchScreen` (Search tab) | none (Search itself was not part of the Golden Five) | Language filter, "from a photo" entry, live status line | `SearchField` for the query input, `FilterChip` for language filter, `CardArtwork` placeholder tile per result row | General design-system uplift; no Stitch Search picture exists to compare fidelity against |
| `RecordPurchaseScreen` | Foil/Utility "5 Record purchase" | Field order and content per fixtures §7, honesty line ("records a purchase you already made"), pinned full-width primary action with a summary sub-line | **New currency selector** (`SelectRow` + `BottomSheet` + `RadioRow`, NOK/EUR/USD/GBP/JPY) where fixtures show it as a plain inline radio row; close (×) header instead of a back arrow | The currency selector is the P178 §17 functional fix (P177's disclosed JPY UI gap), not a visual choice — fixtures' inline layout was for a static picture; a bottom sheet is this app's one general-purpose picker surface (reused for `RecordSaleScreen` too) rather than a bespoke inline control built once for this screen |
| `RecordSaleScreen`, `RecordOpeningScreen`, `AddAcquisitionScreen`, `ManualValuationScreen` | none drawn in P174 | Existing real flows, all testIDs, all financial semantics | Restyled with `TaskScreen`/`TaskFooter`, `MoneyField`/`DateField`, `RadioRow` for lot pickers, `SwitchRow` for the cost-unknown toggle (`AddAcquisitionScreen`); sale/opening confirm buttons now always render (disabled when nothing can be submitted) instead of disappearing | No Stitch reference exists for these; restyled to the same design-system vocabulary as the screens that do have one, for a consistent app rather than a redesigned island next to unstyled prototype screens |
| `ProfileScreen` | Foil/Utility "Profile (neutral)" | Account row, sign-out | Removed the "READ-ONLY SPIKE BUILD" debug badge and the "provisional… not approved" disclaimer text; added a real Dark/Light/System appearance switch (`SegmentedControl`) | Debug/environment labelling is explicitly banned in this project's own canonical fixtures (`CANONICAL_FIXTURES.md` §11) and contradicts a "premium, production-quality" pass; fixtures' own Profile content (data-sources rows, a working "Hide values" switch, "Planned" rows) was NOT added, because none of that is backed by a real read/write path in this app today — adding it would be a new, non-functional feature, not a restyle |
| `PhotoEntryScreen` (photo/scanner fallback) | Foil/Utility "Scanner (neutral)" (adjacent, not the same screen — this app has no live camera scan UI) | The honest "not built in yet, choose manually" statement, unchanged | Promoted to `InlineNotice`; no camera viewfinder UI was built (none existed before, and building one is P172's scope, not P178's) | Matches §14's own instruction: style the existing fallback, do not imply an AI scan when none runs |
| `LoginScreen`, `AddIntentScreen`, `VariantEntryScreen` | none | All behavior, all testIDs | Token-only restyle (dark palette via the shared `Button`/`TextField`-family primitives) | Transient or entry screens with no Stitch picture; automatic uplift from the shared design system was judged sufficient for this phase |

## App chrome (not a single screen)

Native-stack headers (`MainNavigator.tsx`) now use a shared dark `screenOptions` (surface-coloured
header, no header shadow, section-weight title) instead of the RN default; the financial write-form
screens get a close (×) `IconButton` instead of a back arrow, matching the fixtures' "Close (X)"
pattern for task screens. The bottom tab bar is tinted with the new `accent`/`textMuted` tokens.
No icon set was chosen for the tabs or the app icon (P178 §8/§32 — deliberately deferred, same as
every prior phase).

## Deliberate non-goals this phase

- Grid view for Collection (fixtures explicitly note a 17-digit amount does not fit a grid tile,
  and grid was never built).
- N1/N2 navigation change (kept the existing 4-tab structure per §8's explicit instruction).
- App icon (§32 — owner has not chosen one of the six P174 families).
- Serif typography (Archive's own signature) beyond what §1/§6 of the mission licensed — none of
  this phase's screens judged a serif heading to clearly improve on the existing sans scale, so
  none was introduced; Archive's contribution this phase is limited to the reasoning above, not a
  visible typography change.
