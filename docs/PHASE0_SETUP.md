# Phase 0 — Setup Checklist (Track A: your accounts)

These steps need your GitHub / Railway accounts, so they're for you to run. Once
done, the app deploys and we move to Phase 1 (ingestion). Track B (the code) is
already in this repo and verified locally.

## 1. GitHub
- [ ] Create a new **private** repo (e.g. `chazif-insights`).
- [ ] From this folder:
  ```
  git init
  git add .
  git commit -m "Phase 0: externalize DATA bundle; FastAPI shell; Mavis seam verified"
  git branch -M main
  git remote add origin git@github.com:<you>/chazif-insights.git
  git push -u origin main
  ```
  (The 20 MB Mavis bundle is git-ignored by design — regenerate it with
  `tools/split_dashboard.py`, or commit a small sample bundle if you want the
  demo to deploy without regeneration.)

## 2. Railway
- [ ] New Project → **Deploy from GitHub repo** → pick the repo. Same flow as the
      content-generation app.
- [ ] Railway auto-detects Python via Nixpacks and uses `Procfile` /
      `railway.json` to start `uvicorn backend.main:app`.
- [ ] Confirm the deploy: visit the Railway URL → `/api/health` should return
      `{"ok": true}`, and `/` should show the sign-in screen.
- [ ] **Note:** the demo bundle must be present for the dashboard to render. Either
      commit a sample `data/clients/mavis/2026-03/bundle.json` or add a build step
      that generates it. (Cleaner once the engine produces bundles in Phase 2.)

## 3. Postgres (provision now, used from Phase 1)
- [ ] In the Railway project: **Add → Database → PostgreSQL**.
- [ ] Railway injects `DATABASE_URL` into the service env automatically.
- [ ] Nothing reads it yet — Phase 1 (ingestion) creates the normalized schema
      and starts writing to it.

## 4. Secrets
- [ ] No third-party secrets required in Phase 0 (no Google API yet).
- [ ] When auth lands, add a session secret / auth provider keys as Railway
      variables — never commit them (`.env` is git-ignored).

## Definition of done for Phase 0
- App live on Railway behind the sign-in screen, rendering the Mavis bundle via
  `/api/bundle`.
- Postgres provisioned and `DATABASE_URL` available to the service.
- Repo on GitHub, auto-deploying on push.
