#!/usr/bin/env python3
"""V2 calibration loop + decision-lifecycle hookup (PR bi-v2-calibration, §6).

Covers: finalize -> next-period ingest -> actual populated; a second reconcile doesn't
overwrite; MAPE/bias computed; and finalize files decision-lifecycle actions idempotently.
Throwaway SQLite; no network.
"""
import datetime
import json

import pytest
from sqlalchemy import create_engine, insert, select

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
from engine.budget_intel.tables import predictions
from engine.budget_intel.curves import fit_master_curves, save_fit
from engine.decisions.tables import metadata as dec_md, actions

SIM_POINTS = [
    {"is_share": 0.15, "spend_week": 20912, "leads_week": 1754},
    {"is_share": 0.20, "spend_week": 23242, "leads_week": 2664},
    {"is_share": 0.25, "spend_week": 25582, "leads_week": 3563},
    {"is_share": 0.30, "spend_week": 28292, "leads_week": 4351},
    {"is_share": 0.35, "spend_week": 31852, "leads_week": 4873},
    {"is_share": 0.40, "spend_week": 35602, "leads_week": 5314},
]
REF_W1 = {"mode": "week", "period_start": "2026-06-01", "weeks": 1}


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    bi_tables.init_db(eng)
    dec_md.create_all(eng)          # decisions schema so the lifecycle hookup can file actions
    return eng


def _seed_week(engine, cid, up, start_day, per_day):
    """per_day: [(day_offset, cost, conv)] for each of the two cells."""
    for name, isshare in [("ACME_G_SRCH_EAST", 0.35), ("ACME_G_SRCH_WEST", 0.25)]:
        for off, cost, conv in per_day:
            c = engine
            with c.begin() as conn:
                conn.execute(insert(raw_rows).values(
                    client_id=cid, upload_id=up, report_type="campaign_performance",
                    campaign=name, clicks=int(conv * 10), impressions=int(conv * 200),
                    cost=cost, conversions=conv,
                    date_norm=datetime.date(2026, 6, start_day + off),
                    row=json.dumps({"search_impr_share": isshare, "target_cpa": 18.0})))


def _setup(engine, cid="acme"):
    with engine.begin() as conn:
        up = conn.execute(insert(uploads).values(
            client_id=cid, report_type="campaign_performance", row_count=1,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
    _seed_week(engine, cid, up, 1, [(0, 1800.0, 90.0), (1, 1700.0, 85.0)])   # week 1: Jun 1–2
    bi.upsert_mappings(engine, cid, [
        {"campaign": "ACME_G_SRCH_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"},
        {"campaign": "ACME_G_SRCH_WEST", "brand": "ACME", "region": "WEST", "category": "SRCH"},
    ])
    bi.upsert_business_metrics(engine, cid, [
        {"brand": "ACME", "region": "EAST", "category": "SRCH", "period_start": "2026-06-01",
         "revenue_per_conv": 400.0, "gp_pct": 0.8, "car_count": 200.0},
        {"brand": "ACME", "region": "WEST", "category": "SRCH", "period_start": "2026-06-01",
         "revenue_per_conv": 380.0, "gp_pct": 0.75, "car_count": 100.0},
    ])
    params, diag = fit_master_curves(SIM_POINTS)
    save_fit(engine, cid, params, diag, source="simulator")
    return up


def test_calibration_loop_populates_actuals_then_is_stable(engine):
    up = _setup(engine)
    run_id, _ = bi.create_run(engine, "acme", goal="main_conv", budget=40000.0,
                              run_params={"reference": REF_W1})
    bi.finalize_run(engine, "acme", run_id, goal="main_conv")

    # no next-period data yet -> nothing to reconcile
    assert bi.reconcile_predictions(engine, "acme") == 0
    # ingest the FOLLOWING week (Jun 8–9), then reconcile
    _seed_week(engine, "acme", up, 8, [(0, 2100.0, 120.0), (1, 2000.0, 110.0)])
    assert bi.reconcile_predictions(engine, "acme") == 2         # both cells measured
    with engine.connect() as c:
        preds = c.execute(select(predictions).where(predictions.c.run_id == run_id)).mappings().all()
    assert all(p["actual"] is not None and p["measured_at"] is not None for p in preds)
    east = next(p for p in preds if p["region"] == "EAST")
    assert east["actual"]["units"] == pytest.approx(230.0)       # 120 + 110 conversions in week 2
    # a second reconcile must not overwrite
    assert bi.reconcile_predictions(engine, "acme") == 0

    rep = bi.calibration_report(engine, "acme")
    cell = next(c for c in rep["cells"] if c["region"] == "EAST")
    assert cell["metrics"]["units"]["mape"] is not None and cell["metrics"]["units"]["n"] == 1
    assert rep["simulator_vs_actual"]["units_bias"] is not None   # optimism measurable


def test_finalize_files_decision_actions_idempotently(engine):
    _setup(engine)
    run_id, _ = bi.create_run(engine, "acme", goal="main_conv", budget=40000.0,
                              run_params={"reference": REF_W1})
    bi.finalize_run(engine, "acme", run_id, goal="main_conv")
    with engine.connect() as c:
        acts = c.execute(select(actions).where(
            (actions.c.client_id == "acme") & (actions.c.module == "budget_intel"))).mappings().all()
    assert acts, "finalize should file at least one budget_intel action for a large move"
    n = len(acts)
    # re-running the hookup with the same results creates no duplicates (idempotent per key)
    run = bi.get_run(engine, "acme", run_id)
    bi._create_lifecycle_actions(engine, "acme", run_id, "main_conv", run["scenarios"]["main_conv"])
    with engine.connect() as c:
        again = c.execute(select(actions).where(
            (actions.c.client_id == "acme") & (actions.c.module == "budget_intel"))).all()
    assert len(again) == n
