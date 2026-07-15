#!/usr/bin/env python3
"""Chazif Insights — production backend (Railway target).

Serves the static frontend and resolves the per-client, per-period DATA bundle.
Same routes as backend/dev_server.py, but on FastAPI/uvicorn so it can grow
auth, uploads, and the engine endpoints in later phases.

Run locally:  py -m uvicorn backend.main:app --reload --port 8000
Railway:      Procfile -> uvicorn backend.main:app --host 0.0.0.0 --port $PORT
"""
import os
from pathlib import Path
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
CLIENTS = ROOT / "data" / "clients"

app = FastAPI(title="Chazif Insights", version="0.1.0")


@app.get("/api/health")
def health():
    return {"ok": True, "service": "chazif-insights", "version": "0.1.0"}


@app.get("/api/bundle")
def bundle(client: str = Query("mavis"), period: str = Query("2026-03")):
    """Return the render-ready DATA bundle for one client + period."""
    # reject path traversal — client/period are single path segments
    for part in (client, period):
        if not part or any(sep in part for sep in ("..", "/", "\\")):
            raise HTTPException(400, "invalid client or period")
    path = CLIENTS / client / period / "bundle.json"
    if not path.is_file():
        raise HTTPException(404, f"no bundle for {client}/{period}")
    return FileResponse(path, media_type="application/json")


# Static frontend mounted last so /api/* routes win.
app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="frontend")
