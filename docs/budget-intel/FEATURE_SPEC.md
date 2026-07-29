# Budget Intelligence — Feature Build Spec

Module 2 of SearchNex Ads (see `/ROADMAP_V2.md` §8 for how this fits the platform
plan; `MODEL_SPEC.md` in this folder for the authoritative math). This document is
the build contract: schema, engine layout, endpoints, UI, and acceptance criteria.

**What it does:** ties client business outcomes (revenue per conversion, GP%) to
Google Ads levers via impression-share response curves, and produces a weekly,
goal-driven budget allocation across Brand × Region × Category — recommended spend
moves and tCPA adjustments, each with expected outcomes attached.

**House rules (from the existing codebase):** SQLAlchemy Core, dialect-agnostic
(SQLite dev / Postgres prod) as in `engine/ingest/store.py`; deterministic math in
engine code, no LLM anywhere in this module; per-client isolation by `client_id`
on every table; graceful degradation when a client lacks a required report.

---

## Stage B1 — Data foundation

**New tables** (add to `engine/ingest/store.py` following its conventions):

```
campaign_mappings:
  client_id (str64, pk), campaign (str512, pk),
  brand (str64), region (str64), category (str64),
  engine (str16), camp_type (str32), updated_at (datetime)

business_metrics:
  client_id (str64, pk), brand (str64, pk), region (str64, pk), category (str64, pk),
  period_start (date, pk),
  revenue_per_conv (float), gp_pct (float), source (str16: "config"|"upload"),
  updated_at (datetime)

curve_fits:
  id (pk auto), client_id, scope_brand/scope_region/scope_category (nullable →
  null = account-level), fitted_at (datetime),
  params (JSON: {leads: {L,k,x0}, cpl: {a,b,c}}),
  diagnostics (JSON: {r2_leads, r2_cpl, window_start, window_end, n_points}),
  source (str16: "simulator"|"observed"|"blend"|"manual"), active (bool)

simulator_snapshots:
  id (pk auto), client_id, campaign (str512), taken_at (datetime),
  source (str16: "manual"|"api"),
  points (JSON: [{is_share, spend_week, leads_week, cpl}, ...])

allocation_runs:
  id (pk auto), client_id, run_at (datetime), created_by (str),
  goal (str16: main_conv|car_count|gp|revenue|max_roi),
  budget (float), mode (str24: legacy_waterfall|greedy_marginal),
  params (JSON: floors/caps overrides, score variant config),
  status (str16: draft|final), notes (str512)

allocation_results:
  run_id (fk, pk), brand (pk), region (pk), category (pk),
  opp_score, lw_spend, rec_spend, spend_cap, spend_floor,
  expected_is, lw_is, expected_cpa, lw_cpa, tcpa_current, tcpa_recommended,
  expected_conv, lw_conv, expected_cars, lw_cars,
  expected_revenue, expected_adroi  (all float)
```

**Ingestion additions:**
- Parse the two report types the model needs (fixtures show exact shapes):
  campaign performance with `Search impr. share`, `Search lost IS (budget)`,
  `Search lost IS (rank)` (`fixtures/campaign_raw.csv`) and bid strategy with
  `Target CPA` (`fixtures/bid_strategy_raw.csv`). Follow the existing
  column-based report detection in `engine/ingest/parser.py`.
- On every ingest: detect campaigns absent from `campaign_mappings` → surface an
  "unmapped campaigns" list via API (blocks allocation runs until resolved).
- Mapping convention (see `fixtures/campaign_mapping.csv`): campaign names like
  `BP_G_PMX_ARIZONA` parse as BRAND_ENGINE_TYPE_REGION; offer parsed suggestions
  in the mapping UI, human confirms.

**Actuals view:** a query/materialized view joining mapped campaign metrics +
bid-strategy tCPA + `business_metrics` to the Brand × Region × Category grain —
the programmatic equivalent of the workbook's Actuals sheet (column semantics in
MODEL_SPEC §1). Car-count attribution: conversions at the cell grain × the
client's lead→car conversion assumptions where a direct car count isn't provided
(fixture provides it directly; keep the field, source-flagged).

## Stage B2 — Curve service (`engine/budget_intel/curves.py`)

- `fit_logistic(points) -> {L,k,x0}` and `fit_cpl(points) -> {a,b,c}`
  (scipy `curve_fit`; bounds: L>0, k>0, 0<x0<100).
- Fit sources, in blend order:
  1. **Simulator prior** — points from `simulator_snapshots` (manual paste-in for
     CSV clients; API `campaign_simulation` pulls when Phase IV lands).
  2. **Observed** — weekly (is_share, main_conv, cpa) history per cell from the
     warehouse once ≥8 weeks with meaningful IS variation exist.
  Blend: inverse-variance weighting of predictions, weight shifting to observed
  as n grows; store as `source="blend"` with both parents in diagnostics.
- Fallback hierarchy at read time: active per-cell fit → account-level fit +
  ratio scaling (MODEL_SPEC §2) → the packaged default prior
  (`fixtures/curve_params.json`).
- Refit cadence: weekly (before the allocation run) + triggers (campaign
  restructure detected, >30% budget shift, manual). Never delete old fits —
  `active` flag flips; history is the calibration record.
- **Manual snapshot entry:** endpoint + minimal UI form to paste budget-simulator
  points (IS %, spend/week, conv/week rows) for CSV-mode clients; staleness =
  `taken_at` age, warn at 35 days (monthly cadence; weekly for large accounts —
  threshold in client config).

## Stage B3 — Scores, allocator, recommendations (`engine/budget_intel/allocate.py`)

Implement exactly per MODEL_SPEC §§3–6: projection surfaces (as functions, not
grids), the four score variants (constants in config), both allocator modes
(`legacy_waterfall` for the golden test; `greedy_marginal` default), expected-
metric lookups, tCPA adjustments, and the max-ROI preset (budget-free variant).

Playbook guards (hard, engine-enforced at run time):
- max weekly spend change per cell: ±30% default (client-configurable),
- spend floors/caps honored, protected campaigns/cells excluded from decreases,
- a run whose total reallocation exceeds N% of budget requires `senior` role to
  finalize (integrates with ROADMAP_V2 Phase II roles; until roles exist, gate on
  a `confirm=true` flag and log).

Finalizing a run emits one recommendation object per changed cell into the
recommendation store (Phase II lifecycle when present; before that, persist in
`allocation_results` with `status=final` — the work queue picks them up later).

## Stage B4 — API + UI

Endpoints (FastAPI, follow `backend/main.py` conventions):
```
GET/PUT /api/clients/{id}/mappings            # incl. GET /unmapped
GET/PUT /api/clients/{id}/business-metrics
POST    /api/clients/{id}/simulator-snapshots
GET     /api/clients/{id}/curves              # active fits + diagnostics
POST    /api/clients/{id}/allocation-runs     # {goal, budget, mode} -> run + results
GET     /api/clients/{id}/allocation-runs/{run_id}
POST    /api/clients/{id}/allocation-runs/{run_id}/finalize
```

UI — one new module "Budget Intelligence" (exception to the no-new-views freeze;
follow existing module/nav patterns in `frontend/`):
1. **Run panel:** goal selector, weekly budget input, mode, run button; re-run
   on budget change is live (runs are cheap).
2. **Results table** = the workbook's Recommendation sheet: per cell — score,
   expected vs LW spend/IS/CPA/cars (+ diffs), tCPA current → recommended;
   region and account totals; export to CSV.
3. **Curve chart** per cell: spend vs cars and spend vs GP (adroi), current
   point and recommended point marked, cap (max-ROI spend) flagged.
4. **Setup tab:** mapping editor with unmapped alerts, business-metrics editor,
   simulator snapshot paste-in with staleness badges.

## Stage B5 — Calibration (with Phase III outcome loop)

Per finalized run, per cell: store predicted (is, cpa, cars); on next period's
data arrival compute actuals deltas; expose `GET .../calibration` (predicted vs
actual history) and show error bands in the UI once ≥4 observations exist. Track
simulator-vs-actual separately (Google's optimism is measurable and demo-worthy).

---

## Acceptance criteria

1. **Golden test passes** (MODEL_SPEC §7): full reproduction of the fixture
   workbook's projections, scores, waterfall passes, and recommendation table
   from `fixtures/` inputs, in `legacy_waterfall` mode. This is a pytest module
   (`tests/test_budget_intel_golden.py`) run in CI, not a one-off script.
2. `greedy_marginal` passes invariants: budget exhausted (± floors), caps/floors
   respected, no cell decreased below floor, allocation monotone in budget.
3. Unmapped campaigns block a run with an actionable error listing them.
4. A CSV-mode client with pasted simulator points and business metrics can run
   end-to-end (no API dependency anywhere in this module).
5. Run → finalize → results persisted, attributed (created_by), and re-readable;
   guard violations impossible via API (server-side enforcement, tested).
6. All new tables carry `client_id` isolation; queries filter by it (tested with
   two seeded clients).
7. SQLite and Postgres both pass the suite (matching existing dual-dialect CI
   posture).

## Build order & dependencies

B1 → B2 → B3 → B4, B5 hooks land with B3/B4 (calibration read path can trail).
No dependency on Google API access anywhere in B1–B5 (API simulator pulls are a
Phase IV enhancement that writes into `simulator_snapshots` with `source="api"`).
If ROADMAP_V2 Phase I/II (auth, lifecycle) aren't merged yet, build against the
`created_by`-string + `confirm` flag fallbacks noted above; do not invent a
parallel auth or approval system.
