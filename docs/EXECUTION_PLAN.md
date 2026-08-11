# Execution Plan — next build items (living roadmap)

Status: **plan approved-pending / nothing built yet.** Branch: `redesign` (shared prod DB, separate
Railway env — `main` untouched). This doc is the single roadmap: new items get added here, each
item gets a status. Update the status line as items ship.

Principles that apply to everything below: deterministic Python owns all math (no AI in scoring or
pacing); honest-methods (show the anchor/assumption behind every number); every capability
degrades gracefully for clients whose data can't support it ("cater any client").

---

## Item 1 — Daily Pacing  `status: planned`

**Goal:** the Pacing view answers "are we on pace *right now*?" day by day — not just after the
month closes. Critical for larger clients; harmless for small ones.

### Data reality (verified)
- `raw_rows` (campaign_performance) already carries per-day `date_norm` for day-segmented
  uploads — chiarelli is `granularity: "daily"` today. **No ingestion changes needed.**
- `meta.date_range.granularity` already tells us per client whether daily is possible.

### Logic (deterministic)
For a selected month (default = the month of the latest dated row):

| Concept | Formula |
|---|---|
| Daily budget | `monthly_budget ÷ days_in_month` (flat line, v1) |
| Cumulative target (day d) | `daily_budget × d` |
| Cumulative actual (day d) | Σ spend through day d |
| Pace % (day d) | cum actual ÷ cum target |
| Projection (month-end) | `MTD spend ÷ days elapsed × days_in_month` (run-rate) |
| Projected variance | projection − monthly_budget |
| Status | same bands as monthly: > 1.05 over · < 0.90 under · else on-track |

- **Days elapsed** = days with data in the month (not calendar-today), so a stale upload doesn't
  fake an "underpacing" alarm; the view states the data-through date explicitly.
- v1 is a **flat** daily budget. Weekday-weighted pacing (weekends spend less) is a listed
  follow-up, not v1 — it needs a weekday profile derived from the account's own history.

### Backend
- New builder `_pacing_daily(engine, client_id, config, keep, month)` in `assemble.py`; returned as
  `budget_pacing.daily = {month, daily_budget, data_through, days: [{date, spend, cum_spend,
  cum_target, pace_pct, status}], projection: {spend, variance, pct, status}, months_available}`.
- Respects the global filters (`keep`) like every other section.
- **Graceful fallback:** clients without daily `date_norm` (or no monthly budget) get
  `daily: null` — the view keeps today's monthly behavior. Monthly-history table stays regardless.
- Month selection via existing `from`/`to` date params (no new API surface): a month-bounded range
  selects that month; default = latest.

### Frontend (Pacing screen)
- StatStrip: MTD spend · cumulative target · Pace % (delta pill) · **Projected month-end** vs
  budget (the headline number).
- Chart (Recharts, same TrendChart conventions): cumulative actual line vs cumulative target
  line; ink + amber, no lime.
- Table: day, spend, cumulative, target, pace %, status pill; honest totals.
- Monthly history table remains below (unchanged).
- If `daily == null`: current monthly view + a note ("daily pacing unlocks with day-segmented
  campaign data").

### Out of scope v1 (listed follow-ups)
- Weekday-weighted target curve; per-category/per-region daily pacing from dimensional
  `budget_lines`; pacing alerts into the Actions queue (decision system) when projection breaches
  budget by >X% — natural later hook.

### Verify
- Unit tests on the builder (synthetic month: flat, front-loaded, gap days, dateless client → null).
- Live: chiarelli (daily data + $2,000 budget) — August MTD vs target; screen renders chart+table;
  a monthly-only client still shows the old view.

---

## Item 2 — Dynamic (account-relative) Grading  `status: designed, awaiting go`

**Problem:** grades use hard-coded absolute bands (e.g. LP "Average" = 20–30% CVR). Chiarelli's
pages run 0–16% → everything reads "Below Avg", which kills the triage value. Absolute bands
silently assume an industry/intent/seasonality profile we can't know.

**Design (agreed direction, pending two calls):** grade **relative to the account's own
distribution** — the account's data already embodies its industry, intent mix, and season.

1. **Cohorts — compare like with like:** branded vs non-branded (exists) × campaign type from the
   central mapping (Search / Shopping / PMax). High-intent branded never graded against cold
   prospecting.
2. **Anchor:** the cohort's volume-weighted **median** of the metric (CVR for pages/terms, CTR for
   ads) across entities passing the volume gates. Seasonality largely self-corrects (the median
   moves with the season).
3. **Ratio bands** around the anchor: A ≥ 1.5× · B 1.15–1.5× · C 0.85–1.15× ("around your norm")
   · D 0.5–0.85× · F < 0.5×.
4. **Guardrails:** volume gates unchanged (Low Volume/"—"); 0 conversions on ≥ 20 clicks → F
   regardless; cohort < 5 gradeable entities or anchor = 0 → fall back to today's static bands.
   Explicitly NOT pure percentiles (they force an F to exist and hide account-wide collapse).
5. **Manual benchmark override:** optional Business Context fields (expected LP CVR, expected NB/BR
   CTR); when set they replace the account median as the anchor — this is how industry knowledge
   enters. Per-client `grading_mode: relative (default) | static` escape hatch.
6. **Transparency:** every graded view captions its anchor — "Graded vs your account median CVR
   5.2% · A ≥ 7.8%".

**Surfaces changed together** (all share the flaw): LP Performance **Score**, Ad Copy **CTR
grade** + **LP grade** (and the Pairing grid that consumes them), **search-term grades**.

**Work:** shared grading helper in `assemble.py`; config fields + sanitize; captions in 4 screens;
tests incl. a skewed account like chiarelli's; update `docs/GRADING_LOGIC.md` to match.

**Open decisions (holding until user go):**
1. Accept "C = normal for this account" as the grade story? (recommended)
2. Keep `static` mode as per-client escape hatch, default `relative`? (recommended)

---

## Item 3 — Shopping Module  `status: planned`

**Goal:** Shopping (and PMax-feed) campaigns are a category of their own — products instead of
keywords, a feed instead of ad copy. Give them a holistic module instead of forcing them through
keyword-shaped views. Module hides entirely for accounts with no Shopping/PMax campaigns
(mapping-driven), so lead-gen clients never see it.

### Data audit — what we have vs what we need

| Source | Status | What it gives |
|---|---|---|
| campaign_performance + **central mapping** (`camp_type` Shopping/PMax) | **Have** | Which campaigns are Shopping/PMax → module scoping, spend/conv/value rollups |
| `products_sold` report (item_id_sold, product_title_sold) | **Have** (ingested) | SALES side: which products actually sold (units/value) |
| `search_terms` | **Have** | Shopping campaigns' queries (filter by campaign via mapping) |
| `pmax_placements`, `auction_insights` | **Have** | PMax serving surfaces; Shopping competitor share |
| **Products report** (Google Ads → Products tab export) | **Need — new report type** | ADVERTISING side per item ID: impr/clicks/cost/conv/conv-value, product title/brand/type/custom labels, and Shopping **benchmark CTR / benchmark max CPC** columns |
| **Product Groups / listing groups** report | Need (optional) | Bid structure, "Everything else" catch-all buckets |
| **Merchant Center feed diagnostics** export | **Need — new report type** | TRUE feed health: disapprovals, warnings, item-level issues. This lives in Merchant Center, not Google Ads — no Google Ads export can provide it. |

### Views (new "Shopping" category under Diagnose)

**Phase S1 — buildable today, no new exports:**
1. **Shopping Overview** — spend / conv / CPA / ROAS (conv_value exists in raw_rows) for
   campaigns mapped Shopping/PMax; share of account; trend; per-campaign table.
2. **Products Sold** — top sellers by units/value from `products_sold`; sold-product mix.
3. **Global "Type" filter** (Search / Shopping / PMax / Display), powered by the mapping
   engine's `camp_type` — NO separate Shopping Search Terms view: the existing Search Terms
   module + this filter covers shopping queries without redundancy (user decision).

**Phase S2 — needs the Products report (new `products_performance` report type):**
4. **Product Performance** — per item: cost, clicks, conv, value, ROAS; **zombies** (spend, no
   sales) and **heroes**; Pareto concentration ("top 20 products = X% of spend/revenue").
5. **Advertised vs Sold** — join Products ↔ products_sold on item ID: spending-but-not-selling
   (cut) and selling-but-underfunded (scale) — the highest-value shopping analysis.
6. **Benchmark gap** — Google's Shopping benchmark CTR/CPC columns vs ours per product/type.
   **Note the synergy with Item 2:** these benchmark columns are exactly the "industry average"
   the dynamic-grading design wants — for Shopping, the grading anchor can be Google's own
   benchmark instead of the account median.

**Phase S3 — PARKED (user decision): Merchant Center diagnostics.** Full Feed Health needs the
Merchant Center export (separate login) — revisit later. Interim: if the Products report export
includes Google Ads' **Product status** column, S2 gets a feed-coverage-lite widget (ready-to-serve
vs not) for free — clearly labeled as Google-Ads-surfaced status, not full MC diagnostics.

### Google Ads export spec (S2) — exact reports + columns, pulled BY DAY

**Report A — "Products" (required; new report type `products_performance`).**
Google Ads → Insights & reports → Report editor → predefined "Shopping – Product" (add columns)
or a custom table on the Product basis. CSV, date range = as far back as available, **segmented
by Day**. Name like the rest of the set, e.g. `AE - 16 Products (Daily).csv`.

| Column (Google Ads name) | Required? | Why |
|---|---|---|
| Day | **Required** | daily grain (pacing/date filters/merge-by-window) |
| Campaign | **Required** | scoping via mapping; type attribution |
| Item ID | **Required** | THE join key (↔ products_sold, ↔ future MC) |
| Product title | **Required** | display |
| Impressions | **Required** | volume gates, CTR |
| Clicks | **Required** | CTR/CVR |
| Cost | **Required** | spend, zombies, Pareto |
| Conversions | **Required** | CVR/CPA |
| Conversion value | **Required** | ROAS |
| Product type (level 1; +2/3 if offered) | Recommended | category dimension for products |
| Benchmark product click-through rate | Recommended | benchmark-gap view; grading anchor |
| Benchmark product max. CPC | Recommended | benchmark-gap view |
| Ad group | Optional | drill-down |
| Product brand | Optional | multi-brand feeds |
| Custom label 0–4 | Optional (if client uses them) | client's own segmentation |
| Product status | Optional (if offered) | feed-coverage-lite |
| Click share | Optional | shopping share-of-voice |

Caveat: products with zero impressions in the range don't appear in this report — "selling but
not advertised" comes from the products_sold join, not from this file.

**Report B — existing "Products Sold" export: add the Day segment.** Keep its current columns;
adding Day gives the sales side the same daily grain (and merge-by-window compatibility).

**Report C — "Product groups" (optional, later).** Campaign, Ad group, Listing group (path), Day
+ Impr/Clicks/Cost/Conv/Conv value (+ benchmark cols). Unlocks the bid-structure view and
"Everything else" leakage analysis. Not needed for S2 core.

Only pull these for accounts that actually run Shopping/PMax (the mapping knows).

### Integration points (why this slots in cleanly)
- **Mapping engine** is the backbone: `camp_type` decides module visibility and scoping; the
  auto-mapper already tags Shopping/PMax from campaign names.
- **Dynamic grading** (Item 2): products grade in their own cohort (vs account product median, or
  vs Google benchmark when present) — never against Search keywords.
- **Analyzers → Actions:** new shopping findings (zombie spend over threshold, disapproved
  top-seller, benchmark-CTR gap) become recommendations with `action_key` → Actions queue.
- **Ingestion:** new report types ride the existing parser/detect pattern + merge-by-window (once
  merged); EXPECTED_REPORTS coverage counts them only for accounts that have Shopping campaigns,
  so lead-gen clients' Data Inventory doesn't nag about irrelevant reports.

### Open decisions
1. Which client exports the Products report first (drives S2 column reality — Google's export
   columns vary by what's picked in the UI; we build the parser against a real file).
2. Merchant Center access: who pulls the diagnostics export per client, and how often (it's a
   separate login from Google Ads).

---

## Backlog (known, not yet scheduled)

| Item | Notes |
|---|---|
| Ingestion merge-by-window → `main` | Built + tested on `fix/ingest-merge-by-window`; PR to `main` awaiting user review/merge. After merge, also bring into `redesign` so both apps merge-on-upload. |
| Simulator / curve-fitting UI | Budget Allocation is gated on fitted response curves; no UI exists to add simulator points. Unlocks end-to-end allocation runs. |
| MCC bulk-account upload flow | Preview/commit endpoints exist; redesign UI not built (single-client upload IS built). |
| Prove · Client View | Last unbuilt nav view; confirm intended content first. |
| Clear filters on client switch | A campaign/region filter from client A persists onto client B (shows empty data until reset). Small fix in ClientSwitcher/AppShell. |
| Analyzer explicit `key=` args | Decision-system action identity currently falls back to module+title (stable today); explicit keys harden it. |
| Weekday-weighted pacing targets | Follow-up to Item 1. |
| Pacing → Actions alert | When projection breaches budget, surface as a decision-system action. |

---

## Recommended execution order

1. **Daily Pacing** — self-contained, data already supports it, no open design questions.
2. **Dynamic Grading** — bigger blast radius (4 surfaces + config + docs); start after the two
   open decisions are confirmed.
3. **Shopping Phase S1** — buildable from existing data, independent of 1–2 (can be pulled
   earlier if priorities shift). S2 starts once a client's Products report is exported; S3 once a
   Merchant Center diagnostics file exists.
4. Backlog items as prioritized by user (suggested next: clear-filters-on-switch as a quick win,
   then simulator UI to make Budget Allocation fully runnable).

Each item ships in the established loop: build → `tsc`/`pytest`/`npm run build` → commit/push to
`redesign` → verify live against real client data → update this doc's status line.
