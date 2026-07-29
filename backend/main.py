#!/usr/bin/env python3
"""SearchNex AE — production backend (Railway target).

Serves the static frontend, the per-client DATA bundle, and the admin API
(clients, upload, inventory). SQLite locally / Postgres via DATABASE_URL.

Run locally:  py -m uvicorn backend.main:app --reload --port 8000
Railway:      Procfile -> uvicorn backend.main:app --host 0.0.0.0 --port $PORT
"""
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

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CLIENTS = ROOT / "data" / "clients"
UPLOADS = ROOT / "data" / "uploads"

app = FastAPI(title="SearchNex Ads", version="0.3.0")
# read_engine wraps the Postgres engine with BigQuery analytics routing once BigQuery is
# ACTIVE (config vars + USE_BIGQUERY); until cutover it returns the plain Postgres engine.
_engine = read_engine(get_engine())

# Ingestion is heavy (parse + insert of large exports). Doing it inside the request
# blocks the worker long enough that Railway's edge times the connection out with a
# 502. Instead we run it as a background job and let the UI poll for completion.
_JOBS = {}   # job_id -> {"status": processing|done|error, "result"/"error": ...}


def _run_job(job_id, fn):
    """Run a blocking ingest fn in the threadpool and record its result on the job."""
    try:
        _JOBS[job_id] = {"status": "done", "result": fn()}
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


@app.get("/api/clients")
def clients_list():
    return service.list_clients(engine=_engine)


@app.post("/api/clients", status_code=201)
def clients_create(body: ClientCreate):
    try:
        return service.create_client(body.name, client_id=body.client_id, engine=_engine)
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
        return service.update_config(client_id, body, engine=_engine)
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
    background.add_task(_run_job, job_id, lambda: service.ingest_folder(client, str(dest), engine=_engine))
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
    background.add_task(_run_job, job_id, lambda: service.commit_mcc(str(dest), mapping, engine=_engine))
    return {"job_id": job_id, "status": "processing"}


@app.get("/api/inventory")
def inventory(client: str = Query(...)):
    _safe_seg(client)
    return service.inventory(client, engine=_engine)


# ---- bundle --------------------------------------------------------------
@app.get("/api/bundle")
def bundle(client: str = Query("mavis"), period: str = Query("2026-03"),
           date_from: str = Query(None, alias="from"), date_to: str = Query(None, alias="to"),
           seg: str = Query("all"), campaign: str = Query("all"), region: str = Query("all"),
           category: str = Query("all"), brand: str = Query("all"),
           compare: str = Query("yoy"), cfrom: str = Query(None), cto: str = Query(None)):
    _safe_seg(client, period)
    filters = {"seg": seg, "campaign": campaign, "region": region, "category": category, "brand": brand}
    has_filter = any(v and v != "all" for v in filters.values())
    # Pre-baked bundle (e.g. the Mavis demo) wins if present (ignores date range + filters).
    path = CLIENTS / client / period / "bundle.json"
    if path.is_file() and not (date_from or date_to or has_filter or compare != "yoy"):
        return FileResponse(path, media_type="application/json")
    # Otherwise compute it from the warehouse, honoring the date range + global filters.
    computed = build_bundle(client, _engine, date_from=date_from, date_to=date_to, filters=filters,
                            compare=compare, compare_from=cfrom, compare_to=cto)
    if computed is None:
        raise HTTPException(404, f"no data for client '{client}'")
    return JSONResponse(computed)


# Static frontend mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
