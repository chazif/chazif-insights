# React Migration Plan — `frontend/` → `frontend-next/`

> **Status:** approved direction (stack: React + TypeScript; housing: parallel folder on `main`). This is the execution plan.
> **Prime directive: the current app keeps working, untouched, until the cutover gate passes.**

## 0. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Framework | **React 18 + TypeScript** | Largest talent pool by far; industry standard; first-class auth-provider components (Clerk et al.); huge table/chart ecosystem. (Svelte rejected: small talent pool. Angular rejected: heavier, declining mindshare. "TypeScript vs React" was a false choice — TS is used *with* React.) |
| Housing | **Parallel folder `frontend-next/` on `main`** | The old app stays untouched and deployable at all times; the new app lands in small, always-in-sync PRs. A long-lived branch would drift from `main` (the current frontend got 5 PRs in one week) and end in a risky mega-merge. |
| Build tool | **Vite** | Fast dev server, hashed static output, trivial to serve from FastAPI. |
| **No Next.js / SSR** | Deliberate | This is a dashboard behind a login — SEO is irrelevant, and a static SPA keeps the Railway single-service deployment exactly as it is today. |

## 1. Guiding principles

1. **The API is the contract — and it doesn't change.** The React app consumes the same endpoints (`/api/bundle`, `/api/clients`, `/api/upload`, `/budget-intel/*`, …). Zero backend changes are required to start. `DOCUMENTATION.md` §3 (bundle keys) becomes the TypeScript type definitions.
2. **Strangler, not big-bang.** The new app grows view-by-view at its own route while the old one serves users. Cutover is a routing flip, and instantly reversible.
3. **Parity first, redesign later.** The new views pixel-match the current look (same CSS variables, same layouts). A visual refresh is a separate, later decision — parity keeps every migrated view trivially verifiable ("does it match the old one on the same client?").
4. **One-way feature valve.** Once the new shell exists: **new features land only in `frontend-next/`; the old `frontend/` gets bug fixes only.** Otherwise everything is built twice.
5. **Auth lands in the new app.** The AUTH_PLAN's login/admin/user-management surface is built directly in React (Clerk's drop-in components), not retrofitted into the vanilla app. One effort, two goals.

## 2. Target architecture

```
frontend-next/
  src/
    api/          typed fetch layer: bundle.ts, clients.ts, upload.ts, budgetIntel.ts
    types/        bundle.ts — the DATA-bundle contract as TS types (from DOCUMENTATION.md §3)
    components/   Panel, StatCard, DataTable (sortable + sticky Total row), Toast,
                  DateRangePicker (granularity-aware), FilterBar, NavSidebar, Chart wrappers
    views/        one file per tab (overview.tsx, trends.tsx, …, budgetIntel.tsx)
    app/          router, layout shell, client-switcher, session/auth
  vite.config.ts  dev proxy: /api → localhost:8000
```

- **Server state:** TanStack Query (fetch/cache `/api/bundle` per client+filters — replaces the hand-rolled in-place refresh; the backend bundle cache still does the heavy lifting).
- **Tables:** TanStack Table — sorting, and the auto **Total row** (summing additive columns, blanking rate columns) becomes a *feature of one `DataTable` component* instead of the `totals.js` MutationObserver engine.
- **Charts:** keep **Chart.js** via `react-chartjs-2` for the migration (identical rendering = easy parity). Consider Recharts only post-cutover.
- **Styling:** port the existing CSS custom properties (`--lime`, `--panel`, `--hairline`, …) 1:1; plain CSS/CSS-modules. The app should be visually indistinguishable view-for-view.
- **Routing:** React Router; URL params mirror today's (`?client=…&from=…&seg=…`) so links stay shareable and the backend cache keys stay hot.

**Serving:** FastAPI mounts `frontend-next/dist` at **`/next`** (old app stays at `/`). Dev: `vite dev` proxies `/api` to the local backend. Railway build gains one step (`npm ci && npm run build` via Nixpacks) — the deploy shape is otherwise unchanged.

## 3. Phases

**Phase 0 — Scaffold (days).** `frontend-next/` with Vite + React + TS + ESLint/Prettier; the `/next` mount; CI check that it builds; the bundle contract typed in `types/bundle.ts`. *Deliverable: `/next` renders a hello page against real `/api/clients`.*

**Phase 1 — App shell (≈1 week).** Layout (sidebar, topbar, footer), client switcher, global filter bar, granularity-aware date-range picker + VS compare, bundle fetch layer with the no-data toast, nav built from `meta.views`. *Deliverable: the chrome works end-to-end with an empty content pane.*

**Phase 2 — First vertical slice: Overview (≈1 week).** Stat cards, dual-axis trend chart, KPI scorecard, findings. Proves charts, tables, formatting (`fmt` helpers), comparison labels. *Deliverable: Overview at `/next` is indistinguishable from Overview at `/` for the same client — this slice sets the parity bar and builds the reusable components everything else uses.*

**Phase 3 — View migration, module by module (bulk of the work).** Order (simplest → hairiest, reusing components as they harden):
1. Business: Trends, NB Categories, Regions
2. Campaign + Budget: Campaign Perf, Budget, Pacing, Budget Input, **Budget Intelligence**
3. Keyword: Deep Dive (heatmap), QS Overview (incl. trend), QS Breakdown (27-grid), Region & Category
4. Search Terms (4 tabs), Ad Copy + Ad↔LP pairing, Landing Pages, Geo, Competition, Recommendations (+ evidence modal)
5. Admin: Clients, Upload (single + MCC mapping flow + job polling + gzip), Inventory, Business Context

Each view ships as its own small PR with a parity check against the old app on a real client. *(Estimate: ~2–5 days per module group.)*

**Phase 4 — Auth (from AUTH_PLAN).** Clerk integration in the React app: real sign-in replaces the demo gate, org/user management UI, the add-user checklist. Backend enforcement per AUTH_PLAN §4 (independent of the frontend swap, but the UI half lands here.)

**Phase 5 — Cutover.**
- **Gate (all must pass):** every view in `meta.views` migrated; parity checklist signed off per view (same client, same numbers); upload + MCC + Budget Intelligence flows exercised end-to-end; Playwright smoke suite green against both apps; team has used `/next` as their daily driver for ≥1 week.
- **Flip:** serve the React build at `/`; keep the old app at `/legacy` for a 2–4-week grace period; then delete `frontend/` (git history keeps it forever).
- **Rollback:** re-flip the mount — one-line change.

## 4. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Double-maintenance window drags on | The one-way feature valve (§1.4) + migrating highest-churn views early |
| Hidden behaviors in 7k lines of vanilla JS | `DOCUMENTATION.md` §14 catalogs the views; parity checklist per view; grep the old renderer while porting each view |
| Bundle contract drift during migration | The contract is typed in `types/bundle.ts`; backend changes to the bundle must update the types in the same PR |
| Chart visual drift | Same Chart.js engine via react-chartjs-2 until after cutover |
| Build step surprises on Railway | Phase 0 proves the deploy pipeline before any view work begins |

## 5. Effort & sequencing summary

Phases 0–2 ≈ **2–3 weeks** to a convincing, parity-true Overview. Phase 3 is the long tail — **4–8 weeks** depending on pace/parallelism. Auth (Phase 4) overlaps Phase 3. Realistic total: **~2–3 months part-time to full cutover**, with the old app fully functional throughout and every increment shippable.

First concrete step when ready: **Phase 0 scaffold PR** (`frontend-next/` + `/next` mount + typed bundle contract).
