# Native design exploration brief for Google Stitch (P166)

**Status: brief only. No Stitch screen was generated.** The Stitch connection itself works (see §1),
but every screen-generation call timed out and none was stored. Nothing here selects a design, a
navigation scheme, a name or an icon: those remain owner decisions (P154 `OWNER_DECISIONS_NEEDED`).
All data in every prompt is synthetic.

## 1. What was verified in Stitch (2026-09-25)

| Check | Result |
|---|---|
| MCP server `stitch` connected and authenticated | Yes. `list_projects`, `get_project`, `list_screens`, `get_screen`, `list_design_systems` answered |
| Official tools advertised | `create_project`, `get_project`, `list_projects`, `delete_project`, `list_screens`, `get_screen`, `generate_screen_from_text`, `edit_screens`, `generate_variants`, `create_design_system`, `update_design_system`, `list_design_systems`, `apply_design_system`, `upload_design_md`, `create_design_system_from_design_md` |
| Isolated project created | `projects/16850582035551713176`, title "P166 Direction A · Foil (SYNTHETIC, owner review)", private |
| Design system created and applied | `assets/11284812079207926577` "P166 A · Foil" (tokens in §3) |
| Screen generation | **Failed.** 7 calls to `generate_screen_from_text` (default model, `GEMINI_3_5_FLASH_LITE`, with and without the design system, long and one-line prompts) all returned "The operation timed out"; `list_screens` stayed empty for more than an hour afterwards. Several read calls in the same period returned "The service is currently unavailable" and then recovered |
| Directions B and C | Not created (no point creating empty projects while generation fails) |
| Owner's existing project | `projects/13788458720243244916` "Pokeportfolio Design System" (created 2026-09-24, owner role, not created by P166). **Read only; not modified.** It holds a design system "Archival Collectible Portfolio" and screens titled *Portefølje-oversikt*, *Kortsamling & Galleri*, *Kortdetaljer – Varian 1: Vault Showcase (Gull & Rød)*, *Kortdetaljer – Varian 3: Holo-Museum & Kuratering*, *Kortdetaljer – Charizard PSA 9*, and two 1024 px marks *PokePortfolio Crimson Vault Logo* and *PokePortfolio Vault Emblem* |

Two observations about the owner's project, for the owner to weigh, not acted on: a screen named
after a real card with a PSA grade implies a graded value, and no authorised graded source exists
(`docs/API_SOURCES.md`, P158 `GRADED_UNAVAILABLE`); the two marks carry the name "PokePortfolio" and
were not inspected for Pokémon-derived shapes (P154 `APP_ICON_CONCEPTS.md` §5 lists the name/IP risk).

## 2. How the owner (or a later session) finishes this

In the Stitch web UI (preferred while the MCP generation path times out):

1. Open project `16850582035551713176` (Direction A). Create two more projects named
   "P166 Direction B · Utility (SYNTHETIC, owner review)" and "P166 Direction C · Catalogue (SYNTHETIC,
   owner review)". Do not reuse the owner's "Pokeportfolio Design System" project.
2. In each, set the design system from §3 (paste the direction block as the design markdown).
3. Generate the seven screens of §4 with the shared preamble (§5) plus the screen prompt, mobile.
4. For one screen per direction (Collection), generate the other theme (light for A, dark for B and C).
5. Export each screen's HTML and check it at 360, 390 and 430 px wide (no horizontal scroll, no clipped
   money, targets at least 44 px). Stitch renders mobile at 390; 360 and 430 must be checked on the export.

Through MCP, when generation works: `generate_screen_from_text` with `projectId`, `designSystem`,
`deviceType: MOBILE`; on a timeout do not re-send, poll `list_screens` / `get_screen`.

Approval boundary: generated HTML/JSX never goes into `apps/` or `src/` unreviewed. The owner picks a
direction, a navigation scheme and an icon first; implementation then follows the native component
rules in P154 `DESIGN_SYSTEM.md` §3, not Stitch's markup.

## 3. Directions (from P154 `DESIGN_SYSTEM.md`, unchanged)

| | A · Foil | B · Utility | C · Catalogue |
|---|---|---|---|
| Default theme | Dark (light available) | Light (dark available) | Paper (night paper available) |
| Ground / surface | `#0e0e10` / `#17171b` (light `#f6f3ec` / `#ffffff`) | grey `#f2f2f6`, grouped white lists | paper, flat, 1 and 2 px ink rules |
| Accent | brass `#d9ae63` (light `#8a5a16`) | teal `#0b6b5f` (dark `#4fc3b0`) | vermilion `#b23a22` (night `#e27d60`) |
| Type | system sans, hero 48/650 | system sans, bold large titles | serif display, mono plate numbers |
| Radius | 14 controls, 10 art, 26 sheets | 10, 6, 14 | 2 everywhere |
| Collection | edge-to-edge art grid | dense list with thumbnails | numbered plates, three across |
| Tab bar | floating blurred bar (solid fallback), raised Scan disc | standard full-width bar | text-forward bar, top rule marks active |
| Signature | holo edge on holo finishes only | nothing decorative | `No. 125/197` plates, caps section rules |

Gain `#6fcb9b`/`#146c45`, loss `#f2938c`/`#a8241c` (A) always with sign and arrow. The navigation
scheme is **not** chosen. To let the owner compare, each direction shows a different P154 candidate:
A with N2 (Collection · Search · Scan · Activity · You), B with N1 (Home · Collection · Scan · Price
Check · Profile), C with N3 (Home · Collection · Market · Activity · Profile + floating Scan).

## 4. Screens (same content in every direction)

| # | Screen | Must show |
|---|---|---|
| 1 | Home / Collection overview | market value `184 250,00 kr`; `▲ +2 415,30 kr (+1,33 %)`; source + FX line; "38 of 1 204 cards have no price"; real-snapshot line chart; recently added; needs-attention rows |
| 2 | Collection (all cards) | 10 000+ items implied (count `1 204 cards · 10 006 holdings`); a card with a value above 2^53 minor units (`90 071 992 547 409,93 kr`); `Basic Ember Energy ×80 — No price`; manual `0,00 kr` shown as a real zero; filters/sort; no card hidden for being cheap |
| 3 | Card detail | value directly under the art; unit and holding value; provenance (provider, source currency amount `€12.40`, snapshot date, stale pill); quantity/lots; `Check price` and `Add` as separate actions |
| 4 | Price Check (read-only) | "Checking a price never adds anything"; variant choice required before any price; two providers with source currency and NOK; graded tab: "Not available. No authorised graded source" |
| 5 | Scan confirmation | photo vs catalogue art (both abstract); confidence as the word High/Medium/Low; required finish chips; `Check price` and `Add` pinned; no auto-add |
| 6 | Purchases / Sales (Activity) | ledger rows with signs; a purchase with `Cost unknown —`; a sale showing net proceeds and "Result not computable: cost unknown"; `Record` → Purchase · Sale · Open |
| 7 | Profile / Settings | account, currency NOK, hide values, data sources and attribution (Cardmarket, TCGplayer, TCGdex), export, **Delete account** |

Synthetic card names only (no real card names, no Pokémon characters, no Poké Ball, no official
art): *Cinder Drake ex 125/197*, *Voltmouse 058/165*, *Tidecaller 031/102*, *Basic Ember Energy*.

## 5. Shared preamble (paste before every screen prompt)

```
Native mobile app screen for a private trading-card collection and price-checking app. Every card,
name, price and image is SYNTHETIC; show a small "SYNTHETIC DATA" pill near the top. Card art is
abstract (gradients or geometric shapes in 5:7 frames). No real card images, no official artwork,
no Poké Ball, no character likeness, no third-party logos.
Rules: amounts in Norwegian format with the currency after the number ("1 240,00 kr"); a missing
price or cost is an em dash "—" with the words "No price" / "Cost unknown", never 0; gains and losses
carry a sign and an arrow, never colour alone; money uses tabular numerals and wraps rather than
truncates; touch targets at least 44 pt; nothing below 12 pt; contrast at least 4.5:1; no cards
inside cards; at most five tabs; graded prices are shown as unavailable.
```

## 6. Icon

Not part of this pass. P154 `APP_ICON_CONCEPTS.md` holds three original concepts (A Foil Edge, B Ledger
Steps, C Reticle); owner selection is pending, and a generic default launcher icon is not acceptable
as final. The native spike still uses Expo's default icon, which is expected for a spike and is not a
proposal.
