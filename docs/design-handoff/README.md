# Handoff: SearchNex Ads — UI/UX redesign

## Overview

SearchNex Ads is an internal platform Chazif uses to analyse and manage the Google Ads
accounts it runs for clients. Today it ingests Google Ads CSV exports and presents 28
report views organised by Google Ads report type. The stated goal for the product is
that a junior employee can operate at the level of a Director of Performance Marketing.

This redesign restructures the app from a **report browser** into a **decision system**.
Three things change:

1. **The app opens on work, not data.** A Brief screen leads with the decisions waiting
   and the money at stake. An Actions queue gives every recommendation a lifecycle —
   open → staged → applied → verified — with owner, effort and confidence.
2. **Evidence comes to you.** A right-side drawer opens *over* the current screen with the
   underlying rows for whatever number you clicked, so drilling in never costs you your place.
3. **The product remembers.** A Ledger records what was predicted against what actually
   happened, which is what makes the methodology auditable and calibrates future confidence labels.

The existing 28 views all survive. They are re-parented into a three-layer navigation
(job → category → view) and become evidence for the queue rather than a filing cabinet
you browse.

---

## About the design files

The files in `prototype/` are **design references created in HTML** — an interactive
prototype showing intended layout, behaviour and exact styling. They are **not production
code to copy**. The task is to recreate these designs in React + TypeScript using the
project's chosen libraries and patterns.

The prototype is a single self-contained HTML file. Open
`prototype/SearchNex Redesign Original Colors.dc.html` directly in a browser — no build step,
no server. `support.js` must sit next to it. It uses a lightweight streaming-template runtime;
the markup is inline-styled and the logic lives in one class at the bottom of the file, so it
reads as a straightforward spec even though the syntax is not React.

`prototype/alt-palette/` holds an earlier variant with a cobalt-blue accent on warm paper
instead of the lime-on-slate brand palette. Same structure, same typography. Reference only —
**build the Original Colors version.**

Eleven screens are fully built. The remaining views render a placeholder that names the view
and its category; those inherit the patterns documented below and are not separately specified.

---

## Fidelity

**High-fidelity.** Every colour, type size, weight, spacing value and border radius in the
prototype is deliberate and documented in this README. Recreate the UI to match. Where a
value is not listed here, read it off the prototype source — the inline styles are the
source of truth.

Two caveats:
- All data is **realistic sample data** taken from a real client account (Chiarelli's
  Religious Goods, June 2026). It stands in for API responses; do not hardcode it.
- The prototype's interactions are shallow by design (a stage action shows a toast and moves
  a counter; it does not persist). The intended real behaviour is described under
  **Interactions & behaviour**.

---

## Design tokens

### Colour

Sampled from the live application, so these are the existing brand values, not new ones.

| Token | Hex | Use |
|---|---|---|
| `rail` | `#1f2937` | Left navigation background |
| `accent` | `#cfff04` | Lime. Interactive fills, active nav, primary CTA, brand mark, alert dots |
| `ink` | `#1a1a1a` | Primary text, dark buttons, dark pills |
| `surface` | `#ffffff` | Page and card background |
| `surface-alt` | `#f9fafb` | Table header fill |
| `rule` | `#f3f4f6` | Row separators, progress-bar tracks, neutral pill fill |
| `border` | `#e5e7eb` | Card and table borders, initial-chip fill |
| `border-strong` | `#d1d5db` | Input and secondary-button borders |
| `text-secondary` | `#374151` | Secondary body copy, button labels |
| `text-tertiary` | `#4b5563` | Supporting descriptions |
| `text-muted` | `#6b7280` | Table column headers, micro-labels |
| `text-disabled` | `#9ca3af` | Nav item text, placeholders, empty values |
| `strip-bg` | `#fafaf7` | Context bar background |
| `strip-border` | `#e6e6e0` | Context bar bottom border |

**Semantic**

| Token | Text | Fill | Use |
|---|---|---|---|
| `positive` | `#15803d` | `#dcfce7` | Improvement, A/B grades, "on/beat forecast" |
| `warning` | `#b45309` | `#fef9c3` | Caution, C/D grades, "under forecast" |
| `warning-banner` | `#92400e` | `#fffbeb` + `#fcd34d` border | Blocking banner |
| `negative` | `#dc2626` | — | Deltas on white |
| `negative-on-fill` | `#b91c1c` | `#fee2e2` | F grade, "reverted" |
| `attention` | `#d97706` | — | Freshness warning dots, below-floor bars |

**Categorical (charts)**

`#166534` · `#b45309` · `#374151` · `#dc2626` — used in the intent-class bars.
Neutral bar fill is `#374151`; a bar flagged below the bidding floor is `#d97706`.

### Colour rules — these are not optional

1. **Lime never carries white text.** Lime on white is ~1.2:1. Anything filled lime uses
   `#1a1a1a` text. Lime is never used as text on a light surface, and never as a fill on a
   light surface (the progress bar and chart series use `#1a1a1a` / `#374151` instead).
2. **Lime means "interactive."** It is not a data series, not a KPI highlight, not a bulk
   fill. In the old build lime signalled six different things at once; it now signals one.
   Emphasis on a figure is a lime *highlighter* behind ink text, not lime text.
3. **Green means better, not up.** Spend rising is neutral `#6b7280`. CPA falling is
   `#15803d`. Zero-conversion spend rising is `#dc2626`.
4. **Colour is never the only carrier.** Every coloured delta also has a sign or arrow;
   every grade pill also has a letter and a word.
5. **Contrast floor is WCAG AA (4.5:1)** for all text including 10–12px micro-labels.
   The tokens above are chosen to clear it — don't substitute lighter greys.

### Typography

Three families, from Google Fonts:

```
Instrument Sans   — all UI text. Base 13px.
Instrument Serif  — screen headlines only, nothing else.
JetBrains Mono    — all numerics, badges, chevrons. font-variant-numeric: tabular-nums.
```

The serif is used sparingly and deliberately: Brief headline (40px), action detail title
(32px), client-view headline (30px), placeholder view title (34px). Everywhere else is
Instrument Sans.

| Size | Weight | Use |
|---|---|---|
| 40 / 34 / 32 / 30px | 400 serif | Screen headlines. `line-height: 1.05–1.2`, `letter-spacing: -0.015em to -0.01em` |
| 28 / 24 / 22 / 20 / 17px | 600 mono | Large figures. `letter-spacing: -0.02em` |
| 16px | 600 | Drawer title, section headline |
| 15px | 600 | Client-view name, dropzone heading |
| 14px | 600 | Wordmark; 400 for client-view body |
| 13.5px | 600 | Card titles |
| 13px | 600 / 500 / 400 | Base. Panel titles, banner titles, body |
| 12.5px | 400 | **Table body, nav items, buttons, most supporting copy** |
| 12px | 400 | Secondary/meta, filter chips, footnotes |
| 11.5px | 600 | Grade pills |
| 11px | 600 | Status pills, outline chips |
| 10px | 600 | ALL-CAPS micro-labels. `letter-spacing: 0.07em`, `text-transform: uppercase` |
| 9.5 / 9px | 600 | Nav group labels (`letter-spacing: 0.09–0.1em`), collapsed-rail icon labels (8.5px) |

Use `text-wrap: pretty` on every multi-line prose block.

### Spacing, radius, elevation

Spacing values in use: `2 3 4 6 7 8 9 10 11 12 14 16 18 20 22 24 26 28 32 36 40 64 88 96`.
Prefer flex/grid with `gap` over margins.

Radius: `4` (small chip) · `5` (pill/logo) · `6` (chip, icon button) · `7` (button, input,
nav item) · `8` (icon button, avatar square) · `9` (toast) · `10` (card) · `12` (modal,
client-view sheet) · `20px` (rounded pill) · `50%` (avatar).

Elevation is used sparingly:
- Evidence drawer: `-16px 0 48px rgba(26,26,26,0.14)`
- Command palette: `0 24px 64px rgba(26,26,26,0.28)`
- Rail overlay: `8px 0 32px rgba(26,26,26,0.30)`
- Toast: `0 8px 28px rgba(26,26,26,0.30)`
- Scrims: `rgba(26,26,26,0.34)` (palette, rail), `rgba(26,26,26,0.28)` (drawer)

Cards use a 1px `#e5e7eb` border and no shadow.

---

## App shell

```
┌──────────┬────────────────────────────────────────────────┐
│          │ context bar — 48px, #fafaf7, 1px #e6e6e0 base  │
│  rail    ├────────────────────────────────────────────────┤
│  248px   │                                                │
│          │ content — scrolls, max-width per screen,        │
│          │ 24px horizontal padding                        │
└──────────┴────────────────────────────────────────────────┘
```

Root: `display:flex; height:100vh; overflow:hidden; position:relative`.
Base font 13px, colour `#1a1a1a`, background `#ffffff`, `-webkit-font-smoothing: antialiased`.

Content max-widths, centred: Brief 1180 · Actions 1320 · Action detail 1000 ·
Campaigns 1320 · Search terms 1320 · Keywords 1320 · Budget 1240 · Mapping 940 ·
Data 1040 · Ledger 1180 · Client view 900 · Placeholder 640.

### Context bar

Left: screen title (13px/600) then a subtitle (12px `#6b7280`).
Right: **only the filters that actually apply to this screen**, as chips — a 12px `#6b7280`
key and a 500-weight value inside a 1px `#d1d5db` white chip, `border-radius:6px`,
`padding:4px 9px`, `white-space:nowrap`, hover `border-color:#cfff04`.

This is a deliberate fix. In the current build a seven-control filter bar renders on every
screen including Upload Data and the client-management screens, where it controls nothing —
it implies filters apply when they don't, costs ~90px of vertical space everywhere, and
wraps to two rows around 1400px.

**Implementation:** each view declares its applicable filters. A view with none renders the
italic 11.5px `#9ca3af` note *"no filters apply on this screen"* instead. Per-view filter
declarations, e.g.:

| View | Filters |
|---|---|
| Brief | none |
| Actions | Sort, Owner |
| Campaigns | Segment, Dates, vs |
| Search terms | Segment, Dates |
| Keywords | Campaign, Dates |
| Budget Allocation | Goal, Budget |
| Ledger | Dates |
| Client View, Data, Mapping, Action detail | none |

---

## Navigation

Three layers: **job → category → view**. All 28 existing views are present; nothing is
hidden behind search only. Job groups are **collapsed by default**, except the group holding
the current view, which auto-expands (otherwise the active item would be invisible).

```
TODAY      Brief · Actions
DIAGNOSE   Performance      → Overview · Monthly Trends · Non-Brand Categories · Regions
           Campaign         → Campaign Performance
           Keyword          → Keyword Deep Dive · Quality Score · Quality Score by Component
                              · KW by Region & Category
           Search terms     → Intent & Grades · Relevant Terms · Competitor Terms · Triage
           Ad copy          → Ad Copy · Ad ↔ LP Pairing
           Landing pages    → LP Performance · LP Category Grid
           Geo              → Geo Performance
           Competition      → Auction Insights
PLAN       Budget Input · Budget Allocation · Budget · Pacing
PROVE      Ledger · Client View
SETUP      Data             → Upload Data · Data Inventory · Campaign Mapping
           Settings         → Business Context · Clients   (Clients is admin-only)
```

Plan and Prove intentionally skip the middle layer — a category tier with one child is a
click that buys nothing. Setup keeps it because Data and Settings are genuinely different jobs.

### Renames applied (old → new)

`Recommendations` (own group) → folded into **Today › Actions** ·
`Business` → **Performance** · `Budget Intelligence` → **Budget Allocation** ·
`QS Overview` → **Quality Score** · `QS Breakdown` → **Quality Score by Component** ·
`Region & Category` → **KW by Region & Category** · `Flagged / Review` → **Triage** ·
Campaign Mapping stays under **Data**, not Settings.

Budget order follows the real workflow: Budget Input (client's top-level number) →
Budget Allocation (spread it across campaigns) → Budget (see the result by campaign) →
Pacing (daily spend).

### Rail specification

**Expanded (248px)** — top to bottom:
- Logo row, `padding:16px 16px 12px`: 20×20 lime tile, `radius:5`, 11px/700 `#1a1a1a` "N";
  wordmark 14px/600 `letter-spacing:-0.01em`; collapse button `«` at `margin-left:auto`,
  24×24, `radius:6`, `#9ca3af`, hover `background:rgba(255,255,255,0.12)` `color:#f9fafb`.
- Search button, `padding:0 12px 12px`: full width, `background:rgba(255,255,255,0.06)`,
  `1px rgba(255,255,255,0.10)`, `radius:7`, `padding:7px 9px`, 12.5px `#9ca3af`,
  label "Search anything" + right-aligned `⌘K` in 10.5px mono at 0.55 opacity.
- Client selector: 9.5px uppercase `#9ca3af` label "CLIENT", then an ink `#1a1a1a` pill with
  `1px #374151` border, `radius:7`, containing a 16×16 `#e5e7eb` initials chip
  (9px/700 `#1f2937`), the client name at 12.5px/500 `#9ca3af` truncating with ellipsis,
  and a `▼` at `margin-left:auto`.
- Nav tree, scrolls, `padding:0 8px 16px`.
- Footer, `padding:12px 16px`, `1px rgba(255,255,255,0.08)` top border: 22×22 `#e5e7eb`
  round avatar (9.5px/600 `#1f2937`) + email at 11.5px `#9ca3af`.

**Nav rows**

| Level | Style |
|---|---|
| Job header | 9.5px/600, uppercase, `letter-spacing:0.1em`, `padding:4px 9px`, `radius:6`, `#f9fafb` when open / `#9ca3af` when closed, hover `rgba(255,255,255,0.06)`. Prefixed by a 10px mono `−` / `+` in a 7px-wide slot. |
| Category header | 11.5px/600, `margin-left:9px`, `#f9fafb` when it holds the active view else `#9ca3af`. Same chevron. |
| View row | 12px, `padding:4px 9px`, `radius:6`, `margin-left:9px` (layer 2) or `22px` (layer 3), `line-height:1.35`. Inactive `#9ca3af`. Active: `background:#cfff04`, `color:#1a1a1a`, weight 600. |

Each view row carries a 4px dot: `#6b7280` inactive, `#1a1a1a` active, `transparent` for a
view not yet built. A row with pending work shows a mono 10px count badge —
`rgba(255,255,255,0.12)` / `#f9fafb`, or `rgba(0,0,0,0.16)` / `#1a1a1a` when the row is active.
A collapsed group with pending work shows a 5px lime dot at `margin-left:auto`.

**Collapsed (56px)** — centred column, `gap:7px`:
- Logo tile, then the collapse toggle `≡`.
- Search icon button, 32×28, `radius:7`, magnifier SVG (circle r6 at 11,11 + line 15.5,15.5→20,20),
  `stroke-width:2`. Opens ⌘K **without** expanding the rail (stops propagation).
- Client initials chip, 26×26, `radius:6`.
- A 28×1px `rgba(255,255,255,0.10)` divider.
- One icon per job group: a 32×28 `radius:8` button holding a 17×17 SVG,
  `stroke-width:1.8`, `stroke-linecap/linejoin:round`, `fill:none`, above an 8.5px label.
  Active group: lime fill, `#1a1a1a` icon, label `#f9fafb`/600.
  Group with pending work (and not active): 6px lime dot at `top:3px right:4px`.
  Clicking an icon expands the rail **and** opens that group.

Single-path icons (`viewBox="0 0 24 24"`):

```
Today     M5 4h14v16H5zM9 3v3M15 3v3M8.5 13l2.5 2.5 4.5-5
Diagnose  M4 19V9M9 19V4M14 19v-7M19 19v-4M3 21h18
Plan      M4 6h16M4 6v13h16V6M8 3v4M16 3v4M8 11h3M8 15h3M14 11h3
Prove     M4 6l8-3 8 3v6c0 5-3.5 8.2-8 9.4C7.5 20.2 4 17 4 12zM8.7 12l2.4 2.4 4.4-5
Setup     M4 7h8M17 7h3M4 17h3M12 17h8M14.5 4.5v5M8.5 14.5v5
```

Substitute equivalents from your icon library if you prefer, but keep them single-weight
line icons at this optical size.

**Collapse behaviour**
- Below **1100px** viewport width the rail auto-collapses. Above it, docked and expanded.
  A manual toggle overrides the automatic choice and sticks for the session.
- Expanding while narrow renders the rail as an **overlay**: `position:absolute`, 248px,
  `z-index:30`, with a 56px spacer holding the layout and a `rgba(26,26,26,0.34)` scrim at
  `z-index:29`. Content does not reflow.
- **The entire collapsed strip is a click target** and expands the rail — logo area, icon
  column, the empty space below it, and the footer avatar. The two exceptions stop
  propagation and do their own thing: the search button opens ⌘K, a group icon expands with
  that group open.
- The overlay **dismisses when a view is selected**, from the nav or from ⌘K. Group and
  category headers do not dismiss it — those are browsing steps, not selections.

---

## Screens

### 1. Brief — the default landing screen

**Purpose:** answer "what do I do today?" in one screen. Replaces an Overview of six KPI
cards, two of which render an empty `—`.

- **Header row**, flex with wrap, 28px bottom margin.
  Left: 11px uppercase `#6b7280` date, then the serif headline at 40px,
  `line-height:1.05`, `max-width:620px`. Copy is generated:
  *"{Three} decisions are waiting, worth {$3,341} a month."* — count spelled as a word,
  the figure wrapped in a lime highlighter
  (`background:linear-gradient(transparent 14%, #cfff04 14%, #cfff04 92%, transparent 92%)`,
  `padding:0 3px`). One open action reads *"One decision is waiting…"*; zero reads
  *"Nothing needs a decision today."*
  Right, `margin-left:auto`: a three-cell counter card (1px `#e5e7eb`, `radius:10`, cells
  divided by 1px borders, `padding:12px 18px`) — **Open / Staged / Verifying**, 10px
  uppercase label above a 22px/500 mono figure. Staged is `#1a1a1a`.
- **Blocking banner**, when campaigns are unmapped: `1px #fcd34d`, `background:#fffbeb`,
  `radius:10`, `padding:14px 16px`. A 26×26 `#b45309` `radius:7` tile with a white `!`,
  then a 13px/600 title *"Budget allocation is blocked — {10} campaigns are unmapped"* and a
  12.5px `#4b5563` body naming how many have a suggested mapping. A `#1a1a1a` button
  *"Map campaigns"* at `margin-left:auto`, hover lime with ink text. The banner disappears
  when nothing is unmapped.
- **Body**, `grid-template-columns: 1.55fr 1fr`, `gap:20px`, `align-items:start`.
  - Left, under a 11px uppercase `#6b7280` "DECIDE FIRST": the **top three open actions**
    as cards (1px `#e5e7eb`, `radius:10`, `padding:14px 16px`, `gap:14px`, hover
    `border-color:#cfff04` + `inset 3px 0 0 #cfff04`). Each card: a right-aligned money
    column `min-width:86px` (17px/600 mono figure above a 10px uppercase qualifier such as
    "RECOVERABLE" / "ZERO-CONV SPEND"), then title 13.5px/600, one-line summary 12.5px
    `#4b5563`, then a chip row — confidence pill, "{Medium} effort", area — then a `→`.
    Below: a text link *"See all 6 open actions →"*.
  - Right: **"What moved — 7 days vs prior 7"** card. Per row: 78px label, a flex-1 SVG
    sparkline (`viewBox="0 0 100 22"`, `preserveAspectRatio:none`, polyline
    `stroke:#9ca3af` `stroke-width:1.6` `vector-effect:non-scaling-stroke`), a 64px
    right-aligned 12.5px/500 mono value, a 62px right-aligned delta. Rows separated by 1px
    `#f3f4f6`. Footnote: *"Green means better, not up. CPA falling is green."*
    Then a **Data health** card: a 7px status dot, label, and a right-aligned mono value per
    row, ending in a link to the data inventory.

### 2. Actions — the queue

The single most important new surface. Tabs (Open / Staged / Verifying / Snoozed) with mono
counts; active tab is `#1a1a1a` filled, others are 1px `#d1d5db` white. Right: "Export CSV"
and a primary "Review staged change set".

Table columns: **Action** (title 13px/600 above a 12px `#6b7280` summary) · **$ / month**
(right, 13px/600 mono) · **Confidence** · **Effort** · **Area** · **Owner** · **Status**.
Rows hover `#fdfff5` and open the action detail.

Confidence pills, `radius:20px`, `padding:2px 9px`, 11px/600 —
High `#fee2e2`/`#b91c1c`, Medium `#fef9c3`/`#b45309`, Low `#1a1a1a`/`#cfff04`.
Status pills, `radius:5`, `padding:3px 8px`, 11px/600 —
Open `#f3f4f6`/`#374151`, Staged `#1a1a1a`/`#cfff04`, Applied `#dcfce7`/`#15803d`,
Snoozed & Dismissed `#f3f4f6`/`#9ca3af`.

### 3. Action detail

- Chip row (confidence, area, effort), then the serif title at 32px, then a 14px `#374151`
  summary at `max-width:660px`. Right: a bordered card with the money figure at 28px/600 mono.
- **"How we got here"** — the methodology, numbered. Each step is a 20px round `#f3f4f6`
  badge, a 13px line of reasoning, and a right-aligned link that opens the **evidence drawer**
  ("8 campaigns", "5,326 terms", "65,819 rows"). Footnote: *"Thresholds come from the
  account's own history, not a global default."* + a Methodology link.
- **"The change set"** — `{n} changes · reversible`, a "Download as Editor CSV" button, and a
  table of Entity / Field / **Now** (mono `#6b7280` struck through) / **Proposed**
  (mono/500 `#1a1a1a`).
- A verification note: 14 days after apply, CPA and conversion volume are compared against
  the pre-change baseline and the result posts to the Ledger.
- **Sticky decision bar** at the bottom of the scroll container (`#ffffff`, 1px top border,
  `padding:12px 24px`): "Assign to" + an assignee chip on the left; Dismiss (hover turns
  `#dc2626`), Snooze 30d, and a primary **Approve & stage** on the right. Staging flips the
  label to "Staged ✓" and fires a toast.

### 4. Campaign Performance — chart and table merged

Two problems fixed here.

**The chart no longer crowds the data.** In the current build a bar chart consumes a full
viewport height to show eight bars, all in the same lime, pushing the table entirely below
the fold. Here the chart *is* the table: the Cost cell contains a 6px `#f3f4f6` track with a
bar sized to share of spend — `#374151` normally, `#d97706` when the campaign is flagged
below the bidding floor — with the figure right-aligned beside it. A compact five-cell KPI
strip sits above (Spend, Conversions, CPA, CVR, "Below bidding floor 6 of 8").

**The totals row is honest.** The current build renders two totals that disagree by exactly
2× on this screen, and sums percentage columns to a meaningless 7,359.8 on Auction Insights.
Adopt one rule in the shared table component:

> Counts and currency **sum**. Rates (CPA, CVR, impression share, overlap rate) are
> **weighted averages**. Columns that cannot be aggregated render **blank**. There is exactly
> one totals row, styled `background:#f9fafb` with a `2px #e5e7eb` top border.

### 5. Search terms · Intent & Grades

Two columns. Left, **"Where the money goes"** — horizontal bars sorted descending, each with
a label, term count, spend and percentage above an 8px track. This replaces a ~600px donut
with nine slices and a legend; bars self-label, so there is no eye travel to a legend, and
part-to-whole comparison is easier.

Right, **Performance grades** — grade pill, terms, spend, conv, CPA, with a weighted totals
row. Pills: A/B `#dcfce7`/`#15803d`, C/D `#fef9c3`/`#b45309`, F `#fee2e2`/`#b91c1c`,
Low volume `#f3f4f6`/`#4b5563`.

Below, a call-out linking the F-graded spend to the negative-shield action — the
insight → action link, made real.

### 6. Keyword Deep Dive

- A `#fffbeb` / `#fcd34d` note explaining that Quality Score is available for 12% of keywords
  because Google only reports it above a volume threshold — **the column is not broken**.
  Mostly-empty columns must explain themselves.
- A filter input plus preset chips (Below-avg eCTR · 597, QS 1–3 · 159, Zero conv · 1,204)
  and a row count noting virtualisation.
- **Every row carries its Campaign · ad group.** In the current build "church goods" appears
  three times with different metrics and no disambiguating column, which reads as a bug.
- A "Weakest component" column turns the QS number into something actionable.
- QS cell: `#dc2626`/600 when low, `#9ca3af` when not reported.

### 7. Budget Allocation

A compact run bar — Goal, Weekly budget, Max weekly change, a curve-fit status, and a
"Run allocation" button — then **Proposed allocation**, with run metadata and the estimated
weekly conversion gain, a "Compare to last run" button and a primary
**"Approve & stage 6 moves"**.

Table: Brand · region · category / Current per week (muted) / Proposed (track bar +
figure + coloured delta) / tCPA move / Est. Δ conv / **Why** (a short plain-language reason —
"Steepest marginal return", "Flat past $5.5k", "Seasonal window closed").

The point: the engine's output now ends in a decision. Approving stages the moves into the
same change set the actions queue feeds, so budget and bidding changes ship and get verified
together.

### 8. Campaign Mapping — a task, not a form dump

The current build renders 48 placeholder-only inputs with ragged left edges. Replace with:

- A progress header: *"{6} of 16 campaigns mapped"*, a note that allocation unblocks at 16,
  a 6px progress bar (`#1a1a1a` on `#f3f4f6`), and a primary
  **"Accept all {6} suggestions"** that hides itself when none remain.
- A fixed column grid — Campaign (300px) / Brand / Region / Category / action (76px) — with
  labels in the header **once**, not as placeholders.
- Values **prefilled from the campaign naming convention**. A suggested row is tinted
  (`#fbffe3` fill, `#e3ff7a` border) with a one-click "Accept". A row with no recognisable
  pattern is tinted `#fef2f2` / `#fecaca` and marked "Manual". An accepted row goes plain
  white and reads "Mapped" in `#15803d`.

### 9. Data

A dashed dropzone stating that report type is detected from the header row, then a
**"What we hold for this client"** table: Report / Rows / Through / **Freshness** pill /
**Unlocks**. Freshness is stated against what each report unlocks, so a stale placement
export explains why the PMax action is only medium confidence. Pills: Current
`#dcfce7`/`#15803d`, partial or ageing `#fef9c3`/`#b45309`, missing `#fee2e2`/`#dc2626`.

### 10. Ledger — the proof surface

Four KPIs (Changes applied · Waste removed · Prediction accuracy · Reverted) above
**"Every change, and what happened after"**: Applied date / Change / By / **Predicted** /
**Actual** / **Verdict** pill (Beat forecast, On forecast, Under forecast, Reverted).

Recording the prediction alongside the outcome is what makes the methodology auditable, and
over time it calibrates the confidence labels on new recommendations. Nothing in the current
app remembers what it recommended last month or whether it worked.

### 11. Client View

A read-only preview of the branded link a client would receive, on a `#f3f4f6` desk with a
12px-radius white sheet, `padding:36px 40px`. Client identity row, then a 30px serif
headline stating the outcome in plain language, a 14px paragraph, a four-cell KPI grid
(1px gaps on an `#e5e7eb` background), and a **"What we did"** list — date, plain-English
title and body, and a `#15803d` result figure. No filters, no raw tables, no internal notes,
no jargon. Footer states the next review date and a contact.

### 12. Placeholder (views not yet rebuilt)

Centred, `max-width:640px`, `padding-top:88px`: the category name in 10px uppercase, the view
name in 34px serif, a paragraph naming the patterns every view inherits, and two buttons.
Keeps the navigation honest and complete rather than hiding unbuilt views.

---

## Interactions & behaviour

| Surface | Behaviour |
|---|---|
| **⌘K / Ctrl-K** | Command palette. Scrim `rgba(26,26,26,0.34)`, panel `min(600px,90vw)` at `12vh`, `radius:12`. Autofocused 15px input. Results grouped by kind (View / Action / Campaign / Keyword) with a 74px uppercase kind label, a 13px/500 label and a right-aligned meta. Searches label, kind and the breadcrumb, capped at 10. Escape closes. Views carry their `Job › Category` breadcrumb. |
| **Evidence drawer** | Opens over the current screen from any evidence link. `min(700px,74vw)`, sticky table header, a footer note and an "Open full view" button. Escape or scrim closes. This is the mechanic that makes 28 views survivable without a filing-cabinet nav — and it should be **bidirectional**: from a table row, "why is this flagged?" → the action; from an action, "show me the rows" → the drawer. |
| **Stage / snooze / dismiss** | Updates the item's status and fires a toast at the bottom centre (`#1a1a1a` fill, `#cfff04` text, `radius:9`, 2.6s). Staging is idempotent. |
| **Accept mapping** | Per-row or bulk. Progress, CTA label, context subtitle, nav badge, Brief banner and Brief data-health row all move together. |
| **Rail collapse** | See the rail spec above. |
| **Hover** | Cards: `border-color:#cfff04` + `inset 3px 0 0 #cfff04`. Table rows: `background:#fdfff5`. Secondary buttons: `border-color:#1a1a1a`. Dark buttons: lime fill **with ink text** — never white-on-lime. Nav rows: `rgba(255,255,255,0.06)`. |

### Behaviours the prototype implies but does not implement

These are the real requirements.

1. **URL routing per view.** The current app is an SPA with no routing — nothing is
   bookmarkable, you cannot send a teammate a link to a screen, and Back does nothing. For a
   multi-person team tool this is a real workflow tax. Every view, action detail and drawer
   state should be addressable, e.g. `/client/:clientId/actions/:actionId`.
2. **Loading skeletons.** View switches currently flash blank white; users read blank as
   broken. Every table and card needs a skeleton matching its final geometry.
3. **Table capabilities** across every view: sticky headers, virtualisation (the keyword
   table is 11,332 rows), column chooser, density toggle, CSV export.
4. **Optimistic updates with undo** on stage / snooze / dismiss / accept. There is currently
   no undo anywhere in the app.
5. **Progress and completion feedback** on long operations — upload and ingest can take a
   while with no indication it is working.
6. **Assignment and multi-user status** on queue items, since the point is a team workflow.

### Derived state — a hard rule

Every count and total in the UI must derive from one source of truth. The prototype had
repeated bugs where a hardcoded "8 open" sat next to a computed "Open 6", and a
"6 of 16 mapped" subtitle contradicted a "12 of 16" header on the same screen. In a product
whose whole argument is that contradictory numbers destroy trust, this is not a cosmetic
issue.

Concretely: derive the sidebar badge, the Brief stat card, the headline count and money
figure, the "see all" link, the context subtitle and the queue tab counts from the same
filtered collection. Handle singular and plural on every generated label
("Accept the 1 suggestion", "See the 1 open action", "1 campaign is unmapped").

### Responsive

Designed for 1440×900 and above; usable down to ~1100px, at which point the rail
auto-collapses. Filter chips and toolbar buttons carry `white-space:nowrap` and the toolbar
wraps with an 8px row gap. Below ~1000px the tables scroll horizontally rather than
compressing.

---

## State

```ts
type Screen =
  | 'brief' | 'actions' | 'action' | 'campaigns' | 'terms' | 'keywords'
  | 'budget' | 'mapping' | 'data' | 'ledger' | 'share' | 'stub';

interface AppState {
  screen: Screen;
  actionId: string | null;

  drawer: EvidenceKey | null;      // evidence drawer contents, null = closed
  palette: boolean;                // ⌘K open
  paletteQuery: string;
  toast: string | null;            // auto-clears after 2600ms

  staged: string[];                // action ids staged into this week's change set
  statusOverride: Record<string, ActionStatus>;   // snoozed / dismissed
  accepted: string[];              // accepted campaign-mapping suggestions

  openGroups: string[];            // 'job:Diagnose' | 'cat:Diagnose/Keyword'
  stubName: string; stubGroup: string;

  railUser: boolean | null;        // null = follow viewport, else manual override
  viewportWidth: number;           // resize listener; < 1100 == narrow
}
```

Derived, not stored: `mapped = 6 + accepted.length`, `unmapped = 16 - mapped`,
`suggestable`, `openActions`, `openMoney`, `topMoney`, `activeLabel`,
`railOpen = railUser ?? !narrow`, `overlay = narrow && railOpen`.

In React this maps to route params (`screen`, `actionId`), a small UI store for
`drawer` / `palette` / `railUser` / `openGroups`, server state for the collections, and a
`useMediaQuery('(min-width: 1100px)')` for the viewport. All state updates that append to an
array must use the functional updater form — the prototype dropped rapid clicks until this
was fixed.

---

## Data requirements

Every screen is fed by one of these shapes. Nothing in the UI computes business logic; the
engine already produces it.

- **Action / recommendation** — id, title, one-line summary, money at stake + its qualifier,
  confidence (high/medium/low), effort, area, owner, status, an ordered `method[]` of
  reasoning steps each with an evidence key, and a `changes[]` of
  `{entity, field, from, to}`.
- **Evidence set**, keyed — title, subtitle, column names, rows, footer note.
- **Campaign row** — name, type, clicks, cost, conv, CPA, CVR, Δ conv, flags.
- **Search-term aggregates** — intent class shares, grade distribution.
- **Keyword row** — keyword, campaign, ad group, match type, QS, weakest QS component,
  cost, conv, CPA.
- **Allocation run** — timestamp, model, estimated Δ conversions, and per-segment
  current/proposed/tCPA move/estimated Δ/reason.
- **Mapping candidates** — campaign name plus suggested brand/region/category, or null when
  the naming convention yields nothing.
- **Data inventory** — report, row count, through-date, freshness state, what it unlocks.
- **Ledger entry** — applied date, change description, actor, predicted, actual, verdict.

---

## Suggested stack

Boring, well-documented, and each choice removes work from the list above.

```
Vite · React 18 · TypeScript · Tailwind
TanStack Table   — sticky headers, virtualisation, column visibility, sorting, CSV export
TanStack Query   — server state, optimistic updates
React Router     — the routing the current app lacks
Recharts or visx — visx if the response curves need to be really good
cmdk             — the command palette
```

Build these three primitives first; every screen is made of them:

1. **`DataTable`** — with the totals-row aggregation rule (`sum` | `weightedAvg` | `none`
   declared per column) baked in so no view can produce a nonsense total.
2. **`StatCard`** / **`StatStrip`** — the KPI patterns.
3. **`InlineBarCell`** — the track-plus-figure cell that replaces standalone bar charts.

Then `EvidenceDrawer`, `ActionCard`, `NavRail`, `ContextBar`, `Pill`.

### On re-platforming

Yes for what you build next; no as a rewrite project. Scaffold React inside the existing repo
and serve the static build from the current FastAPI app — no infra change, same deploy, same
auth. Build the new surfaces (Brief, Actions queue, change set, Ledger) in React from day one,
then port the existing views opportunistically, highest-traffic first. The backend, ingestion
and engine are fine and should not be touched.

One condition: fix the totals-row bug in the current app before porting, or it ships broken
into the new stack.

---

## Assets

No image or icon assets. The five navigation icons are inline single-path SVGs given above;
the search icon is a circle plus a line. Fonts come from Google Fonts:

```html
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

Self-host these for a production app.

---

## Files

```
design_handoff_searchnex_redesign/
├── README.md                                        this document
├── tokens.ts                                        design tokens, ready to import
├── screenshots/                                     each screen at the 1440x900 design width
│   ├── 01-brief.png
│   ├── 02-actions-queue.png
│   ├── 03-action-detail.png
│   ├── 04-campaign-performance.png
│   ├── 05-search-terms-intent-grades.png
│   ├── 06-keyword-deep-dive.png
│   ├── 07-budget-allocation.png
│   ├── 08-campaign-mapping.png
│   ├── 09-data.png
│   ├── 10-ledger.png
│   ├── 11-client-view.png
│   └── 12-command-palette.png
└── prototype/
    ├── SearchNex Redesign Original Colors.dc.html   ← build this one
    ├── support.js                                   runtime; must sit beside the HTML
    └── alt-palette/
        ├── SearchNex Redesign.dc.html               cobalt/paper variant, reference only
        └── support.js
```

Screenshots are reference images captured at the 1440x900 design width — use them to check
your build against the intent, but take exact values from this README or the prototype source,
not by sampling the PNGs.

Open the HTML file directly in a browser. Reading its source is the fastest way to resolve
any value this README does not state — the styles are inline on the elements they affect,
and all the logic is in one class at the bottom of the file.
