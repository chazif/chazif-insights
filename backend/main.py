#!/usr/bin/env python3
"""Chazif Insights — production backend (Railway target).

Serves the static frontend, the per-client DATA bundle, and the admin API
(clients, upload, inventory). SQLite locally / Postgres via DATABASE_URL.

Run locally:  py -m uvicorn backend.main:app --reload --port 8000
Railway:      Procfile -> uvicorn backend.main:app --host 0.0.0.0 --port $PORT
"""
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from engine.ingest import service
from engine.ingest.store import get_engine

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CLIENTS = ROOT / "data" / "clients"
UPLOADS = ROOT / "data" / "uploads"

app = FastAPI(title="Chazif Insights", version="0.2.0")
_engine = get_engine()


@app.get("/api/health")
def health():
    return {"ok": True, "service": "chazif-insights", "version": "0.2.0"}


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
def bundle(client: str = Query("mavis"), period: str = Query("2026-03")):
    _safe_seg(client, period)
    path = CLIENTS / client / period / "bundle.json"
    if not path.is_file():
        raise HTTPException(404, f"no bundle for {client}/{period}")
    return FileResponse(path, media_type="application/json")


# Static frontend mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
