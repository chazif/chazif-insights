# SearchNex Ads — Roadmap V2: From Analyst Console to Operator Platform

**North star:** prove the software lets a junior employee operate at the level of a
Director of Performance Marketing. Not "beat Google's automation" — that's a claim
about software. This is a claim about unit economics: junior salaries, director
output, measured and provable.

**Status baseline (July 2026, ~128 commits):** production-grade CSV/MCC ingestion
(streaming, gzip, background jobs, per-client split), deterministic analyzers,
budget module with pacing + reconciliation, ~20 read-only console views,
multi-client admin. What exists is an excellent **analyst console**. What the north
star requires is an **operator system**: decide → act safely → measure → explain.
None of those four verbs is supported yet.

---

## 1. Operating principle: one spine, two edges

Clients come in two flavors and the platform must serve both:

| | API clients | CSV clients |
|---|---|---|
| Data in | Google Ads API pulls (daily, ID-keyed) | CSV / MCC export uploads (as-of-upload) |
| Actions out | Two-way API writes (staged, guarded) | Recommendations + Editor bulk sheets, applied by a human |

**Design rule:** everything between the edges — warehouse, analyzers, playbooks,
recommendation lifecycle, work queue, outcome tracking, audit log — is identical for
both modes and never knows which mode it's in. Mode exists only in two adapter seams:

- **Ingestion seam:** `CsvUpload` (exists) | `GoogleAdsApi` (Phase IV).
- **Activation seam:** `Manual` (recs only) | `EditorExport` (bulk sheets) | `ApiWrite`.

If an analyzer or the queue ever contains `if client.mode == "csv"`, the design has
failed. Analyzers declare **data requirements** (reports, grain, freshness) and
degrade gracefully — the same pattern already used for missing reports.

**Client capabilities are two axes, not one mode** (in `clients.config`):

```json
{ "data_source": "csv | api_oauth | api_mcc",
  "activation":  "manual | editor_export | api_write" }
```

**Three ways to connect** (data_source sub-types; ingestion is the only seam that
knows which):

- `csv` — report uploads. Zero permissions needed. The wedge and the fallback.
- `api_oauth` — the **"Connect your Google Ads" button**: client (or any user with
  access to their account, even read-only) completes Google's OAuth consent; we
  store the refresh token; calls use our developer token + their grant. No MCC
  link, no client-side setup. Access mirrors the connecting user's permission
  level — read-only connects are a trust-building feature ("we can see, never
  touch") and a demo-call sales wedge.
- `api_mcc` — client accepts a link from our manager account. Deepest integration,
  for managed clients; write access rides on this (or on an admin-level OAuth grant).

OAuth notes: register the OAuth client + consent screen in GCP early (Google
reviews apps requesting the Ads scope — lead-time item, file with the dev token).
Refresh tokens are crown jewels: encrypted at rest, secret manager, never in logs.
Grants die silently (user leaves client company, password resets) — ingestion runs
token-health checks and emits a "reconnect needed" work-queue item, never a silent
data gap.

The in-between states are real: read-only API access without write trust; API data
with Editor-sheet application during a trust ramp. The upgrade ladder
`csv/manual → api_oauth read-only → api_mcc/editor_export → api_mcc/api_write` is
also the sales motion — each rung is an expansion conversation. Dual mode is also
the hedge: if Google API access is slow, restricted, or revoked, the business
degrades to CSV + Editor — slower, alive.

---

## 2. The gaps (dependency order)

1. **Identity & accountability** — no auth, users, roles, or audit trail. Every
   operator feature downstream depends on "who did what, when."
2. **Decision workflow** — recommendations are static display cards
   (`frontend/app.js::renderRecs`). No lifecycle, queue, assignment, or escalation.
3. **Execution** — zero Google Ads connectivity. Approved actions die in the UI;
   the junior applies changes by hand, unguarded — exactly the risk surface the
   product is supposed to remove.
4. **Encoded judgment** — thresholds live in analyzer code; no per-client playbooks
   (protected terms, never-touch campaigns, change caps); rationales are one-liners,
   not teaching material.
5. **Outcome measurement** — nothing records what happened after a recommendation.
   No proof of director-equivalence, no operator metrics, no learning corpus.
6. **Data-foundation debts** — entities keyed by name not ID; no conversion-tracking
   health check (waste recs on possibly-broken conversion data can actively harm
   accounts); DeepSeek is the priority LLM provider in `engine/llm/relevance.py`
   (client search terms can contain PII — route Anthropic-first).

**Standing order: no new console views until Phase III ships.** The console is two
phases ahead of the spine.

---

## 3. Phase I — Foundation (1–2 weeks)

Accountability, safety of the math, and the one external dependency.

- **Auth & roles.** Email + password sessions. Two roles: `operator`, `senior`
  (senior = admin). Server-side enforcement on every mutating endpoint.
- **Audit log.** Append-only `actions_log` (id, ts, user_id, client_id, action,
  object_type, object_id, payload JSON). Every state change writes a row. This
  table is permanent — Phase IV's API writes and the decision-audit metrics all
  read from it.
- **Entities table** (pulled forward from Phase IV — build before more data accrues):
  `entities(client_id, entity_type, resource_id NULL, name_normalized, first_seen,
  last_seen)`. CSV rows resolve by normalized name; API rows (later) resolve by
  resource ID; a one-time reconciliation matches name→ID when a client upgrades, so
  history survives the transition. New ingests upsert into it.
- **Conversion-health analyzer.** Before any waste/negative recommendation cites
  "zero conversions": check conversion density per campaign vs account norm, flag
  suspected tracking gaps (all-zero campaigns, sudden conversion cliffs, value
  without count). Recommendations built on suspect data are suppressed or hard-
  caveated. *This is a correctness prerequisite for Module #1's core claim, not a
  nice-to-have.*
- **LLM routing fix.** Anthropic-first in `relevance.py`; DeepSeek only by explicit
  opt-in. One line. Do it first.
- **File the Google Ads API developer-token application** and **register the GCP
  OAuth client + consent screen** (Ads scope requires Google review). The two
  critical-path items outside our control; Phase IV is gated on them. This week.

**Milestone:** every mutation attributable to a person; no recommendation can cite
conversion data the system hasn't sanity-checked.

---

## 4. Phase II — The operator surface (2–3 weeks)

The heart of the pivot: findings become work.

- **Recommendation lifecycle** (Postgres, replaces static cards):
  `new → assigned → approved | rejected(reason) | snoozed(until) | escalated(note)
  → applied(claimed) → verified | failed_verification`. Persisted per client, with
  assignee, timestamps, actor on every transition (via `actions_log`).
- **Work queue as the landing view.** Ranked by dollar impact. Each card: the
  recommendation, expandable evidence (the "see data" payload already produced by
  `_to_recommendations`), the *teachable rationale* (below), freshness stamp, and
  four buttons — approve / reject-with-reason / snooze / **escalate to senior with
  required note**. Escalation is what makes a 1-senior : 8-junior ratio real.
- **Playbooks** (per-client config, enforced by the engine, editable by `senior`
  only): protected brand terms and campaigns (can never become a negative-keyword
  rec at all), max changes per run, CPA/ROAS thresholds by category, budget floors.
  The engine applies playbooks at *generation* time — dangerous recommendations are
  never created, not merely flagged.
- **Teachable rationales.** Every recommendation carries: what a director would
  check before acting, why the thresholds are what they are, and what to watch
  after. The card is simultaneously the task and the training. This is the
  "director in the box" layer — treat rationale templates as first-class content,
  versioned with the playbooks.
- **Freshness rules.** Every recommendation displays its data window. Past a
  staleness threshold (config, default 21 days) actionable items grey out and the
  queue's top action becomes "request new export." Acting on stale data is
  director-level malpractice; the system must know that so the junior doesn't have to.

**Milestone:** a junior logs in, sees today's ranked queue for their clients,
decides each item with evidence in front of them, and can't touch anything a
playbook protects. Works identically for CSV and (future) API clients.

---

## 5. Phase III — Close the action loop, no Google approval needed (1–2 weeks)

- **Editor bulk-sheet export.** Approved actions export as Google Ads Editor CSVs
  (negatives first: shared/campaign/ad-group level; then pause/add keyword). The
  junior downloads, applies via Editor in minutes, marks the batch applied. Decision
  record, applier, and timestamp all captured. For CSV-mode clients this is the
  *permanent* activation channel, not a stopgap.
- **Outcome snapshots.** On `applied`: store the entity's trailing-30-day metrics.
  Re-measure at next data arrival — API clients (later) at +14/+30 days
  automatically; CSV clients on next upload. Store as as-of comparisons so both
  cadences feed the same tables.
- **Upload-based verification (CSV mode's killer feature).** Each new upload checks
  pending `applied` actions: negated term's traffic stopped, or the negative appears
  in the keyword report → auto-flip to `verified`. Still spending weeks after
  approval → `failed_verification`, flagged to senior ("approved on the 3rd, still
  spending on the 28th"). Converts manual mode from recommendations-into-the-void
  into a closed, accountable loop — and doubles as the junior-accountability check.

**Milestone:** approve → export → apply → verified-in-data, end to end, on a real
CSV client. The platform now measurably changes accounts.

---

## 6. Phase IV — API ingestion + guarded writes (build ~3–4 weeks; gated on token)

- **Read path first.** Daily-grain pulls keyed by resource IDs into the same
  warehouse; entities table reconciles name-history → IDs. Build the Layer 2 fact
  table here (`metrics_daily`, partitioned by month) — the schema is open anyway,
  and it's the scaling answer for large clients (2GB/month CSV clients included:
  facts are ~5–10× smaller than raw).
- **"Connect your Google Ads" OAuth flow** (`api_oauth`): consent redirect, refresh
  token storage (encrypted, secret manager), token-health checks in every scheduled
  pull, reconnect work-queue items on failure. MCC link flow (`api_mcc`) is
  organizational, not code — but the ingest scheduler must handle both grant types.
- **Simulation pulls.** For every API-connected account: `campaign_simulation`
  (BUDGET and TARGET_CPA types) — the same points the UI's budget-simulator popup
  renders, unexportable from the UI but first-class in the API. Weekly snapshot per
  campaign, stored forever (curve history is fitting data). Feeds Module 2.
- **Write path, negatives first** (lowest blast radius): staged-change queue →
  senior approval required for a client's first N runs → hard caps enforced in code
  at execution time (not in the prompt, not in the UI) → post-write read-back
  verification → one-click rollback. All writes flow through the *same* lifecycle
  as Editor exports — `api_write` is just a third activation adapter.
- **Trust ramp per client:** start every API client at `editor_export`, graduate to
  `api_write` after M verified batches. The ramp is config, visible, and part of
  the client-facing trust story.

**Milestone:** first supervised, approved, capped, reversible API write to a real
account — logged end to end.

---

## 7. Phase V — Prove it (starts with Phase III, permanent)

The metrics dashboard that *is* the thesis. All computed from `actions_log` +
outcome snapshots:

- **Accounts per operator** (target: 8–10 junior-run accounts per senior).
- **Revenue per employee** (the number an acquirer reads first; target $400k+).
- **Time-to-competence:** weeks until a new hire runs accounts unsupervised.
- **Guardrail catches** vs mistakes that reached a live account (incident rate).
- **Outcome deltas** on applied actions (waste removed, CPA before/after).
- **Decision-audit agreement rate:** senior blind-reviews a weekly sample of
  junior+system decisions; agreement % is the director-equivalence score. Hold
  ≥90% for a quarter with operators hired after the system existed → thesis proven.

These metrics are the evidence base for **every** business direction — agency
margins, a tech-first-agency sale (margin that survives the founders), or a future
SaaS ("make your juniors perform like directors").

---

## 8. Module 2 — Budget Intelligence (the DRM model as a feature)

Productizes the "DRM — Revenue & AdROI" workbook (V5.2, proven on Mavis): business
outcomes (Revenue/Car, GP%) tied to Google Ads levers via impression-share response
curves, ending in goal-driven budget allocation (Car Count vs Max ROI) and tCPA
adjustments. Runs on the Phase II lifecycle — its outputs are recommendation
objects, not a separate approval flow.

**Pipeline (as reverse-engineered from the workbook):** campaign + bid-strategy
data, joined via campaign mapping to Brand × Region × Category → response curves
(logistic Leads(IS), quadratic CPL(IS)) → six projection surfaces per category
(leads, CPL, spend, conversions, revenue, AdROI at every IS) → opportunity scores →
budget waterfall with per-category profit-max caps and min-spend floors → weekly
recommendation: spend moves + tCPA adjustments with expected outcomes.

**Stages:**

- **B1 — Data foundation (~1 wk, can start after Phase I).** `campaign_mappings`
  table + admin UI with unmapped-campaign alerts on every ingest; `business_metrics`
  (client, period, category, revenue_per_conv, gp_pct); ingest campaign-level
  search IS / lost-to-budget / lost-to-rank and bid-strategy (tCPA) reports. The
  workbook's Actuals sheet becomes a materialized join.
- **B2 — Curve service (~1–2 wk).** `engine/budget_intel/`: logistic + CPL fits on
  our end. **Simulator data is an input (a prior), never the model.** Fallback
  hierarchy: per-category fit where history supports it → account-level fit scaled
  by ratios (the workbook's method) → conservative default priors. Params
  versioned per client with fit diagnostics (R², window). **Golden test: reproduce
  the V5.2 workbook's Mavis Feb-22 outputs from the same inputs before shipping.**
- **B3 — Allocator (~1 wk, after Phase II).** Opportunity scores (variant weights
  as config), then **greedy marginal allocation**: next $ to the category with the
  best marginal goal-metric on its curve, subject to profit-max caps, min-spend
  floors, and playbook limits (max ±X%/week per category — non-negotiable default;
  budget moves are higher blast radius than negatives). Goals: Car Count | Max ROI
  | target CPA. Output: persisted `allocation_run` emitting lifecycle
  recommendations ("move NB BRAKES/ARIZONA $6,429 → $4,263/wk, tCPA $16 → $17.34;
  expected −18 cars, +$2,100 GP") with evidence attached.
- **B4 — UI (~1 wk; the exception to the no-new-views rule).** Goal selector,
  budget input with live re-allocation, the recommendation table (expected vs LW,
  deltas, tCPA adjustments), and per-category curve charts — spend vs conversions
  and spend vs GP with current + recommended points marked.
- **B5 — Calibration loop (ongoing, nearly free).** Log predicted vs actual per
  category per week — for our curves AND for Google's simulator points. Drift
  triggers refits; calibration history shows in the UI and becomes error bars on
  expected values.

**Cadence policy (three separate clocks):**

| Clock | API clients | CSV clients |
|---|---|---|
| Performance pulls | daily | per upload |
| Simulator snapshots | weekly (pre-allocation) | manual paste-in: monthly, weekly for large accounts; staleness-tracked with refresh reminders in the work queue |
| Refit + allocation run | weekly, plus triggers (restructure, >30% budget shift, seasonal window) | weekly on fresh data, else flagged stale |

Curve blending: thin history → simulator prior dominates; as weekly observations
accumulate (reallocations generate natural experiments), observed data takes over.
Known model debts, surfaced in UI as caveats: constant cost-per-car assumption
overstates conversions at large spend increases (greedy-marginal allocation
softens this); single master curve scaled by ratios until per-category fits mature.

---

## 9. Risks & standing debts

- **Google token approval** — outside our control; applied in Phase I; everything
  through Phase III ships without it. Standard-access RMF requirements apply when
  scaling: review before building Phase IV UI.
- **Name-keyed history** — mitigated by the entities table (Phase I); the true fix
  completes when API IDs land (Phase IV). Until then, campaign renames on CSV
  clients fragment history — known, accepted, logged.
- **Sparse-data false positives** — thresholds are ported audit heuristics. The
  outcome loop (Phase III) is the calibration mechanism: track rec-type hit rates
  and tighten thresholds from evidence. Until then, conversion-health gating
  (Phase I) is the guard.
- **Data processing** — Anthropic-first routing (Phase I). Before any cross-client
  benchmarking feature: client consent language in contracts. Don't build the
  benchmark until the consent exists.
- **Scope discipline** — no new console views until Phase III; no Module #2
  (budget activation) until Module #1 closes the loop end to end.

---

## 10. Sequence at a glance

| Phase | Duration | Gate | Output |
|---|---|---|---|
| I — Foundation | 1–2 wk | none | auth, audit log, entities, conversion-health, token + OAuth filed |
| II — Operator surface | 2–3 wk | I | work queue, lifecycle, playbooks, rationales, freshness |
| III — Action loop | 1–2 wk | II | Editor exports, outcome snapshots, upload verification |
| B1–B2 — Budget Intel data + curves | 2–3 wk | I (parallel w/ III) | mappings, business metrics, curve service, golden test |
| IV — API + writes | 3–4 wk build | token + III | ID-keyed ingest, Layer 2 facts, OAuth connect, simulations, guarded writes |
| B3–B5 — Budget Intel allocator + UI | 2 wk | II + B2 | allocation runs → lifecycle recs, curve UI, calibration loop |
| V — Prove it | ongoing | III | operator metrics, decision audits, the evidence base |

Phases I–III need nothing from Google and put a junior usefully inside the system
in ~a month. Phase IV upgrades their hands. Phases I–III build their judgment
harness — and the harness, not the API, is what makes a junior perform like a
director.
