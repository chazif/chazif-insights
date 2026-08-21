#!/usr/bin/env python3
"""SearchNex AE — production backend (Railway target).

Serves the static frontend, the per-client DATA bundle, and the admin API
(clients, upload, inventory). SQLite locally / Postgres via DATABASE_URL.

Run locally:  py -m uvicorn backend.main:app --reload --port 8000
Railway:      Procfile -> uvicorn backend.main:app --host 0.0.0.0 --port $PORT
"""
import os
import time
import uuid
import zlib
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel

from engine.ingest import service
from engine.ingest.store import get_engine
from engine.warehouse.analytics import read_engine
from engine.bundle.assemble import build_bundle
from engine.budget.parse import parse_budget_file
from engine import mapping as campaign_mapping
from backend import budget_intel_routes
from backend.budget_intel_routes import router as budget_intel_router
from backend import decision_routes
from backend.decision_routes import router as decision_router

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CLIENTS = ROOT / "data" / "clients"
UPLOADS = ROOT / "data" / "uploads"

app = FastAPI(title="SearchNex Ads", version="0.3.0")
app.include_router(budget_intel_router)
app.include_router(decision_router)
# read_engine wraps the Postgres engine with BigQuery analytics routing once BigQuery is
# ACTIVE (config vars + USE_BIGQUERY); until cutover it returns the plain Postgres engine.
_engine = read_engine(get_engine())

# Ingestion is heavy (parse + insert of large exports). Doing it inside the request
# blocks the worker long enough that Railway's edge times the connection out with a
# 502. Instead we run it as a background job and let the UI poll for completion.
_JOBS = {}   # job_id -> {"status": processing|done|error, "result"/"error": ...}

# A fresh bundle build fans out ~40 warehouse queries (each a BigQuery job in production),
# so recomputing it on every reload / filter toggle is the main source of UI latency. Cache
# computed bundles keyed by everything that changes the result; cleared on any ingest or
# config change, and TTL-bounded as a backstop against a missed invalidation.
_BUNDLE_CACHE = {}          # key -> (expiry_epoch, computed_dict)
_BUNDLE_CACHE_TTL = 120     # seconds
_BUNDLE_CACHE_MAX = 32


def _bundle_cache_get(key):
    ent = _BUNDLE_CACHE.get(key)
    if ent and ent[0] > time.time():
        return ent[1]
    if ent:
        _BUNDLE_CACHE.pop(key, None)
    return None


def _bundle_cache_put(key, value):
    if len(_BUNDLE_CACHE) >= _BUNDLE_CACHE_MAX:      # evict the soonest-to-expire half
        for k in sorted(_BUNDLE_CACHE, key=lambda k: _BUNDLE_CACHE[k][0])[:_BUNDLE_CACHE_MAX // 2 or 1]:
            _BUNDLE_CACHE.pop(k, None)
    _BUNDLE_CACHE[key] = (time.time() + _BUNDLE_CACHE_TTL, value)


def _bundle_cache_clear():
    """Drop all cached bundles — called whenever ingest or config changes the underlying data."""
    _BUNDLE_CACHE.clear()


# A lifecycle change (accept/dismiss/…) alters the status join baked into a cached
# bundle, so wire the decision router's mutations to the same invalidation. Mapping
# edits/approvals change every view's attribution, so they invalidate too.
decision_routes.invalidate_bundle_cache = _bundle_cache_clear
budget_intel_routes.invalidate_bundle_cache = _bundle_cache_clear


def _sync_mappings(*client_ids):
    """Auto-map any campaigns that arrived in freshly ingested data (the central
    mapping engine's continuous-sync step). Fail-soft — a mapping hiccup must
    never fail an ingest."""
    for cid in {c for c in client_ids if c}:
        try:
            campaign_mapping.sync(_engine, cid, service.get_config(cid, engine=_engine) or {})
        except Exception:   # noqa: BLE001
            pass


def _run_job(job_id, fn):
    """Run a blocking ingest fn in the threadpool and record its result on the job."""
    try:
        _JOBS[job_id] = {"status": "done", "result": fn()}
        _bundle_cache_clear()                         # ingested data changed -> stale bundles
    except ValueError as e:
        _JOBS[job_id] = {"status": "error", "error": str(e)}
    except Exception as e:                       # noqa: BLE001 — surface any ingest failure
        _JOBS[job_id] = {"status": "error", "error": f"{type(e).__name__}: {e}"}
    if len(_JOBS) > 100:                          # keep the registry small
        for k in list(_JOBS)[:-50]:
            _JOBS.pop(k, None)


@app.middleware("http")
async def revalidate_assets(request: Request, call_next):
    """Make browsers revalidate HTML/JS/CSS every load so deploys/edits show up
    without a manual hard-refresh (still cached, but conditionally)."""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/health")
def health():
    backend = _engine.dialect.name  # "postgresql" or "sqlite"
    return {"ok": True, "service": "chazif-insights", "version": "0.3.0",
            "db": backend, "persistent": backend != "sqlite"}


# ---- clients -------------------------------------------------------------
class ClientCreate(BaseModel):
    name: str
    client_id: Optional[str] = None
    google_customer_id: Optional[str] = None      # Google Ads CID (digits) — enables API auto-pull
    mcc_id: Optional[str] = None


@app.get("/api/clients")
def clients_list():
    return service.list_clients(engine=_engine)


@app.post("/api/clients", status_code=201)
def clients_create(body: ClientCreate):
    try:
        return service.create_client(body.name, client_id=body.client_id, engine=_engine,
                                     google_customer_id=body.google_customer_id, mcc_id=body.mcc_id)
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.get("/api/clients/{client_id}/config")
def client_config_get(client_id: str):
    cfg = service.get_config(client_id, engine=_engine)
    if cfg is None:
        raise HTTPException(404, f"unknown client '{client_id}'")
    return cfg


@app.put("/api/clients/{client_id}/config")
def client_config_put(client_id: str, body: dict):
    try:
        result = service.update_config(client_id, body, engine=_engine)
        _bundle_cache_clear()                         # config (brand terms, budgets…) changes the bundle
        return result
    except ValueError as e:
        raise HTTPException(404, str(e))


@app.post("/api/clients/{client_id}/budget")
async def client_budget_upload(client_id: str, file: UploadFile = File(...),
                               period: str = Form("monthly"), window_months: int = Form(12)):
    """Parse an uploaded budget file (Brand/Region/Category × amount) into monthly
    budget_lines and save them on the client config. Returns the parsed summary."""
    if service.get_config(client_id, engine=_engine) is None:
        raise HTTPException(404, f"unknown client '{client_id}'")
    data = await file.read()
    try:
        parsed = parse_budget_file(data, file.filename, period=period, window_months=window_months)
    except ValueError as e:
        raise HTTPException(400, str(e))
    service.update_config(client_id, {"budget_lines": parsed["lines"]}, engine=_engine)
    _bundle_cache_clear()                              # budget lines feed the bundle's pacing/recon
    return parsed


# ---- upload + inventory --------------------------------------------------
def _safe_seg(*parts):
    for p in parts:
        if not p or any(s in p for s in ("..", "/", "\\")):
            raise HTTPException(400, "invalid client or period")


UPLOAD_CHUNK = 1024 * 1024  # 1 MB


async def _save_upload(f, dest_dir):
    """Stream an uploaded file to disk in 1 MB chunks (constant memory, no full read
    into RAM). Files gzipped by the browser (.csv.gz) are gunzipped on the way in, so
    everything downstream still sees a plain .csv. Returns the saved Path, or None if
    the upload isn't a .csv / .csv.gz."""
    fname = f.filename or ""
    low = fname.lower()
    if low.endswith(".gz"):
        out_name = Path(fname[:-3]).name            # strip .gz -> .csv
        dec = zlib.decompressobj(16 + zlib.MAX_WBITS)   # gzip stream
    elif low.endswith(".csv"):
        out_name = Path(fname).name
        dec = None
    else:
        return None
    dest_path = dest_dir / out_name
    with open(dest_path, "wb") as out:
        while True:
            chunk = await f.read(UPLOAD_CHUNK)
            if not chunk:
                break
            out.write(dec.decompress(chunk) if dec else chunk)
        if dec:
            out.write(dec.flush())
    return dest_path


@app.post("/api/upload")
async def upload(background: BackgroundTasks, client: str = Form(...), period: str = Form(...),
                 files: List[UploadFile] = File(...)):
    _safe_seg(client, period)
    dest = UPLOADS / client / period
    dest.mkdir(parents=True, exist_ok=True)
    saved = 0
    for f in files:
        if await _save_upload(f, dest):
            saved += 1
    if saved == 0:
        raise HTTPException(400, "no .csv files in upload")
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "processing"}

    def _ingest_then_map():
        result = service.ingest_folder(client, str(dest), engine=_engine)
        _sync_mappings(client)                    # auto-map new campaigns for review
        return result
    background.add_task(_run_job, job_id, _ingest_then_map)
    return {"job_id": job_id, "status": "processing"}


@app.get("/api/upload/status/{job_id}")
def upload_status(job_id: str):
    j = _JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "unknown or expired job")
    return j


MCC_STAGE = UPLOADS / "_mcc"


@app.post("/api/upload/mcc/preview")
async def mcc_preview(files: List[UploadFile] = File(...)):
    """Stage an MCC export and report the accounts inside it (no writes). Returns a
    batch_id to pass to /commit along with the confirmed account→client mapping."""
    import uuid
    batch_id = uuid.uuid4().hex[:12]
    dest = MCC_STAGE / batch_id
    dest.mkdir(parents=True, exist_ok=True)
    saved = 0
    for f in files:
        if await _save_upload(f, dest):
            saved += 1
    if saved == 0:
        raise HTTPException(400, "no .csv files in upload")
    result = await run_in_threadpool(service.preview_mcc, str(dest), engine=_engine)
    result["batch_id"] = batch_id
    return result


@app.post("/api/upload/mcc/commit")
def mcc_commit(body: dict, background: BackgroundTasks):
    batch_id = body.get("batch_id")
    if not batch_id or any(s in str(batch_id) for s in ("..", "/", "\\")):
        raise HTTPException(400, "invalid batch_id")
    dest = MCC_STAGE / batch_id
    if not dest.is_dir():
        raise HTTPException(404, "batch not found (re-run preview)")
    mapping = body.get("mapping") or {}
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "processing"}

    def _commit_then_map():
        result = service.commit_mcc(str(dest), mapping, engine=_engine)
        _sync_mappings(*[r.get("client_id") for r in result.get("ingested", [])])
        return result
    background.add_task(_run_job, job_id, _commit_then_map)
    return {"job_id": job_id, "status": "processing"}


# ---- Google Ads API auto-pull -------------------------------------------
@app.get("/api/adsapi/status")
def adsapi_status():
    """Whether the API sync is configured (which env vars are still missing — NAMES only,
    never values), which clients are syncable (have a google_customer_id), and when each was
    last pulled from the API (freshness)."""
    import datetime as _dt
    from engine.adsapi import client as adsapi_client
    from engine.adsapi.schedule import next_cron_run
    from sqlalchemy import select, func
    from engine.ingest.store import uploads
    clients = service.list_clients(engine=_engine)
    # latest API-sourced upload per client (source_file is stamped "adsapi:<report>")
    with _engine.connect() as c:
        last_synced = dict(c.execute(
            select(uploads.c.client_id, func.max(uploads.c.uploaded_at))
            .where(uploads.c.source_file.like("adsapi:%")).group_by(uploads.c.client_id)).all())
    # Automatic-sync schedule: mirror the Railway cron by setting ADSAPI_CRON_SCHEDULE to the
    # same expression. next_sync is computed in UTC for the UI countdown.
    schedule = os.environ.get("ADSAPI_CRON_SCHEDULE")
    nxt = next_cron_run(schedule, _dt.datetime.utcnow()) if schedule else None
    all_last = [v for v in last_synced.values() if v]
    return {
        "configured": adsapi_client.credentials_configured(),
        "missing_env": adsapi_client.missing_credentials(),
        "schedule": schedule,
        "next_sync": (nxt.replace(microsecond=0).isoformat() + "Z") if nxt else None,
        "last_sync": (str(max(all_last)) if all_last else None),
        "clients": [{"client_id": c["client_id"], "name": c["name"],
                     "customer_id": c.get("google_customer_id"),
                     "syncable": bool(c.get("google_customer_id")),
                     "last_synced": (str(last_synced[c["client_id"]])
                                     if last_synced.get(c["client_id"]) else None)} for c in clients],
    }


@app.post("/api/adsapi/sync")
def adsapi_sync(body: dict, background: BackgroundTasks):
    """Kick a background pull for one client (body {"client_id": ...}) or all clients.
    Returns a job_id to poll at /api/adsapi/sync/status/{job_id}."""
    from engine.adsapi import client as adsapi_client, sync as adsapi_sync_mod
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))
    client_id = (body or {}).get("client_id")
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "processing"}

    def _pull_then_map():
        if client_id:
            result = adsapi_sync_mod.sync_one(_engine, client_id)
            _sync_mappings(client_id)
        else:
            result = adsapi_sync_mod.sync_all(_engine)
            _sync_mappings(*[s.get("client_id") for s in result.get("synced", [])])
        return result
    background.add_task(_run_job, job_id, _pull_then_map)
    return {"job_id": job_id, "status": "processing"}


@app.post("/api/adsapi/backfill")
def adsapi_backfill(body: dict, background: BackgroundTasks):
    """Historical backfill: pull a longer window (body {"months": 12}) for one client
    ({"client_id": ...}) or all. Merge-by-window fills in older history without disturbing the
    recent rolling window. Returns a job_id to poll at /api/adsapi/sync/status/{job_id}."""
    from engine.adsapi import client as adsapi_client, sync as adsapi_sync_mod
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))
    client_id = (body or {}).get("client_id")
    try:
        months = max(1, min(36, int((body or {}).get("months", 12))))   # cap at 3 years
    except (TypeError, ValueError):
        raise HTTPException(400, "months must be an integer")
    window = adsapi_sync_mod.backfill_window(months)
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "processing"}

    def _backfill_then_map():
        if client_id:
            result = adsapi_sync_mod.sync_one(_engine, client_id, window=window)
            _sync_mappings(client_id)
        else:
            result = adsapi_sync_mod.sync_all(_engine, window=window)
            _sync_mappings(*[s.get("client_id") for s in result.get("synced", [])])
        return result
    background.add_task(_run_job, job_id, _backfill_then_map)
    return {"job_id": job_id, "status": "processing", "months": months,
            "window": [window[0].isoformat(), window[1].isoformat()]}


@app.get("/api/adsapi/sync/status/{job_id}")
def adsapi_sync_status(job_id: str):
    j = _JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "unknown or expired job")
    return j


def _resolve_specs(report):
    from engine.adsapi.reports import DEFAULT_SPECS, SPECS_BY_TYPE
    if report == "all":
        return DEFAULT_SPECS
    if report == "core":
        return [SPECS_BY_TYPE["campaign_performance"], SPECS_BY_TYPE["account_spend"]]
    if report in SPECS_BY_TYPE:
        return [SPECS_BY_TYPE[report]]
    raise HTTPException(400, f"unknown report '{report}'; use one of: core, all, " + ", ".join(SPECS_BY_TYPE))


@app.get("/api/adsapi/preview")
async def adsapi_preview(client: str = Query(None), report: str = Query("core"),
                         customer_id: str = Query(None),
                         date_from: str = Query(None, alias="from"), date_to: str = Query(None, alias="to")):
    """Dry-run parity check: pull from the Google Ads API and return row counts + metric
    totals WITHOUT writing anything to the database. Pass `client` (a client_id) OR
    `customer_id` (an ad-hoc customer id, bypassing the client table). `report` = a single
    report_type, "core" (campaign_performance + account_spend), or "all". Optional from/to
    (YYYY-MM-DD) override the rolling window — e.g. to probe a closed account's history."""
    import datetime as _dt
    from engine.adsapi import client as adsapi_client, sync as adsapi_sync_mod
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))
    specs = _resolve_specs(report)
    window = None
    if date_from or date_to:
        try:
            window = (_dt.date.fromisoformat(date_from), _dt.date.fromisoformat(date_to))
        except (TypeError, ValueError):
            raise HTTPException(400, "from and to must both be YYYY-MM-DD")
    if customer_id:
        adhoc = {"client_id": f"adhoc:{customer_id}", "google_customer_id": customer_id}
        return await run_in_threadpool(lambda: adsapi_sync_mod.preview_client(adhoc, specs=specs, window=window))
    if not client:
        raise HTTPException(400, "pass either client=<client_id> or customer_id=<digits>")
    return await run_in_threadpool(lambda: adsapi_sync_mod.preview_one(_engine, client, specs=specs, window=window))


@app.get("/api/adsapi/validate")
async def adsapi_validate(customer_id: str = Query(None), report: str = Query("all")):
    """Metric-free probe that confirms the live API accepts every report's resource + field
    names. Runs against `customer_id` (defaults to the configured login-customer-id / MCC, the
    account we know is reachable). Writes nothing. Metric fields aren't exercised here."""
    from engine.adsapi import client as adsapi_client, sync as adsapi_sync_mod
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))
    specs = _resolve_specs(report)

    def _run():
        try:
            api = adsapi_client.GoogleAdsApiClient.from_env()
            cid = customer_id or api.login_customer_id()
            out = adsapi_sync_mod.validate_queries(cid, specs=specs, api=api)
            out["customer_id"] = cid
            return out
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}
    return await run_in_threadpool(_run)


@app.get("/api/adsapi/accessible")
async def adsapi_accessible():
    """Diagnostic: which customer ids can these credentials reach, and what login-customer-id
    (MCC) is configured. Read-only, no login-customer-id needed. Helps debug permission errors."""
    from engine.adsapi import client as adsapi_client
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))

    def _run():
        try:
            api = adsapi_client.GoogleAdsApiClient.from_env()
            return {"login_customer_id": api.login_customer_id(),
                    "accessible_customers": api.list_accessible_customers()}
        except Exception as e:                       # never leak a secret value
            return {"error": f"{type(e).__name__}: {e}"}
    return await run_in_threadpool(_run)


@app.post("/api/cron/adsapi-sync")
def cron_adsapi_sync(request: Request, background: BackgroundTasks):
    """Nightly automatic pull. Guarded by a shared secret: the caller must send
    X-Cron-Token matching env ADSAPI_CRON_SECRET. Runs sync_all for every client with a
    customer id, then re-syncs mappings. Point Railway's cron (or any scheduler) at this."""
    from engine.adsapi import client as adsapi_client, sync as adsapi_sync_mod
    secret = os.environ.get("ADSAPI_CRON_SECRET")
    if not secret or request.headers.get("X-Cron-Token") != secret:
        raise HTTPException(403, "forbidden")
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "processing"}

    def _pull_all():
        result = adsapi_sync_mod.sync_all(_engine)
        _sync_mappings(*[s.get("client_id") for s in result.get("synced", [])])
        return result
    background.add_task(_run_job, job_id, _pull_all)
    return {"status": "started", "job_id": job_id}


@app.get("/api/adsapi/tree")
async def adsapi_tree(manager_id: str = Query(None)):
    """Enumerate every account under a manager (defaults to the configured login-customer-id),
    marking managers vs leaf ad accounts. Leaves are the accounts we can pull metrics from."""
    from engine.adsapi import client as adsapi_client
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))

    def _run():
        try:
            api = adsapi_client.GoogleAdsApiClient.from_env()
            mgr = manager_id or api.login_customer_id()
            accounts = api.list_customer_tree(mgr)
            leaves = [a for a in accounts if not a["manager"]]
            return {"manager_id": mgr, "count": len(accounts),
                    "leaf_accounts": leaves, "all_accounts": accounts}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}
    return await run_in_threadpool(_run)


@app.get("/api/adsapi/validate-fields")
async def adsapi_validate_fields():
    """Audit EVERY field name in the code (metrics included) against Google's schema via
    GoogleAdsFieldService. No account/data needed. Reports any field that doesn't exist or
    isn't selectable — the definitive check that our GAQL columns are all real."""
    from engine.adsapi import client as adsapi_client
    from engine.adsapi.reports import all_field_paths
    missing = adsapi_client.missing_credentials()
    if missing:
        raise HTTPException(400, "Google Ads API not configured; set env vars: " + ", ".join(missing))

    def _run():
        try:
            api = adsapi_client.GoogleAdsApiClient.from_env()
            paths = all_field_paths()
            found = api.validate_fields(paths)
            checks = []
            for p in paths:
                info = found.get(p)
                c = {"field": p, "exists": info is not None,
                     "selectable": bool(info and info["selectable"])}
                if info:
                    c["category"] = info["category"]
                    c["data_type"] = info["data_type"]
                checks.append(c)
            problems = [c for c in checks if not c["exists"] or not c["selectable"]]
            return {"total_fields": len(paths), "all_ok": not problems,
                    "problems": problems, "checks": checks}
        except Exception as e:
            return {"error": f"{type(e).__name__}: {e}"}
    return await run_in_threadpool(_run)


@app.get("/api/inventory")
def inventory(client: str = Query(...)):
    _safe_seg(client)
    return service.inventory(client, engine=_engine)


# ---- bundle --------------------------------------------------------------
@app.get("/api/bundle")
def bundle(client: str = Query("mavis"), period: str = Query("2026-03"),
           date_from: str = Query(None, alias="from"), date_to: str = Query(None, alias="to"),
           seg: str = Query("all"), campaign: str = Query("all"), region: str = Query("all"),
           category: str = Query("all"), brand: str = Query("all"), type: str = Query("all"),
           compare: str = Query("yoy"), cfrom: str = Query(None), cto: str = Query(None)):
    _safe_seg(client, period)
    filters = {"seg": seg, "campaign": campaign, "region": region, "category": category,
               "brand": brand, "type": type}
    has_filter = any(v and v != "all" for v in filters.values())
    # Pre-baked bundle (e.g. the Mavis demo) wins if present (ignores date range + filters).
    path = CLIENTS / client / period / "bundle.json"
    if path.is_file() and not (date_from or date_to or has_filter or compare != "yoy"):
        return FileResponse(path, media_type="application/json")
    # Serve an unexpired cached build for these exact params (instant reload / filter re-toggle).
    key = (client, period, date_from, date_to, seg, campaign, region, category, brand, type, compare, cfrom, cto)
    cached = _bundle_cache_get(key)
    if cached is not None:
        return JSONResponse(cached)
    # Otherwise compute it from the warehouse, honoring the date range + global filters.
    computed = build_bundle(client, _engine, date_from=date_from, date_to=date_to, filters=filters,
                            compare=compare, compare_from=cfrom, compare_to=cto)
    if computed is None:
        raise HTTPException(404, f"no data for client '{client}'")
    _bundle_cache_put(key, computed)
    return JSONResponse(computed)


# ---- Redesign (React) build, served at /next -----------------------------
# Present only when frontend-next has been built (frontend-next/dist). One catch-all
# route serves the hashed static assets and falls back to index.html for client-side
# (SPA) routes so deep links / refreshes work. Registered before the "/" mount so it wins.
NEXT_DIST = ROOT / "frontend-next" / "dist"


@app.get("/next")
@app.get("/next/{path:path}")
def next_app(path: str = ""):
    if not NEXT_DIST.is_dir():
        raise HTTPException(404, "redesign build not present (run `npm run build` in frontend-next)")
    root = NEXT_DIST.resolve()
    target = (NEXT_DIST / path).resolve()
    if target.is_file() and root in target.parents:      # real asset (traversal-guarded)
        return FileResponse(target)
    return FileResponse(NEXT_DIST / "index.html")         # SPA fallback


# Static frontend (current app) mounted last so /api/* and /next win.
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
