#!/usr/bin/env python3
"""Budget Intelligence API (Module 2) — self-contained APIRouter.

Mounted from backend/main.py with a single include_router line so the module
can evolve without touching the main app file. Spec: docs/budget-intel/.
"""
from typing import List, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from pydantic import BaseModel

from engine.ingest.store import get_engine
from engine.ingest.service import get_config
from engine.warehouse.analytics import read_engine
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
from engine.budget_intel import curves as bi_curves
from engine import mapping as cmap

router = APIRouter(prefix="/api/clients/{client_id}/budget-intel",
                   tags=["budget-intel"])

_engine = None

# main.py injects its bundle-cache clearer here after include_router — mapping
# changes alter the attribution baked into cached bundles.
invalidate_bundle_cache = lambda: None   # noqa: E731


def engine():
    """Analytics-routed engine: after the BigQuery cutover (USE_BIGQUERY), raw
    text() reads of raw_rows go to BigQuery while bi_* Core statements and all
    writes stay in Postgres — same seam as build_bundle. Before cutover it's
    the plain Postgres/SQLite engine."""
    global _engine
    if _engine is None:
        pg = get_engine()
        bi_tables.init_db(pg)             # DDL always against the real PG engine
        _engine = read_engine(pg)
    return _engine


class MappingRow(BaseModel):
    campaign: str
    brand: Optional[str] = None
    region: Optional[str] = None
    category: Optional[str] = None
    engine: Optional[str] = None
    camp_type: Optional[str] = None


class MetricsRow(BaseModel):
    brand: str
    region: str
    category: str
    period_start: str                    # ISO date
    revenue_per_conv: Optional[float] = None
    gp_pct: Optional[float] = None
    car_count: Optional[float] = None
    source: str = "config"


class SnapshotIn(BaseModel):
    points: List[dict]                   # [{is_share, spend_week, leads_week, cpl?}]
    campaign: Optional[str] = None
    source: str = "manual"
    fit: bool = True                     # fit + activate account-level curves


class RunIn(BaseModel):
    goal: str                            # main_conv | car_count | gp | revenue | max_roi
    budget: float
    mode: str = "greedy_marginal"        # or legacy_waterfall
    max_change_pct: Optional[float] = 0.30
    notes: Optional[str] = None
    created_by: str = "api"


@router.get("/mappings")
def mappings(client_id: str):
    """The central mapping engine's view state: sync first (auto-map any campaigns
    that appeared in newly uploaded data), then return every mapping with its
    source / confidence / review status. `unmapped`/`suggestions` kept (now always
    empty post-sync) for backward compatibility."""
    eng = engine()
    cmap.sync(eng, client_id, get_config(client_id, engine=eng) or {})
    out = cmap.get_all(eng, client_id)
    out["unmapped"] = bi.unmapped_campaigns(eng, client_id)
    out["suggestions"] = []
    return out


@router.put("/mappings")
def put_mappings(client_id: str, rows: List[MappingRow]):
    """Inline edits from the mapping tab — human input overrides auto-mapping."""
    n = cmap.save_user(engine(), client_id, [r.model_dump() for r in rows])
    invalidate_bundle_cache()
    return {"saved": n, "unmapped": bi.unmapped_campaigns(engine(), client_id)}


class ApproveIn(BaseModel):
    campaigns: Optional[List[str]] = None    # None -> approve all pending


@router.post("/mappings/approve")
def approve_mappings(client_id: str, body: ApproveIn):
    n = cmap.approve(engine(), client_id, campaigns=body.campaigns)
    invalidate_bundle_cache()
    return {"approved": n, **{k: v for k, v in cmap.get_all(engine(), client_id).items() if k != "mappings"}}


@router.post("/mappings/upload")
async def upload_mappings(client_id: str, file: UploadFile = File(...)):
    """Upload a mapping document (CSV/XLSX: Campaign + Brand/Region/Category[/Engine/
    Type]) — rows land as source 'file', approved, overriding auto-mapping."""
    data = await file.read()
    try:
        rows = cmap.parse_mapping_file(data, file.filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    n = cmap.save_user(engine(), client_id, rows, source="file")
    invalidate_bundle_cache()
    return {"saved": n, **cmap.get_all(engine(), client_id)}


@router.get("/business-metrics")
def metrics(client_id: str):
    return {"metrics": bi.get_business_metrics(engine(), client_id)}


@router.put("/business-metrics")
def put_metrics(client_id: str, rows: List[MetricsRow]):
    n = bi.upsert_business_metrics(engine(), client_id, [r.model_dump() for r in rows])
    return {"saved": n}


@router.post("/simulator-snapshots", status_code=201)
def add_snapshot(client_id: str, body: SnapshotIn):
    bi.add_snapshot(engine(), client_id, body.points, source=body.source,
                    campaign=body.campaign)
    out = {"saved": len(body.points)}
    if body.fit:
        try:
            params, diag = bi_curves.fit_master_curves(body.points)
            bi_curves.save_fit(engine(), client_id, params, diag, source="simulator")
            out["fit"] = {"params": params, "diagnostics": diag}
        except ValueError as e:
            raise HTTPException(422, f"points saved, but fitting failed: {e}")
    return out


@router.get("/curves")
def curves(client_id: str):
    try:
        c = bi_curves.get_active_curves(engine(), client_id)
        return {"active": True, "leads": list(c.leads), "cpl": list(c.cpl)}
    except LookupError as e:
        return {"active": False, "detail": str(e)}


@router.get("/runs")
def runs(client_id: str):
    return {"runs": bi.list_runs(engine(), client_id)}


@router.post("/runs", status_code=201)
def create_run(client_id: str, body: RunIn):
    rp = {"max_change_pct": body.max_change_pct}
    try:
        run_id, results = bi.create_run(
            engine(), client_id, goal=body.goal, budget=body.budget,
            mode=body.mode, run_params=rp, created_by=body.created_by,
            notes=body.notes)
    except (ValueError, LookupError) as e:
        raise HTTPException(422, str(e))
    return {"run_id": run_id, "results": results}


@router.get("/runs/{run_id}")
def get_run(client_id: str, run_id: int):
    run = bi.get_run(engine(), client_id, run_id)
    if not run:
        raise HTTPException(404, f"run {run_id} not found")
    return run


@router.post("/runs/{run_id}/finalize")
def finalize(client_id: str, run_id: int, created_by: str = "api"):
    try:
        return bi.finalize_run(engine(), client_id, run_id, created_by=created_by)
    except LookupError as e:
        raise HTTPException(404, str(e))
