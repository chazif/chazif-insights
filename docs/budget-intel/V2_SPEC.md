# Budget Intelligence V2 — Build Spec

**Status:** decided, not built. Decisions made 2026-08-04.
**Companion:** the visual map of the engine (today + decided direction) —
https://claude.ai/code/artifact/27e01d30-557a-4f39-93ed-cca0a4fc31fe
**Baseline:** `engine/budget_intel/` at commit `2bfd8f5` (model.py, allocate.py,
curves.py, service.py, tables.py, bq_mirror.py; routes in
`backend/budget_intel_routes.py`). Original spec: `FEATURE_SPEC.md`,
`MODEL_SPEC.md` in this folder.

## Kickoff prompt for Claude Code

> Read docs/budget-intel/V2_SPEC.md end to end, then MODEL_SPEC.md §§2–6 and
> the current engine/budget_intel/*.py. Implement the PRs in §7 in order, one
> PR per item, each independently mergeable. The existing golden test
> (tests/test_budget_intel_golden.py) must keep passing unchanged at every PR —
> every behavioral change is additive behind a mode/flag, with the legacy path
> preserved for parity. Write the new tests named in each PR before the
> implementation. Follow the conventions already in the module (SQLAlchemy
> Core, dialect-agnostic, client_id isolation on every table, no LLM anywhere).

---

## 1. Why V2

Tracing the math in the current engine surfaced one structural issue and
several agreed extensions:

- **Business conversions are derived from spend, not from leads.**
  `cars(t) = spend(t) ÷ cost_per_car` uses a constant, so the lead curve's
  diminishing returns never reach the profit calculation. Profit rises in a
  straight line and the "profit-max" ceiling is really the curve's saturation
  point. V2 chains outcomes from leads so every goal has a genuine optimum.
- **One hardcoded outcome ("cars")** becomes a **goal ladder** with a value on
  every rung, so the model can answer "when does the next dollar stop paying."
- **One account-level curve** becomes **per-campaign curves summed into cells**.
- **The guard is a rate limiter**, configurable, with held-back money reported.
- **The calibration loop closes** and **runs enter the decision lifecycle**.

Everything below is a delta against the current code.

---

## 2. Goal ladder

```
all_conv        everything Google Ads reports          (Google: "All conv." column)
 └ main_conv    the client's chosen subset             (Google: "Conversions" column) ← the curve
    └ transactions   a visit that bought
       └ customers        unique buyers
          └ new_customers first-time buyers
value goals:  revenue, gross_profit — on whichever rung the client has, at that rung's value
```

**Rules**
- Google rungs are always available (present on every campaign row). Business
  rungs are available per client only when data exists for the reference
  period. The available-goals list is **derived from data, never configured**.
- Each rung reached from the one above by an **observed per-cell ratio**
  (`units[rung] ÷ units[parent]`), held constant along the curve (stated
  assumption; tested by calibration).
- **Every rung carries a value per unit** (`bi_goal_config`). A rung without a
  value still runs but is volume-maximizing within budget; results must say
  so explicitly ("volume goal — no profit optimum").
- Main-conversion definition: CSV interim = Google's `conversions` column;
  API target = a per-client picker over conversion actions.

### Schema (new)

```
bi_goal_values                       # business outcomes, at the grain they arrive
  client_id (pk), campaign (pk), period_start (pk, date), goal_key (pk),
  units (float), source (str16: upload|api|manual), updated_at
  -- goal_key ∈ {transactions, customers, new_customers, revenue}
  -- campaign-grain rows roll up to cells through bi_campaign_mappings;
  -- rows whose campaign is NULL are account-level and distribute proportional
  --   to main_conv across the client's cells (documented default).

bi_goal_config                       # "a value on every rung"
  client_id (pk), goal_key (pk),
  value_per_unit (float, nullable), margin_pct (float, nullable),
  label (str64), updated_at
  -- gross_profit = units × value_per_unit × margin_pct − spend
```

`bi_business_metrics` stays for migration; `car_count` maps to
`goal_key='transactions'`, `revenue_per_conv`/`gp_pct` seed `bi_goal_config`
for `transactions`. Remove after one release.

---

## 3. Projection chain (model.py)

**Today** (keep behind `mode="legacy"` for the golden test):
```
cars(t)    = mround(spend(t) ÷ cost_per_car)
revenue(t) = cars(t) × rev_per_car
adroi(t)   = revenue(t) × gp_pct − spend(t)
```

**V2** (`mode="chained"`, the default for new runs):
```
leads(t), cpl(t), spend(t)                      unchanged
units[g](t)   = mround(leads(t) × ratio[g])     ratio[g] = observed units[g] ÷ observed main_conv
revenue[g](t) = units[g](t) × value_per_unit[g]
profit[g](t)  = revenue[g](t) × margin_pct[g] − spend(t)
```

`Cell` gains `goal_units: dict[goal_key, float]` (observed, reference period)
and `Surfaces` gains per-goal `units`, `revenue`, `profit` dicts. `main_conv`
and `all_conv` are rungs too (`ratio = 1` and `all_conv ÷ main_conv`).

**Ceiling vs optimum** — two numbers, both surfaced:
- `spend_saturation` — spend at the curve freeze point (goal-independent).
- `spend_cap[g]` — spend at `argmax profit[g]` (per goal). For volume goals
  without a value, `spend_cap[g] = spend_saturation`.

**Test:** `tests/test_budget_intel_chained.py` — synthetic cell; assert the
chained profit curve has an interior maximum strictly below saturation when
`value_per_unit × margin × ratio` lies between the min and max marginal cost per
lead; assert two goals with different values produce different `spend_cap`;
assert legacy mode still equals the golden fixture.

---

## 4. Scores and allocation

### Scores (model.scores)
One parameterized shape replaces the four hand-written variants:
```
score[g] = (units[g] ÷ impr) × (units[g] ÷ cost)^p × max(headroom_cap − IS, 0.01) × value_weight[g]
```
Defaults `p = 2`, `headroom_cap = 0.75`, `value_weight = value_per_unit or 1`.
Keep the legacy four behind `legacy_scores=True` (golden parity).

### Scenarios per goal (service.create_run, allocate.run_allocation)
- A run computes **one allocation per available goal** and stores all of them.
- `bi_allocation_results` gains `goal` in the primary key:
  `(run_id, goal, brand, region, category)`.
- `bi_allocation_runs` gains `goals_computed` (JSON list) and `chosen_goal`
  (set at finalize). `goal` on the run becomes the *requested default* view.
- Results gain `spend_saturation`, `held_back` (see §5), and `data_source`
  (which rung fed the run and where it came from — shown on every card).
- API: `GET runs/{id}` returns `{scenarios: {goal: [results]}, disagreements:
  [...]}` where `disagreements` lists cells whose recommended direction differs
  across goals (sign of `rec_spend − lw_spend`), sorted by spend magnitude.
- `POST runs/{id}/finalize` takes `{goal}`; predictions are stamped for that
  goal only.

**Tests:** run with three goals available → three scenario sets, same cells;
finalize with a goal → `chosen_goal` set, predictions stamped for that goal;
`disagreements` non-empty when two goals recommend opposite directions.

---

## 5. Guard, held-back money, reference period

### Guard configuration (new table)
```
bi_guard_config
  client_id (pk), brand (pk, '' = any), region (pk, '' = any), category (pk, '' = any),
  max_change_pct (float), updated_at
```
Most-specific match wins (category > region > brand > client). Default 0.30
when no row matches. Resolved band recorded per cell in results
(`guard_band_pct`).

### No redistribution — but nothing silent
After clamping, **do not re-run the allocator**. Instead:
- per cell: `held_back = proposed − shipped` (positive when clamped down,
  negative when clamped up; store both `proposed_spend` and `rec_spend`)
- per run: `held_back_total`, and `weeks_to_target` per cell
  (`ceil(log(cap ÷ lw) ÷ log(1 + band))` when moving up, analogous down)
- UI copy: "$X held back by the change limit — available next run", listing the
  clamped cells.

### Override (audited)
`POST runs/{id}/override` with `{cell_key, spend, reason, actor}` sets
`rec_spend` for that cell past the band, records the override in
`run.params.overrides[]`, and writes an entry to the app's actions log /
decision ledger. Once roles exist, require `senior`. Never silently.

### Reference period (build_cells)
`run_params.reference = {"mode": "week"|"trailing", "period_start": ...,
"weeks": 4, "exclude": ["2026-07-01", ...]}`. `build_cells` aggregates over the
selected window; both the projection baseline **and** the guard use it.
Default: the latest complete week.

**Tests:** guard hierarchy resolution (4 rows, most-specific wins); held-back
accounting sums exactly to `Σ proposed − Σ shipped`; override recorded and
reflected; reference-period exclusion changes `lw_spend`.

---

## 6. Curves, calibration, lifecycle, signals

### Per-campaign curves (curves.py)
- `bi_simulator_snapshots` already has `campaign`; add `sim_type`
  (`budget` | `target_cpa`) and `x_axis` (`is_share` | `spend`).
- API path ingests `campaign_simulation` (BUDGET now; TARGET_CPA stored for
  §6d) → points of `spend → conversions`. **Canonical curve representation
  becomes a spend-indexed table** `{spend[], conversions[]}` (100 points);
  the existing IS-based fit produces one via `spend(t) = cpl(t) × leads(t)`.
- `bi_curve_fits` gains `scope_campaign`. Cell curve = **sum of its
  campaigns' conversion curves on a shared spend grid** (interpolate each
  campaign to the grid, sum). Fallback: cell fit → account fit → packaged
  prior.
- **Partial pooling:** cell prediction = `w × cell_fit + (1 − w) × account_fit`,
  `w = n ÷ (n + k)`, `n` = simulator points backing the cell, `k = 8`
  (config). Diagnostics record `w`.
- UI: every recommendation shows which curve produced it (scope, source, R²,
  points, age).

**Tests:** two campaign curves sum correctly on the grid; pooling weight moves
prediction toward the account fit as `n → 0`; IS-based legacy curve converts
to the spend table and still reproduces golden projections.

### Calibration loop (service.reconcile_predictions)
- For every finalized run with predictions lacking `actual`: when data for the
  period following `run_at` exists, compute actuals via `build_cells` for that
  period and write `{is, cpa, units[chosen_goal], spend}` + `measured_at`.
- Triggers: after every ingest (hook beside `_sync_mappings` in
  `backend/main.py`, fail-soft) and `POST .../calibration/reconcile`.
- `GET .../calibration` → per cell, per goal: predicted vs actual history,
  MAPE, bias; plus **simulator-vs-actual** so Google's optimism is measurable.

**Tests:** finalize → ingest next period → `actual` populated; second ingest
doesn't overwrite; MAPE computed.

### Decision lifecycle hookup (finalize_run)
On finalize, for each cell whose `|rec_spend − lw_spend| ÷ lw_spend` exceeds a
threshold (config, default 5%), create an action in the existing decision
system (`backend/decision_routes.py` and the engine module it imports — match
its create-action signature) with the result row as evidence and the tCPA
move as a second action. Idempotent per `(run_id, goal, cell)`.

### Explanatory signals (display-only, never model inputs)
`build_cells` also aggregates `is_lost_budget` / `is_lost_rank`
(eligible-impression weighted). Results carry them; the card shows a caution
when `is_lost_rank ≥ 0.35`: "budget alone is unlikely to buy this share — pair
with the tCPA move." Search-term depth and auction insights are linked, not
computed.

### d. Target-CPA simulations — evaluate only
Ingest and store `TARGET_CPA` simulation points alongside BUDGET ones. No
model change in V2. Add a comparison report (`GET .../simulations/compare`)
showing the budget curve's implied CPA at each spend against the tCPA curve —
the calibration loop decides which to trust before either is used jointly.

---

## 7. PR sequence

| # | PR | Contains | Depends on |
|---|---|---|---|
| 1 | `bi-v2-chained-projection` | §3 chained mode + `bi_goal_config` + chained test; legacy mode preserved | — |
| 2 | `bi-v2-goal-ladder` | §2 `bi_goal_values`, `build_cells` ratios, migration from `bi_business_metrics`; §4 parameterized score; scenarios per goal + results schema; `disagreements` | 1 |
| 3 | `bi-v2-guard` | §5 guard table + hierarchy, held-back accounting, override endpoint, reference period | 2 |
| 4 | `bi-v2-calibration` | §6 reconcile + calibration endpoint + ingest hook; lifecycle hookup on finalize | 2 |
| 5 | `bi-v2-curves` | §6 per-campaign curves, spend-grid canonical form, cell aggregation, pooling, diagnostics in UI | 1 (data via API or per-campaign manual paste) |
| 6 | `bi-v2-signals` | lost-IS aggregation + display caution; TARGET_CPA ingestion + compare report | 2, 5 |

PRs 1–4 need nothing from the Google Ads API. PR 5 is buildable now with
manual per-campaign snapshots and switches to API points when they land.

---

## 8. Acceptance (whole of V2)

1. Golden test passes unchanged at every PR (`legacy` modes).
2. Chained projection produces an interior optimum on the synthetic fixture and
   the optimum differs by goal.
3. A client with only Google conversions runs end to end on `main_conv`; a
   client with transactions + customers uploaded sees those goals appear
   without configuration.
4. One run → N scenarios; finalize picks one; disagreements listed.
5. Guard band resolves per hierarchy; `Σ held_back` reconciles exactly;
   override is recorded and auditable.
6. Finalize → next ingest → `actual` written; calibration endpoint reports
   MAPE per goal and simulator-vs-actual.
7. Finalized runs create decision-lifecycle actions, idempotently.
8. Cell curves aggregate from campaign curves; thin cells pool toward the
   account fit; every result names its curve.
9. All new tables carry `client_id` isolation (two-client test); SQLite and
   Postgres both pass.

---

## 9. Decision log (for reference)

**Decided:** goal ladder with a value on every rung · outcomes chained from
leads · business data keyed by campaign + period · one goal per run, all goals
computed as scenarios · per-campaign simulations summed into cell curves with
partial pooling · close the calibration loop and enter the decision lifecycle ·
guard band per client → category → line item (default ±30%), no
redistribution, held-back reported, audited override · selectable reference
period · daily API data replaces manual snapshots.

**Evaluate:** budget + target-CPA simulations together.

**Explanatory only:** lost-IS split (display caution), search-term depth,
auction insights.

**Deferred:** per-campaign observed-history fitting · curve-shifting levers
(negatives, landing pages, QS) · seasonality.
