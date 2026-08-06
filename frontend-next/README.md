# frontend-next — SearchNex Ads redesigned UI (React + TypeScript)

The redesigned frontend, built to the spec in `docs/design-handoff/`. It replaces the
vanilla-JS `frontend/` over the course of the redesign (see `docs/REDESIGN_BUILD_PLAN.md`).
The current app is untouched; this is developed on the `redesign` branch and deployed to a
separate Railway environment.

## Stack
Vite · React 18 · TypeScript · Tailwind (tokens from `docs/design-handoff/tokens.ts`) ·
TanStack Table / Query · React Router · cmdk · Recharts.

## Develop
```bash
cd frontend-next
npm install
npm run dev        # http://localhost:5173  (proxies /api → http://localhost:8000)
```
Run the backend separately: `py -m uvicorn backend.main:app --reload --port 8000` from the repo root.

## Build (what Railway/production runs)
```bash
npm run build      # → frontend-next/dist
```
FastAPI serves `frontend-next/dist` at **`/next`** when the build is present (see the
`/next` route in `backend/main.py`). `vite.config.ts` sets `base: "/next/"` to match.

## Notes
- **Lime (`accent`) is interactive only** — never text on light, never a fill on light, never
  behind white text. Emphasis on a figure is a lime highlighter behind ink text.
- **Green means better, not up.** Every coloured delta also carries a sign/arrow; every grade
  pill also carries a letter + word. Contrast floor is WCAG AA.
- **One totals-row rule** (baked into the shared `DataTable` when built): counts/currency sum;
  rates are weighted averages; non-aggregatable columns render blank.
