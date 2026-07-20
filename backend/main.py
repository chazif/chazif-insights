#!/usr/bin/env python3
"""SearchNex AE — production backend (Railway target).

Serves the static frontend, the per-client DATA bundle, and the admin API
(clients, upload, inventory). SQLite locally / Postgres via DATABASE_URL.

Run locally:  py -m uvicorn backend.main:app --reload --port 8000
Railway:      Procfile -> uvicorn backend.main:app --host 0.0.0.0 --port $PORT
"""
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine.ingest import service
from engine.ingest.store import get_engine
from engine.bundle.assemble import build_bundle

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CLIENTS = ROOT / "data" / "clients"
UPLOADS = ROOT / "data" / "uploads"

app = FastAPI(title="SearchNex AE", version="0.3.0")
_engine = get_engine()


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


# ---- upload + inventory --------------------------------------------------
def _safe_seg(*parts):
    for p in parts:
        if not p or any(s in p for s in ("..", "/", "\\")):
            raise HTTPException(400, "invalid client or period")


@app.post("/api/upload")
async def upload(client: str = Form(...), period: str = Form(...),
                 files: List[UploadFile] = File(...)):
    _safe_seg(client, period)
    dest = UPLOADS / client / period
    dest.mkdir(parents=True, exist_ok=True)
    saved = 0
    for f in files:
        if not f.filename.lower().endswith(".csv"):
            continue
        with open(dest / Path(f.filename).name, "wb") as out:
            out.write(await f.read())
        saved += 1
    if saved == 0:
        raise HTTPException(400, "no .csv files in upload")
    try:
        return service.ingest_folder(client, str(dest), engine=_engine)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/inventory")
def inventory(client: str = Query(...)):
    _safe_seg(client)
    return service.inventory(client, engine=_engine)


# ---- bundle --------------------------------------------------------------
@app.get("/api/bundle")
def bundle(client: str = Query("mavis"), period: str = Query("2026-03"),
           date_from: str = Query(None, alias="from"), date_to: str = Query(None, alias="to"),
           seg: str = Query("all"), campaign: str = Query("all"), region: str = Query("all"),
           category: str = Query("all"), brand: str = Query("all")):
    _safe_seg(client, period)
    filters = {"seg": seg, "campaign": campaign, "region": region, "category": category, "brand": brand}
    has_filter = any(v and v != "all" for v in filters.values())
    # Pre-baked bundle (e.g. the Mavis demo) wins if present (ignores date range + filters).
    path = CLIENTS / client / period / "bundle.json"
    if path.is_file() and not (date_from or date_to or has_filter):
        return FileResponse(path, media_type="application/json")
    # Otherwise compute it from the warehouse, honoring the date range + global filters.
    computed = build_bundle(client, _engine, date_from=date_from, date_to=date_to, filters=filters)
    if computed is None:
        raise HTTPException(404, f"no data for client '{client}'")
    return JSONResponse(computed)


# Static frontend mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
