# Build Plan — SearchNex Redesign (React + TypeScript) + Data-Ingestion Changes

> **Status:** proposal for review. Combines three approved directions into one execution plan:
> 1. The **UI/UX redesign** from the design handoff (`SearchNex UIUX deep dive 2.zip` — report browser → decision system)
> 2. The **React + TypeScript migration** (supersedes the parity-first `REACT_MIGRATION_PLAN.md` — the redesign is now the target, so pixel-parity with the old UI is no longer the goal; the handoff's designs are)
> 3. The **data-ingestion changes**: merge-by-window append/overwrite + the Quality Score as-of logic
>
> **Working mode (per direction): a dedicated branch, not `main`. The current app stays untouched. The branch deploys to a new Railway environment.**

---

## 0. What the design handoff actually asks for (read this first)

The handoff is not a reskin. Three structural changes:

1. **The app opens on work, not data** — a **Brief** screen (decisions waiting + money at stake), an **Actions queue** where every recommendation has a lifecycle (`open → staged → applied → verified`) with owner/effort/confidence, and an **Action detail** with a methodology trail and a concrete, reversible **change set** (downloadable as Google Ads Editor CSV).
2. **Evidence comes to you** — a right-side **evidence drawer** opens over any screen with the rows behind any number, bidirectionally linked (row → why flagged; action → show me the rows).
3. **The product remembers** — a **Ledger** records predicted vs actual per applied change, with verdicts (beat/on/under forecast, reverted). This is what makes the methodology auditable and, over time, calibrates confidence labels.

All 28 existing views survive, re-parented into a three-layer nav (**TODAY / DIAGNOSE / PLAN / PROVE / SETUP**), with renames (e.g. Budget Intelligence → **Budget Allocation**, QS Breakdown → **Quality Score by Component**, Flagged → **Triage**). Eleven screens are fully specified (high fidelity, tokens + typography documented, `tokens.ts` ready to import); the rest inherit the patterns via a placeholder spec.

**Why this is the right plan for us:** the Actions queue *is* ROADMAP_V2 Phase II (recommendation lifecycle + work queue), the Ledger *is* Phase V (outcome tracking), and the audit/actions-log underpinnings are Phase I. The design gives those phases a concrete surface. We are not adding scope — we are sequencing scope we already committed to.

**Handoff notes:**
- Screenshots **01–03 are identical duplicates** (a packaging glitch — all three show the palette over Client View). The prototype HTML + README are declared the source of truth, so not blocking — but request re-exports of Brief / Actions / Action-detail from the reviewer.
- Build the **Original Colors** prototype; `alt-palette/` is reference only.
- The prototype is a spec, not production code — we recreate it in React/TS with our libraries.
- **Step 0 of the branch: vendor the handoff into the repo** (`docs/design-handoff/`) so the spec is versioned with the code.

---

## 1. Repo & hosting strategy (per your direction)

- **Branch:** `redesign` off `main`. All redesign work (frontend + new backend surfaces) lands there in small PRs targeting `redesign`, not `main`.
- **Drift control (the price of a long-lived branch):** `main` is merged **into `redesign` weekly, minimum** — and immediately after any `main` hotfix. This is non-negotiable discipline; it's what keeps the eventual merge boring.
- **Railway:** create a **new environment** (e.g. `redesign`) whose service deploys the `redesign` branch:
  - **Own Postgres** instance in that environment (seeded by a one-time dump/restore of production `clients`/`uploads`/`term_relevance`/`bi_*`).
  - **Own BigQuery dataset** (`searchnex_analytics_redesign`) seeded with the existing `engine.warehouse.migrate` tooling from a prod export — so ingestion changes can be tested with real writes, zero risk to production data. Env vars: same `GCP_PROJECT`, new `BQ_DATASET`, `USE_BIGQUERY=1`.
  - Cost is trivial at our scale (a second small Postgres + a few GB of BQ storage).
- **What ships to `main` anyway (see §2):** the data-loss ingestion fix and the totals-row fixes. These protect the *current live app* and can't wait for the redesign cutover. The branch inherits them via the weekly merge.

---

## 2. Workstream M — fixes that go to `main` now (current app)

### M1. Ingestion: merge-by-window (the data-loss fix) — *urgent*
As planned in the ingestion discussion:
- **Dated reports:** replace only the upload's coverage window (`DELETE … WHERE date_norm BETWEEN window_start AND window_end`, from the export's declared range, falling back to observed min/max), then insert. History outside the window accumulates. Idempotent. NULL-dated legacy snapshot rows for that report are superseded (deleted) when dated data arrives.
- **Dateless snapshots:** keep full snapshot-replace (still correct).
- **Quality Score:** history is already append-only/frozen (nothing was lost there). Refinement: exports with **historical QS columns** keep per-row dates; **current-QS-only** exports stamp **one point per keyword at the pull date** (not fanned across day-rows, not window_end) — because Google reports today's QS regardless of the selected range.
- **Ledger/inventory:** `uploads` becomes an immutable load history; coverage is computed from the data (min/max `date_norm` + gap check).
- **Phase 0 recovery:** if the wiping upload is within BigQuery's 7-day time travel, restore the deleted rows first.

### M2. Totals-row fixes (the handoff's explicit pre-condition)
The reviewer found real bugs in the current app that must not ship into the new stack:
- **Double totals:** views that render their own Total row (e.g. QS detail) *also* get the auto `totals.js` footer, which sums the tbody **including the existing Total row** — two totals disagreeing by exactly 2×. Fix: detect/skip existing total rows (or mark those tables `no-total`).
- **Nonsense sums on Auction Insights:** `RATE_RE` misses bare "Overlap" and "Outranking" headers, so percentage columns sum to garbage. Fix the exclusion list; adopt the handoff's rule — *counts and currency sum; rates are weighted averages; non-aggregatable columns render blank; exactly one totals row.*

*(M1 ≈ 3–5 days incl. tests + recovery; M2 ≈ 1 day.)*

---

## 3. Workstream A — platform foundation (branch, week 1)

1. Branch `redesign`; vendor the design handoff into `docs/design-handoff/`.
2. Scaffold `frontend-next/`: **Vite + React 18 + TypeScript + Tailwind** (mapped to `tokens.ts`), ESLint/Prettier, self-hosted **Instrument Sans / Instrument Serif / JetBrains Mono**.
3. Libraries per the handoff (all boring, all chosen to delete work): **TanStack Table** (sticky headers, virtualization — the keyword table is 11k rows, column chooser, CSV export), **TanStack Query** (server state, optimistic updates + undo), **React Router** (URL per view/action/drawer state — the current app's biggest workflow tax), **cmdk** (⌘K palette), **Recharts** (sparklines; visx later only if response-curve charts demand it).
4. Serve the built SPA from the same FastAPI service (static mount) in the `redesign` environment; Vite dev proxies `/api`.
5. CI: typecheck + build + backend tests on every branch PR.

## 4. Workstream B — design system & app shell (weeks 1–3)

Build the primitives the handoff says every screen is made of, in this order:
1. **`DataTable`** — with the aggregation rule (`sum | weightedAvg | none` declared per column) baked in so no view *can* produce a nonsense total; sticky header, virtualization, hover `#fdfff5`, one totals row (`#f9fafb`, 2px top border).
2. **`StatCard` / `StatStrip`** — the KPI patterns (mono figures, semantic deltas: *green means better, not up*).
3. **`InlineBarCell`** — track-plus-figure cell that replaces standalone bar charts (`#374151`, flagged `#d97706`).
4. **`Pill`** (confidence/status/grade variants per spec), **`ContextBar`** (per-view filter declarations; screens with none say so), **`NavRail`** (3-layer tree, collapse/overlay behavior below 1100px, pending-work badges, exact tokens), **`EvidenceDrawer`**, **`CommandPalette`**, **`Toast`**, **skeleton loaders** matching final geometry.
5. **App shell + routing:** `/c/:clientId/:view`, `/c/:clientId/actions/:actionId`, drawer state in the URL; client switcher; the **derived-state rule** enforced from day one (every count/badge/headline derives from one filtered collection — the handoff calls out how contradictory numbers destroy trust in exactly this product).
6. **Color rules as lint-able constants:** lime = interactive only, never under white text; enforced via a tiny set of approved Tailwind classes rather than good intentions.

## 5. Workstream C — decision-system backend (weeks 2–5, parallel with B/D)

The new surfaces need data the engine doesn't persist yet. All Postgres (operational), same patterns as `bi_*`:

1. **`actions`** — persist analyzer/allocator outputs as first-class objects: stable id, client, title, summary, money + qualifier, confidence, effort, area, owner, status (`open/staged/applied/verified/failed_verification/snoozed/dismissed`), `method[]` steps each carrying an **evidence key**, `changes[]` of `{entity, field, from, to}`. Generation is deterministic and idempotent (re-running analyzers updates open actions rather than duplicating; stable ids from content hashes).
2. **Evidence endpoints** — `GET /api/clients/{id}/evidence/{key}` returning `{title, subtitle, columns, rows, footer}` straight from the warehouse (the drawer's food).
3. **Staging & change sets** — stage/snooze/dismiss/assign endpoints (append-only `audit_log` per ROADMAP Phase I); **Editor CSV export** of the staged set; Budget Allocation's "Approve & stage N moves" feeds the same change set.
4. **Ledger & verification** — on apply, stamp predictions (`bi_predictions` already models this for budget runs; generalize the shape); a verification pass at +14 days compares CPA/conv vs the pre-change baseline and posts a verdict. Confidence labels start heuristic; the Ledger calibrates them over time.
5. **Data freshness** — inventory endpoint gains `through` (max `date_norm`), a freshness state, and an **unlocks** mapping (report → which actions/screens depend on it), feeding the Data screen and Brief data-health card.

*(This is ROADMAP Phases I/II/V. The bundle keeps serving the Diagnose views unchanged — new endpoints are additive.)*

## 6. Workstream D — the eleven designed screens (weeks 3–8)

Order optimized so each screen exercises newly-built primitives:

| # | Screen | Notes |
|---|---|---|
| 1 | **Brief** | headline w/ lime highlighter, top-3 action cards, What-moved sparklines, data-health, blocking banner (unmapped campaigns) |
| 2 | **Actions queue** | tabs w/ derived counts, the table, export |
| 3 | **Action detail** | methodology w/ evidence links, change-set table, sticky decision bar, stage/snooze/dismiss + undo |
| 4 | **Campaign Performance** | KPI strip + InlineBarCell table — chart *is* the table; honest totals |
| 5 | **Search terms · Intent & Grades** | self-labeling bars replace the donut; F-grade → action call-out |
| 6 | **Keyword Deep Dive** | virtualization, QS-coverage note, campaign·ad-group per row, weakest-component column, preset chips |
| 7 | **Budget Allocation** | wraps the existing budget-intel API; adds the **Why** column (plain-language reasons from the allocator), "Approve & stage N moves" into the change set |
| 8 | **Campaign Mapping** | suggestion tinting, Accept-all, progress header — all counts derived |
| 9 | **Data** | dropzone + holdings table w/ freshness + unlocks |
| 10 | **Ledger** | predicted vs actual, verdict pills |
| 11 | **Client View** | read-only branded sheet |
| — | **Command palette + placeholder pattern** | palette searches views/actions/campaigns/keywords; placeholders keep nav honest for unported views |

## 7. Workstream E — port the remaining ~16 views (weeks 8–11)

Overview, Trends, NB Categories, Regions, QS ×2, KW Region & Category, remaining Search-terms tabs, Ad Copy ×2, LP ×2, Geo, Auction Insights, Budget/Pacing/Budget Input, admin (Upload/Inventory/Context/Clients) — into the new patterns (DataTable + drawer + context bar), highest-traffic first. These are re-compositions of existing bundle data, not new logic.

**One-way valve from the moment the shell exists:** new features build on `redesign` only; `main` gets bug fixes only (which flow into the branch via the weekly merge).

## 8. Auth (from `AUTH_PLAN.md`) — slots in here

The handoff assumes roles (Clients is "admin-only"; actions have owners/assignees; the Ledger has actors). The Clerk integration from the auth plan lands **on the `redesign` branch** once the shell exists (weeks 4–6, parallel): real sign-in replaces the demo gate, org/user management, and `owner`/`assignee`/`actor` become real users. Backend enforcement per AUTH_PLAN §4.

## 9. Cutover

**Gate:** all 28 views present (built or intentionally placeholder-free), the six designed behaviors work (routing, skeletons, table capabilities, optimistic undo, progress feedback, assignment), ingestion changes verified in the redesign environment against real uploads, team dailies on the redesign env for ≥1 week, and the derived-state rule audited (no contradictory counts anywhere).

**Flip:** merge `redesign` → `main` (kept small by the weekly merges), point the production Railway service at the new build, keep the old frontend reachable at `/legacy` for a 2–4 week grace period, then delete it. Rollback at any point = redeploy prior `main`.

---

## 10. Timeline & effort (realistic, part-parallel)

| Weeks | Work |
|---|---|
| 0–1 | M1+M2 to `main` (ingestion fix + recovery, totals fixes) · branch + Railway env + scaffold |
| 1–3 | Design system primitives + shell + routing |
| 2–5 | Decision-system backend (parallel) |
| 3–8 | The 11 designed screens |
| 4–6 | Auth on the branch (parallel) |
| 8–11 | Port remaining views |
| 11–12 | Gate, cutover, grace period |

**~3 months to full cutover**, with the current app untouched and improving (M-fixes) throughout, and the redesign environment demoable from ~week 3.

## 11. Decisions to confirm before starting

1. **M-fixes to `main` now** (ingestion merge-by-window + totals) rather than trapped in the branch — recommended strongly. ✔/✘
2. **Recovery first:** when was the history-wiping upload? (BigQuery time travel = 7 days.)
3. **Redesign environment data:** seeded copies (own PG + own BQ dataset) as specified — or point the env read-only at prod BigQuery and defer ingestion testing? *(Recommend seeded copies.)*
4. **Auth on the branch** per §8 (Clerk, per AUTH_PLAN) — confirm provider choice is final.
5. Ask the design reviewer for **re-exports of screenshots 01–03** (duplicates in the zip).
