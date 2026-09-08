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
    sim_type: str = "budget"             # V2 §6: budget | target_cpa
    x_axis: str = "is_share"             # V2 §6: is_share | spend


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
                    campaign=body.campaign, sim_type=body.sim_type, x_axis=body.x_axis)
    out = {"saved": len(body.points)}
    # only BUDGET sims fit the master leads/cpl curve; TARGET_CPA sims are stored for the
    # compare report (§6d) and are not fit into the model.
    if body.fit and body.sim_type == "budget":
        try:
            params, diag = bi_curves.fit_master_curves(body.points)
            bi_curves.save_fit(engine(), client_id, params, diag, source="simulator")
            out["fit"] = {"params": params, "diagnostics": diag}
        except ValueError as e:
            raise HTTPException(422, f"points saved, but fitting failed: {e}")
    return out


@router.get("/simulations/compare")
def simulations_compare(client_id: str):
    """V2 §6d: the budget curve's implied CPA at each spend vs the target-CPA simulation."""
    return bi.simulations_compare(engine(), client_id)


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
def finalize(client_id: str, run_id: int, body: dict | None = None, created_by: str = "api"):
    """V2: pick a goal to finalize (predictions stamped for it). Body {"goal": "..."};
    defaults to the run's requested view when omitted."""
    goal = (body or {}).get("goal")
    try:
        return bi.finalize_run(engine(), client_id, run_id, goal=goal, created_by=created_by)
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.post("/runs/{run_id}/override")
def override(client_id: str, run_id: int, body: dict):
    """V2 §5 audited override: {cell_key:[brand,region,category], spend, reason, actor, goal?}.
    Sets rec_spend past the guard band, records the override on the run. Never silent."""
    try:
        return bi.override_run(
            engine(), client_id, run_id, cell_key=tuple(body["cell_key"]),
            spend=float(body["spend"]), reason=body.get("reason"),
            actor=body.get("actor"), goal=body.get("goal"))
    except LookupError as e:
        raise HTTPException(404, str(e))
    except (ValueError, KeyError) as e:
        raise HTTPException(422, str(e))


@router.get("/guard")
def get_guard(client_id: str):
    return {"rules": bi.get_guard_config(engine(), client_id)}


@router.put("/guard")
def put_guard(client_id: str, rows: List[dict]):
    # full-set replace: the editor posts the complete rule set, so removals delete
    n = bi.replace_guard_config(engine(), client_id, rows)
    return {"saved": n}


@router.get("/calibration")
def calibration(client_id: str):
    """V2 §6: predicted-vs-actual per cell/goal (MAPE + bias) and simulator-vs-actual."""
    return bi.calibration_report(engine(), client_id)


@router.post("/calibration/reconcile")
def reconcile(client_id: str):
    """Measure actuals for finalized runs whose next period has arrived (also runs on ingest)."""
    return {"written": bi.reconcile_predictions(engine(), client_id)}
