# Budget Intelligence — Model Specification

Reverse-engineered from `DRM - All Accounts - Revenue & AdROI - V5.2.xlsx` (Mavis,
week of 2026-02-22). Every formula below was read from the workbook's cells; cell
provenance is cited so it can be re-verified against `fixtures/`. This is the
authoritative math spec for `engine/budget_intel/`.

**Unit of analysis:** Brand × Region × Category ("cell" below). Campaigns roll up
to cells via campaign mapping. The fixture account has 4 regions × ~6 categories
under one brand (BP), 24 active cells.

**Vocabulary:** IS = search impression share (integer percent 1–100). Leads =
"Main Conv." (calls + reservations + other primary conversions). Car Count = the
business conversion (a serviced car). LW = last week (the actuals period).

---

## 1. Inputs

Per cell, from the actuals period (see `fixtures/actuals.csv`, header row 2):

| Symbol | Column | Meaning |
|---|---|---|
| `impr` | D | Impressions |
| `clicks` | E | Clicks |
| `cost` | F | Spend ($) |
| `main_conv` | I | Leads (main conversions) |
| `cpa` | J | cost / main_conv |
| `tcpa` | K | current tCPA target (from bid strategy report) |
| `is_share` | L | impression share (fraction) |
| `is_lost_budget` | M | IS lost to budget (fraction) |
| `is_lost_rank` | N | IS lost to rank (fraction) |
| `conv_rate` | O | main_conv / clicks |
| `rev_per_car` | Q | **business input** — revenue per car, per category |
| `gp_per_car` | R | business input — gross profit per car |
| `gp_pct` | S | business input — GP % (gp_per_car / rev_per_car) |
| `cost_per_car` | T | cost / car_count |
| `car_count` | U | business conversions attributed to the cell |
| `is_current` | Y | IS as rounded integer percent (curve index) |

Account-level run inputs: `budget` (weekly $, fixture: 48000), `goal`
(one of `main_conv | car_count | gp | revenue`; fixture ran `car_count`).

---

## 2. Response curves (Ratios sheet)

One master curve pair, account-level, fitted offline from Google budget-simulator
points (`fixtures/google_budget_tool.csv`):

```
Leads(IS) = L / (1 + exp(-k * (IS - x0)))     L = 5964.43, k = 0.1225, x0 = 21.94
CPL(IS)   = a*IS² + b*IS + c                  a = -0.00192, b = 0.23334, c = 1.43473
```

(Ratios!G2, Ratios!G3. Workbook rounds Leads with MROUND(...,1).)

**IMPORTANT — the production run used TABLES, not these formulas.** The ratio
grids' numerator/denominator source (Ratios!A11:B110 and the cached master rows)
are pasted literals from an earlier curve version: leads and CPL both hold flat
from IS≈60 (a monotone cap — both curves freeze once CPL, at 2dp, stops rising).
The parametric formulas above, evaluated fresh, diverge from the tables beyond
IS≈59. The authoritative tables ship in `fixtures/curve_params.json →
master_tables`; the golden test MUST use them. The engine's parametric generator
(`MasterCurves.from_params`) reproduces the same cap behavior for new fits.

**Per-cell scaling** (the "ratio" method — Projections!E3, DD3 via the
Ratios!G11-grid `= G$2/$A11` = Leads(target)/Leads(current)):

```
leads_cell(t)   = main_conv * Leads(t) / Leads(is_current)      # t = target IS 1..100
cpl_cell(t)     = cpa       * CPL(t)   / CPL(is_current)
```

The engine replaces the workbook's 100×100 precomputed ratio grids with direct
function evaluation. Parameters must be stored per client (versioned), not
hardcoded — see FEATURE_SPEC §curve service.

---

## 3. Projection surfaces (Projections sheet, blocks of 101 cols per metric)

For each cell and each t ∈ 1..100 (provenance: E3, DD3, HB3, LA3, OZ3, SX3):

```
leads(t)     = round(leads_cell(t))                     # block "Leads"
cpl(t)       = cpl_cell(t)                              # block "CPL"
spend(t)     = cpl(t) * leads(t)                        # block "Spend"
cars(t)      = round(spend(t) / cost_per_car)           # block "Car Count"  (¹)
revenue(t)   = cars(t) * rev_per_car                    # block "Revenue"
adroi(t)     = revenue(t) * gp_pct - spend(t)           # block "Ad ROI" = GP − spend
```

(¹) Constant cost-per-car assumption — known model debt; marginal cars cost more
than average cars, so cars(t) overstates at large spend increases. Surface as a
caveat in UI; do not "fix" silently — golden test depends on matching this.

Derived per cell:
```
max_adroi        = max over t of adroi(t)                       # BudgetAlloc!E3
is_at_max_roi    = argmax t of adroi(t)                         # BudgetAlloc!F3
spend_cap        = spend(is_at_max_roi)                         # BudgetAlloc!G3 — profit-max spend
spend_floor      = min over t of spend(t)                       # BudgetAlloc!H3 (≈ spend at IS=1)
```

---

## 4. Opportunity scores (Opportunity Scores sheet Q/R/S/T3)

Four goal-specific variants; the run's `goal` selects one (Recommendation 2!D3
switches on the goal cell Z1). Column refs from §1; `AA = car_count`,
`W = rev_per_car`, `X = gp_per_car`.

```
score_main_conv = (main_conv/cost) * (main_conv/impr) * ((impr/is_share)*(1-is_share)) * 0.25
score_car_count = (car_count/impr) * (car_count/cost)² * max(0.75 - is_share, 0.01) * 1e8 * 0.25
score_gp        = (car_count/impr) * (car_count/cost)² * gp_per_car² * max(0.55 - is_share, 0.01) * 1e3 * 0.25
score_revenue   = (car_count/impr) * (car_count/cost)  * rev_per_car * max(0.55 - is_share, 0.01) * 1e4 * 0.25
```

Interpretation: efficiency (conversions per dollar) × propensity (conversions per
impression) × headroom (unclaimed IS, capped) × value weight. The magic constants
(1e8, 1e3, 1e4) only normalize magnitudes — scores are used *proportionally*, so
uniform constants cancel in allocation. Expose as config.

**Workbook integrity quirks (reproduce via test overrides, NOT in engine code —
full detail in `fixtures/curve_params.json → score_quirk`):**
1. Each region's first row (3/10/17/23) carries a trailing `*0.25` on all four
   variants; other rows don't. Non-uniform → it DID change the allocation.
2. Opportunity Scores rows 11–12 compute from the wrong rows' inputs (one-row
   data shift vs Actuals in the Colorado block).
3. Budget Allocation `I5`/`I12` are broken references (point at `D6`/`D13`), so
   the allocator consumed the next row's score for both NB BRAKES T2 cells —
   and the Recommendation sheet's displayed score disagrees with the allocator's
   input on those rows. Golden assertions for allocation use BA col I (the
   vector actually consumed).

Region TOTAL rows use a weighted rollup (not needed for allocation — allocation
runs on leaf cells only).

---

## 5. Budget allocation (Budget Allocation sheet, cols I→AF)

Five-pass proportional waterfall with caps and floors (J3, N3, R3, V3, Z3, AF3):

```
remaining = budget
alloc[cell] = 0
for pass in 1..5:
    eligible = cells with alloc[cell] < spend_cap and score > 0
    for cell in eligible:
        share = remaining * score[cell] / sum(score[eligible])
        give  = clamp(share, 0, spend_cap[cell] - alloc[cell])   # cap at headroom
        alloc[cell] += give
    remaining = budget - sum(alloc)                # leftover rolls to next pass
final[cell] = clamp(alloc[cell], spend_floor[cell], spend_cap[cell])   # AF col
```

Workbook pass leftovers for the fixture run: 48000 → 9080.19 → 1047.44 → 0 → 0.
(Details the code must honor for the golden test: pass-1 also applies a min-spend
floor `H`; a cell that hits its cap drops out of later passes' score sums —
`M3 = IF(K3<G3, score, 0)`.)

**Engine implementation note:** implement `mode="legacy_waterfall"` exactly as
above (golden test reproduces `fixtures/budget_allocation.csv` col AF), plus
`mode="greedy_marginal"` (allocate in $100 steps to the cell with best marginal
goal-metric on its curve, same caps/floors) as the default for new work — it's
what the waterfall approximates. Both must satisfy invariants: sum(final) ≤ budget
(± floor adjustments), floor ≤ final ≤ cap per cell.

---

## 6. Expected metrics & the recommendation row (Recommendation 2)

Given `final_spend` per cell, read expectations off the curves (I3, L3, Q3, W3, Z3):

```
expected_is       = smallest t with spend(t) ≥ final_spend      # XLOOKUP match_mode 1
expected_cpa      = cpl(expected_is)
expected_cars     = cars(expected_is)
expected_leads    = leads(expected_is)
expected_revenue  = revenue(expected_is)
expected_adroi    = adroi(expected_is)
tcpa_adjustment   = expected_cpa - tcpa          # P3: the bid-strategy change to make
```

Output row per cell (matches `fixtures/recommendation_goal_carcount.csv`):
cell id, opportunity score, expected vs LW spend (+diff), expected vs LW IS,
expected vs LW CPA, current tCPA, **tCPA adjustment**, expected vs LW car count,
cost/car, revenue, Ad ROI. Region/account TOTAL rows sum spend and car count.

There is also a "Recommendation @ Max ROI" variant (Recommendation 2 cols AD+):
same math with `final_spend = spend_cap` (ignore budget; pure profit-max) — this
is the second goal preset.

---

## 7. Golden test (acceptance gate for the engine)

Input fixtures: `actuals.csv` (period inputs + business metrics),
`curve_params.json`, budget=48000, goal=car_count, legacy_waterfall mode.

Must reproduce, within tolerance (float 1e-6 except where the workbook rounds):
1. `projections_expected.csv` — all six surfaces, all cells, t = 1..100.
2. `opportunity_scores.csv` cols Q/R/S/T.
3. `budget_allocation.csv` — per-pass allocations J/N/R/V/Z and final AF.
4. `recommendation_goal_carcount.csv` — the full output table (goal: Car Count).

`campaign_raw.csv`, `bid_strategy_raw.csv`, `campaign_mapping.csv` additionally
fixture the upstream join (raw reports → mapped Actuals rows) for B1 tests.

## 8. Known model debts (carry as UI caveats + backlog, do not silently fix)

- Constant cost-per-car across spend levels (overstates volume at high spend).
- One master curve scaled by ratios (no per-category saturation shape) until
  per-category fits mature (FEATURE_SPEC §curve service fallback hierarchy).
- Curve params fitted once, manually — replaced by the curve service (simulator
  prior + observed-data refits, weekly cadence).
- `max(0.75 − IS, 0.01)`-style headroom caps are heuristics; keep configurable.
