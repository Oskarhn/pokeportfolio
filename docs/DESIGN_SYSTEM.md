# Design System

Direction and conventions. Concrete tokens are added when the first screens are built — writing
a full token table before any interface exists produces values nobody validated.

---

## 0. Current phase: provisional, not final

Recorded explicitly so a future session does not read "the UI is functional" as licence to
invent the final visual identity.

The owner has set the intended sequence:

```
working product structure → basic clean UI → owner-supplied reference screenshots
  → owner-supplied/approved logo → dedicated visual redesign/polish phase
```

Until reference screenshots arrive, build UI with a **clean, restrained, neutral** baseline —
this section's direction below already describes that baseline (dense, typographic, quiet chrome
around the card artwork), and it holds. Explicitly avoid, beyond what §1 already rules out:
spending significant effort on subjective visual polish, inventing a bespoke component purely for
aesthetics, or treating the current placeholder PWA icon set as anything but a placeholder.

**Design tokens stay centralized regardless of phase.** Semantic CSS custom properties
(`--background`, `--foreground`, `--surface`, `--muted`, `--border`, `--accent`, `--positive`,
`--negative`, and typography/spacing/radius tokens as they're introduced) are the one place visual
properties live. Feature components consume tokens; they never hardcode a colour, a radius or a
font size. This is what keeps the eventual redesign a token-file change rather than an 80-file
hunt — see ROADMAP.md's visual design refinement milestone for when that redesign happens and
what it consumes (the owner's reference images, analysed for layout density, spacing, typography,
navigation, card presentation and colour direction, then written back into this document before
implementation).

**Logo and identity.** No final logo exists yet and none is designed until the owner provides or
approves one. The current placeholder PWA icon set (`public/icons/`) stays in place. When a real
identity arrives, it must be swappable from one location — icon files referenced by
`vite-plugin-pwa`'s manifest config and a single header/logo component, never hardcoded into
individual screens — so the eventual swap is an asset replacement, not a per-component hunt.

---

## 1. Direction

A financial instrument that happens to hold Pokémon cards.

The reference points are portfolio and banking interfaces: dense where density helps,
typographic rather than decorative, restrained with colour, and honest about uncertainty. The
card artwork provides all the visual richness the app needs; the interface around it should be
quiet.

**Explicitly avoided.** Rounded-card grids as a default layout. Gradient headers. Glassmorphism.
Emoji as iconography. Six identical stat tiles in a row. Purple-to-blue anything. Decorative
illustration in empty states. Bright yellow-red-blue theming. Anything cartoonish or that reads
as a children's game. Official logos, wordmarks or any styling implying affiliation.

**Subtle Pokémon awareness, not Pokémon theming.** The subject shows through the data, not the
chrome: card artwork, set symbols, rarity marks, energy-type indicators used as small functional
metadata. The interface around them stays a premium data application. If the app were reskinned
for another collectible, only the artwork and a handful of icons would change — that is the right
level.

**Deliberately kept.** Real numbers at readable sizes. Tabular figures. Clear hierarchy between
a headline figure and its supporting detail. Generous touch targets on mobile without wasting
vertical space. Visible provenance.

---

## 2. Typography

Type carries most of the design, so it gets most of the attention.

| Role | Treatment |
|---|---|
| Headline figures | Tabular lining numerals, tight tracking, large. Currency symbol and unit at a smaller size and lower contrast than the digits. |
| Body and labels | System font stack — SF on iOS, Segoe on Windows, Roboto on Android. Fast, native, no webfont payload, no FOUT. |
| Tabular data | Tabular numerals mandatory. Columns of amounts must align on the decimal or the layout reads as broken. |
| Monospace | Only for identifiers: collector numbers, cert numbers, tokens. |

`font-variant-numeric: tabular-nums` on every numeric context. A value that shifts width as it
updates looks unstable, which is the opposite of the intended impression.

Norwegian formatting via `Intl.NumberFormat('nb-NO')`: `1 234,56` with a non-breaking thin space
as the group separator and a comma as the decimal separator. Amounts never wrap.

---

## 3. Colour

Semantic, not decorative. Every colour has one meaning.

| Role | Use |
|---|---|
| Surface | 3–4 elevation levels, low contrast between them |
| Text | Primary, secondary, tertiary. Three levels, not five. |
| Positive / negative | Gain and loss only. Never for decoration, never for branding. |
| Warning | Stale data, incomplete tracking, unverified cost |
| Neutral accent | Interactive elements, focus rings |

Gain/loss colours must be distinguishable without hue — direction arrows and explicit signs
accompany every coloured figure. Around 8% of men have a colour vision deficiency, and this is
an app about whether numbers went up or down.

Dark mode is a first-class palette, not an inverted light one. Both meet WCAG AA on text and
AA on non-text interactive elements. System preference is the default; a manual override is
persisted per profile.

---

## 4. Layout

**Mobile-first.** Every screen is designed at 390 px and then given room, not the reverse.

### 4.1 Collection grid density

The mobile collection is image-led. Density is a **user setting**, default 2 columns, persisted
per profile. The layout reads it from the profile; 2 is never hardcoded.

| Columns | Tile content |
|---|---|
| 1 | Large image, name, set, number, condition, quantity, value, origin marker |
| 2 | **Default.** Image, name, quantity badge, value |
| 3 | Image, quantity badge, value |
| 4 | Image, quantity badge. Value on long-press or in detail. |

Higher densities genuinely show less. That is the trade the setting makes, and it is the user's
to make — a density preference is not overridden because the designer prefers larger tiles.
Tapping always opens full detail.

Quantity is a badge on the tile, not a duplicated tile. Eighty identical energies are one tile
reading ×80.

**Images must not stampede.** Lazy-load below the fold, request the size the current density
actually renders, and virtualise the grid. A 10 000-card collection at 4 columns must not issue
thousands of requests on mount.

### 4.2 Breakpoints

| Breakpoint | Behaviour |
|---|---|
| < 768 | Collection grid at the user's density. Bottom navigation with a central quick-add. Sheets instead of dialogs. Tables become cards. |
| 768–1279 | Two columns where useful. Sidebar navigation. |
| ≥ 1280 | Full desktop. Dense tables. Persistent filter panel. Multi-column detail. |

4 px spacing scale. Two container widths: content (measured for reading) and full (tables and
charts).

**Density differs by platform on purpose.** Desktop tables target 36–40 px rows because scanning
200 rows is the job. Mobile lists target 56–64 px because thumbs are imprecise. This is not an
inconsistency to be resolved.

**Safe areas.** `viewport-fit=cover` plus `env(safe-area-inset-*)` on every fixed element. The
bottom tab bar sits above the home indicator, not under it. Verified on hardware, not in a
simulator.

---

## 5. Components

Owned outright in `src/ui/`, built from Base UI primitives via shadcn/ui, styled with Tailwind v4.
Nothing is imported from a component library at runtime, which is what makes it possible for this
app not to look like every other app built the same way.

Conventions:

- Containers earn their borders. A list of items does not need a card around each item.
- One elevation level per screen region. Nested cards are a smell.
- Radius is small and consistent — 6–8 px. Nothing is a pill unless it is a badge.
- Focus rings are always visible and never removed.
- Touch targets are at least 44×44 px, including in dense desktop tables when viewed on a touch
  device.
- Loading states are skeletons matching the real layout, never spinners over blank regions.

---

## 6. Charts

Charts are a primary surface, so they get explicit rules rather than library defaults.

- One accent colour per series. No gradient fills beyond a single subtle area wash under the
  portfolio line.
- Y axis does not start at zero for value-over-time — it obscures the movement that matters —
  and this is labelled so the reader is not misled.
- Every chart states its origin. A chart beginning mid-2026 says so; it never implies data
  before tracking began.
- Touch: tap-and-hold reveals a crosshair with the value and date. No hover-only affordances.
- Every chart has a text alternative: a summary sentence with start, end, change and range, in
  the accessibility tree.
- Empty and insufficient-data states are designed, not left to the library. "Not enough history
  yet — the chart starts once there are two days of data" is a real state that will be seen for
  the first week of use.

Colour is never the only encoding of meaning in a chart.

---

## 7. States

Every data surface specifies four states before it ships. This is a completion criterion, not a
polish item.

| State | Requirement |
|---|---|
| **Empty** | Explains what goes here and offers the one action that fills it. No illustration, no marketing copy. |
| **Loading** | Skeleton matching the final layout so nothing jumps on arrival. |
| **Error** | What failed, whether the data is stale or absent, and what the user can do. Never a raw error string. |
| **Partial** | Data present but incomplete or stale, marked at the point of display. |

The partial state is the one most often skipped and the one this app most needs — stale prices,
incompletely tracked openings, cards without a price, cards without a recorded cost, provisional
opening costs, manually valued sealed and graded inventory.

**Absence has a visual language of its own, and it is not zero.** A missing cost renders as
"cost unknown" or "from opening", never as `0 kr`. A missing price renders as "no price", never
as `0 kr`. A missing result renders as **—**, never as a number. Whenever a figure is absent, the
reason is one tap away.

---

## 8. Writing

- Plain, specific, no marketing voice.
- Numbers over adjectives: "3 holdings without a valuation", not "some items need attention".
- Errors name the cause and the fix: "This purchase is the source of an opening with 3 tracked
  pulls. Void the opening first."
- Financial terms mean what they mean. "Overall position" is not called "profit" (see
  [FINANCIAL_MODEL.md](FINANCIAL_MODEL.md) §9).
- UI language is English; locale formatting is `nb-NO`. Language and locale are decoupled so an
  invited user in another country can change one without the other.

---

## 9. Accessibility

Baseline, not aspiration:

- Semantic HTML first. ARIA only where semantics fall short.
- Full keyboard operation on desktop, including tables and filters.
- Visible focus everywhere.
- Every input has a real `<label>`.
- WCAG AA contrast on text and non-text UI.
- `prefers-reduced-motion` honoured; no motion is load-bearing.
- Screen-reader announcements for async results — a saved purchase must be announced, not just
  rendered.
- Charts have text alternatives (§6).

---

## 10. Motion

Sparing and functional. Transitions communicate spatial relationships — a sheet rising, a row
expanding — and nothing else. 150–250 ms, standard easing. Nothing animates on page load.
Numbers do not count up. Reduced-motion disables all of it without breaking any layout.
