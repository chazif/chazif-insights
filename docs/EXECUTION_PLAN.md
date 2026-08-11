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
3. Backlog items as prioritized by user (suggested next: clear-filters-on-switch as a quick win,
   then simulator UI to make Budget Allocation fully runnable).

Each item ships in the established loop: build → `tsc`/`pytest`/`npm run build` → commit/push to
`redesign` → verify live against real client data → update this doc's status line.
