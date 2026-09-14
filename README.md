# SearchNex Ads — Paid-Search Intelligence Platform

An always-on web console for managing Google Ads accounts: upload the exports,
the engine analyzes them, and the app shows observations, findings, and
recommendations by domain (campaign/budget, keyword/QS, search terms, ads,
landing pages, geo). Multi-client, config-driven, one codebase that flexes from
a single-brand local account to a multi-brand/multi-region one.

See the architecture reference for the full picture; this README covers running
what exists today (**Phase 0**).

## Layout
```
backend/        FastAPI app (main.py): the JSON API, and serves the React console at /
frontend-next/  the React console (Vite + React + TypeScript), built to frontend-next/dist
engine/         ingestion, warehouse (Postgres/BigQuery), bundle assembler, analyzers
tests/          pytest suite
docs/           DATA_BUNDLE_SCHEMA.md, PHASE0_SETUP.md, specs
```
The legacy vanilla-JS app (`frontend/`) and its zero-dependency `dev_server.py` were
retired in M0-A3. The React console is the only frontend, and `/next` redirects to `/`.
The 20 MB Mavis demo fixture and its generator (`tools/split_dashboard.py`) were removed
from the repo in M0-A4. Generated bundles are never committed (`data/clients/**/bundle.json`
is git-ignored, and `tests/test_repo_hygiene.py` enforces it).

## Architecture in one line
`upload → normalized store → engine → DATA bundle (JSON) + recommendations → web console`
The bundle is the contract between engine and frontend (`docs/DATA_BUNDLE_SCHEMA.md`).
The engine never hands account credentials to a model; deterministic code owns the math.

## Run locally

```
py -m venv .venv && .venv\Scripts\activate
pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000        # API on :8000
```
Then, in a second terminal: `cd frontend-next && npm ci && npm run dev` (the console on
:5173, proxying `/api` to :8000). Or run `npm run build` in `frontend-next` once and open
http://localhost:8000, where FastAPI serves the console at `/`.

`GET /api/bundle?client=<id>` is always computed from the warehouse: there is no
default client and no pre-baked file.

Verify: `python -m pytest tests -q`, and in `frontend-next` run
`npm run typecheck && npm run build`.

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
