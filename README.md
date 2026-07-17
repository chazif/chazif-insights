# SearchNex AE — Paid-Search Intelligence Platform

An always-on web console for managing Google Ads accounts: upload the exports,
the engine analyzes them, and the app shows observations, findings, and
recommendations by domain (campaign/budget, keyword/QS, search terms, ads,
landing pages, geo). Multi-client, config-driven, one codebase that flexes from
a single-brand local account to a multi-brand/multi-region one.

See the architecture reference for the full picture; this README covers running
what exists today (**Phase 0**).

## Layout
```
backend/        FastAPI app (main.py) + zero-dep dev server (dev_server.py)
frontend/       index.html (shell + bundle loader) + app.js (views/render)
data/clients/<client>/<period>/bundle.json   render-ready DATA bundle (generated)
engine/         analyzers (Phase 2)
tools/          split_dashboard.py — externalize a single-file dashboard export
docs/           DATA_BUNDLE_SCHEMA.md, PHASE0_SETUP.md
```

## Architecture in one line
`upload → normalized store → engine → DATA bundle (JSON) + recommendations → web console`
The bundle is the contract between engine and frontend (`docs/DATA_BUNDLE_SCHEMA.md`).
The engine never hands account credentials to a model; deterministic code owns the math.

## Run locally

**Option A — zero dependencies (verifies the seam):**
```
py backend/dev_server.py
# open http://localhost:8000  (demo sign-in is prefilled)
```

**Option B — production stack (FastAPI, matches Railway):**
```
py -m venv .venv && .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

Both serve the frontend and resolve `GET /api/bundle?client=<c>&period=<p>` from
`data/clients/<c>/<p>/bundle.json`.

## Regenerate the Mavis demo bundle
The Mavis fixture is derived from the original single-file dashboard and is
git-ignored (it's large + generated). Recreate it with:
```
py tools/split_dashboard.py --src "PATH\TO\Mavis_Tire_Dashboard_March_2026.html" --client mavis --period 2026-03
```

## Deploy (Railway)
See `docs/PHASE0_SETUP.md`. `Procfile` / `railway.json` are the start config;
Railway builds from `backend/requirements.txt` via Nixpacks.

## Status — Phase 0
- [x] Externalize the embedded `DATA` into a fetched bundle (engine↔frontend seam)
- [x] Backend serves frontend + `/api/bundle`; dev + FastAPI parity
- [x] Verified end-to-end in a browser (login → fetch → render → brand re-render)
- [x] Versioned bundle schema (`docs/DATA_BUNDLE_SCHEMA.md`)
- [ ] Track A: GitHub repo + Railway service + Postgres (see PHASE0_SETUP.md)
- [ ] Real auth + client-switcher (currently a demo gate)
- [ ] Client-config + complexity-profile schema
