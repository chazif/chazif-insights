#!/usr/bin/env python3
"""Budget Intelligence service layer: warehouse -> cells -> allocation runs.

Reads the existing Layer-1 warehouse (engine/ingest/store.py raw_rows) through
bi_campaign_mappings, merges bi_business_metrics, and persists allocation runs.
All queries are client_id-isolated. No LLM anywhere in this module.
"""
import datetime
import json

from sqlalchemy import select, insert, delete, text

from .model import Cell, mround
from .tables import (campaign_mappings, business_metrics, simulator_snapshots,
                     allocation_runs, allocation_results, predictions)
from .curves import get_active_curves
from .allocate import run_allocation


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _jrow(v):
    """raw_rows.row via text() SQL arrives as a dict (BQ JSON / PG jsonb) or a
    JSON string (SQLite) — and double-encoded when a caller stored a pre-dumped
    string through the JSON column type. Decode until it's a dict."""
    for _ in range(2):
        if not isinstance(v, str):
            break
        try:
            v = json.loads(v)
        except (ValueError, TypeError):
            return {}
    return v if isinstance(v, dict) else {}


# ---- mappings --------------------------------------------------------------

def upsert_mappings(engine, client_id, rows):
    """rows: [{campaign, brand, region, category, engine?, camp_type?}].
    Full-row replace per campaign (idempotent)."""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            c.execute(delete(campaign_mappings).where(
                (campaign_mappings.c.client_id == client_id)
                & (campaign_mappings.c.campaign == r["campaign"])))
            c.execute(insert(campaign_mappings).values(
                client_id=client_id, campaign=r["campaign"],
                brand=r.get("brand"), region=r.get("region"),
                category=r.get("category"), engine=r.get("engine"),
                camp_type=r.get("camp_type"), updated_at=now))
    return len(rows)


def get_mappings(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(campaign_mappings).where(
            campaign_mappings.c.client_id == client_id)).mappings().all()
    return [dict(r) for r in rows]


def suggest_mapping(campaign):
    """Parse BRAND_ENGINE_TYPE_REGION-style names into a suggested mapping."""
    parts = (campaign or "").split("_")
    if len(parts) >= 4:
        return {"campaign": campaign, "brand": parts[0], "engine": parts[1],
                "camp_type": parts[2], "region": "_".join(parts[3:]),
                "category": parts[2]}
    return {"campaign": campaign, "brand": None, "engine": None,
            "camp_type": None, "region": None, "category": None}


def unmapped_campaigns(engine, client_id):
    """Campaigns present in the warehouse but absent from mappings — blocks runs."""
    with engine.connect() as c:
        seen = {r[0] for r in c.execute(text(
            "SELECT DISTINCT campaign FROM raw_rows "
            "WHERE client_id = :cid AND report_type = 'campaign_performance' "
            "AND campaign IS NOT NULL"), {"cid": client_id})}
        mapped = {r[0] for r in c.execute(select(campaign_mappings.c.campaign).where(
            campaign_mappings.c.client_id == client_id))}
    return sorted(seen - mapped)


# ---- business metrics -------------------------------------------------------

def upsert_business_metrics(engine, client_id, rows):
    """rows: [{brand, region, category, period_start(iso), revenue_per_conv,
    gp_pct, car_count?, source?}]"""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            period = r.get("period_start")
            if isinstance(period, str):
                period = datetime.date.fromisoformat(period)
            where = ((business_metrics.c.client_id == client_id)
                     & (business_metrics.c.brand == r["brand"])
                     & (business_metrics.c.region == r["region"])
                     & (business_metrics.c.category == r["category"])
                     & (business_metrics.c.period_start == period))
            c.execute(delete(business_metrics).where(where))
            c.execute(insert(business_metrics).values(
                client_id=client_id, brand=r["brand"], region=r["region"],
                category=r["category"], period_start=period,
                revenue_per_conv=r.get("revenue_per_conv"),
                gp_pct=r.get("gp_pct"), car_count=r.get("car_count"),
                source=r.get("source", "config"), updated_at=now))
    return len(rows)


def get_business_metrics(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(business_metrics).where(
            business_metrics.c.client_id == client_id)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("period_start"), (datetime.date, datetime.datetime)):
            d["period_start"] = d["period_start"].isoformat()
        out.append(d)
    return out


# ---- simulator snapshots ----------------------------------------------------

def add_snapshot(engine, client_id, points, source="manual", campaign=None):
    with engine.begin() as c:
        c.execute(insert(simulator_snapshots).values(
            client_id=client_id, campaign=campaign, taken_at=_now(),
            source=source, points=points))
    from . import bq_mirror
    bq_mirror.mirror_snapshot(client_id, points, source, campaign)  # fail-soft


# ---- actuals builder (the programmatic Actuals sheet) ------------------------

def build_cells(engine, client_id):
    """Aggregate mapped campaign_performance rows to Brand × Region × Category
    Cells, merging tCPA (cost-weighted, where the export carries target_cpa) and
    the latest business metrics per cell. MODEL_SPEC §1 semantics.

    IS aggregation: eligible impressions = impr / IS per campaign;
    cell IS = sum(impr) / sum(eligible)."""
    mappings = {m["campaign"]: m for m in get_mappings(engine, client_id)}
    # text() SQL, not a Core select: the BigQuery RouterEngine (engine/warehouse/
    # analytics.py) routes raw text touching raw_rows to BigQuery after cutover,
    # while Core selects always go to Postgres. Column list is the intersection
    # of the PG and BQ raw_rows schemas.
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT campaign, clicks, impressions, cost, conversions, row "
            "FROM raw_rows WHERE client_id = :cid "
            "AND report_type = 'campaign_performance'"),
            {"cid": client_id}).mappings().all()

    agg = {}
    for r in rows:
        m = mappings.get(r["campaign"])
        if not m or not m.get("brand"):
            continue
        key = (m["brand"], m["region"], m["category"])
        a = agg.setdefault(key, dict(impr=0.0, clicks=0.0, cost=0.0, conv=0.0,
                                     eligible=0.0, tcpa_wsum=0.0, tcpa_w=0.0))
        j = _jrow(r["row"])
        impr = r["impressions"] or 0.0
        a["impr"] += impr
        a["clicks"] += r["clicks"] or 0.0
        a["cost"] += r["cost"] or 0.0
        a["conv"] += r["conversions"] or 0.0
        is_frac = j.get("search_impr_share")
        try:
            is_frac = float(is_frac) if is_frac is not None else None
        except (TypeError, ValueError):
            is_frac = None
        if is_frac and impr:
            a["eligible"] += impr / is_frac
        tcpa = j.get("target_cpa")
        try:
            tcpa = float(str(tcpa).replace("$", "").replace(",", ""))
        except (TypeError, ValueError):
            tcpa = None
        if tcpa and r["cost"]:
            a["tcpa_wsum"] += tcpa * r["cost"]
            a["tcpa_w"] += r["cost"]

    # latest business metrics per cell
    bm = {}
    for r in get_business_metrics(engine, client_id):
        key = (r["brand"], r["region"], r["category"])
        if key not in bm or (r["period_start"] or "") > (bm[key]["period_start"] or ""):
            bm[key] = r

    cells = []
    for key, a in sorted(agg.items()):
        brand, region, category = key
        conv, cost = a["conv"], a["cost"]
        is_share = (a["impr"] / a["eligible"]) if a["eligible"] else 0.0
        b = bm.get(key, {})
        car_count = b.get("car_count") or conv          # fallback: conv == car
        rev_per_car = b.get("revenue_per_conv") or 0.0
        gp_pct = b.get("gp_pct") or 0.0
        cells.append(Cell(
            brand=brand, region=region, category=category,
            impr=a["impr"], clicks=a["clicks"], cost=cost, main_conv=conv,
            cpa=cost / conv if conv else 0.0,
            tcpa=a["tcpa_wsum"] / a["tcpa_w"] if a["tcpa_w"] else 0.0,
            is_share=is_share,
            rev_per_car=rev_per_car, gp_per_car=rev_per_car * gp_pct,
            gp_pct=gp_pct,
            cost_per_car=cost / car_count if car_count else 0.0,
            car_count=car_count,
            is_current=max(1, min(100, mround(is_share * 100))) if is_share else 0,
        ))
    return cells


# ---- allocation runs ----------------------------------------------------------

def create_run(engine, client_id, goal, budget, mode="greedy_marginal",
               run_params=None, created_by="api", notes=None, cells=None):
    """Build cells (unless supplied), resolve curves, allocate, persist run +
    results. Returns (run_id, results). Raises ValueError when unmapped
    campaigns exist or inputs are unusable — actionable messages throughout."""
    unmapped = unmapped_campaigns(engine, client_id)
    if unmapped and cells is None:
        raise ValueError(f"unmapped campaigns block the run: {unmapped[:10]}"
                         + (f" (+{len(unmapped)-10} more)" if len(unmapped) > 10 else ""))
    cells = cells if cells is not None else build_cells(engine, client_id)
    cells = [c for c in cells if c.is_current and c.cost > 0]
    if not cells:
        raise ValueError("no usable cells: need mapped campaign data with "
                         "impression share > 0")
    curves = get_active_curves(engine, client_id)
    results = run_allocation(cells, curves, goal=goal, budget=budget, mode=mode,
                             run_params=run_params)
    with engine.begin() as c:
        run_id = c.execute(insert(allocation_runs).values(
            client_id=client_id, run_at=_now(), created_by=created_by,
            goal=goal, budget=budget, mode=mode, params=run_params or {},
            status="draft", notes=notes)).inserted_primary_key[0]
        for r in results:
            c.execute(insert(allocation_results).values(run_id=run_id, **r))
    return run_id, results


def get_run(engine, client_id, run_id):
    with engine.connect() as c:
        run = c.execute(select(allocation_runs).where(
            (allocation_runs.c.id == run_id)
            & (allocation_runs.c.client_id == client_id))).mappings().first()
        if not run:
            return None
        rows = c.execute(select(allocation_results).where(
            allocation_results.c.run_id == run_id)).mappings().all()
    out = dict(run)
    if isinstance(out.get("run_at"), datetime.datetime):
        out["run_at"] = out["run_at"].isoformat()
    out["results"] = [dict(r) for r in rows]
    return out


def list_runs(engine, client_id, limit=20):
    with engine.connect() as c:
        rows = c.execute(select(allocation_runs).where(
            allocation_runs.c.client_id == client_id)
            .order_by(allocation_runs.c.id.desc()).limit(limit)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("run_at"), datetime.datetime):
            d["run_at"] = d["run_at"].isoformat()
        out.append(d)
    return out


def finalize_run(engine, client_id, run_id, created_by="api"):
    """Mark a run final and stamp predictions for the calibration loop (B5)."""
    run = get_run(engine, client_id, run_id)
    if not run:
        raise LookupError(f"run {run_id} not found for client {client_id}")
    if run["status"] == "final":
        return run
    with engine.begin() as c:
        c.execute(allocation_runs.update().where(
            allocation_runs.c.id == run_id).values(status="final"))
        for r in run["results"]:
            c.execute(insert(predictions).values(
                run_id=run_id, brand=r["brand"], region=r["region"],
                category=r["category"],
                predicted={"is": r["expected_is"], "cpa": r["expected_cpa"],
                           "cars": r["expected_cars"], "spend": r["rec_spend"]}))
    run["status"] = "final"
    from . import bq_mirror
    bq_mirror.mirror_finalized_run(run)   # fail-soft analytical mirror
    return run
