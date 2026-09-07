#!/usr/bin/env python3
"""V2 goal ladder + per-goal scenarios (PR bi-v2-goal-ladder).

Covers: available goals derived from data (never configured), one allocation per available
goal stored as scenarios over the same cells, finalize picking a goal and stamping
predictions for it only, and cross-goal disagreements. Throwaway SQLite; no network.
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

SIM_POINTS = [
    {"is_share": 0.15, "spend_week": 20912, "leads_week": 1754},
    {"is_share": 0.20, "spend_week": 23242, "leads_week": 2664},
    {"is_share": 0.25, "spend_week": 25582, "leads_week": 3563},
    {"is_share": 0.30, "spend_week": 28292, "leads_week": 4351},
    {"is_share": 0.35, "spend_week": 31852, "leads_week": 4873},
    {"is_share": 0.40, "spend_week": 35602, "leads_week": 5314},
]


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    bi_tables.init_db(eng)
    return eng


def _seed(engine, cid="acme", with_metrics=True, goal_vals=None):
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id=cid, report_type="campaign_performance", row_count=2,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        for name, cost, impr, clicks, conv, is_share, tcpa in [
            ("ACME_G_SRCH_EAST", 5000.0, 40000, 2500, 250.0, 0.35, 18.0),
            ("ACME_G_SRCH_WEST", 3000.0, 30000, 1500, 120.0, 0.25, 20.0),
        ]:
            c.execute(insert(raw_rows).values(
                client_id=cid, upload_id=up, report_type="campaign_performance",
                campaign=name, clicks=clicks, impressions=impr, cost=cost, conversions=conv,
                row=json.dumps({"search_impr_share": is_share, "target_cpa": tcpa})))
    bi.upsert_mappings(engine, cid, [
        {"campaign": "ACME_G_SRCH_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"},
        {"campaign": "ACME_G_SRCH_WEST", "brand": "ACME", "region": "WEST", "category": "SRCH"},
    ])
    if with_metrics:
        bi.upsert_business_metrics(engine, cid, [
            {"brand": "ACME", "region": "EAST", "category": "SRCH", "period_start": "2026-07-01",
             "revenue_per_conv": 400.0, "gp_pct": 0.8, "car_count": 200.0},
            {"brand": "ACME", "region": "WEST", "category": "SRCH", "period_start": "2026-07-01",
             "revenue_per_conv": 380.0, "gp_pct": 0.75, "car_count": 100.0},
        ])
    if goal_vals:
        bi.upsert_goal_values(engine, cid, goal_vals)
    params, diag = fit_master_curves(SIM_POINTS)
    save_fit(engine, cid, params, diag, source="simulator")


def test_available_goals_are_derived_from_data(engine):
    # Google-only client: no business metrics, no uploaded outcomes -> only main_conv.
    _seed(engine, with_metrics=False)
    cells = bi.build_cells(engine, "acme")
    assert bi.available_goals(cells) == ["main_conv"]

    # business metrics present -> transactions rung appears without configuration.
    _seed(engine, "beta", with_metrics=True, goal_vals=[
        {"campaign": "ACME_G_SRCH_EAST", "period_start": "2026-07-01", "goal_key": "customers", "units": 150},
        {"campaign": "ACME_G_SRCH_WEST", "period_start": "2026-07-01", "goal_key": "customers", "units": 60},
    ])
    cells = bi.build_cells(engine, "beta")
    goals = bi.available_goals(cells)
    assert "main_conv" in goals and "transactions" in goals and "customers" in goals


def test_one_run_computes_a_scenario_per_available_goal(engine):
    _seed(engine, goal_vals=[
        {"campaign": "ACME_G_SRCH_EAST", "period_start": "2026-07-01", "goal_key": "customers", "units": 150},
        {"campaign": "ACME_G_SRCH_WEST", "period_start": "2026-07-01", "goal_key": "customers", "units": 60},
    ])
    run_id, results = bi.create_run(engine, "acme", goal="transactions", budget=9000.0)
    run = bi.get_run(engine, "acme", run_id)
    assert set(run["goals_computed"]) == {"main_conv", "transactions", "customers"}
    assert set(run["scenarios"]) == {"main_conv", "transactions", "customers"}
    # same cells in every scenario
    cellsets = [{(r["brand"], r["region"], r["category"]) for r in rs} for rs in run["scenarios"].values()]
    assert all(cs == cellsets[0] for cs in cellsets) and len(cellsets[0]) == 2
    # each result is tagged with its goal + carries the V2 columns
    for g, rs in run["scenarios"].items():
        assert all(r["goal"] == g for r in rs)
        assert all(r["spend_saturation"] is not None and r["data_source"] for r in rs)
    assert run["results"] == run["scenarios"]["transactions"]     # requested default view


def test_finalize_picks_a_goal_and_stamps_predictions_for_it_only(engine):
    _seed(engine)
    run_id, _ = bi.create_run(engine, "acme", goal="main_conv", budget=9000.0)
    final = bi.finalize_run(engine, "acme", run_id, goal="transactions")
    assert final["status"] == "final" and final["chosen_goal"] == "transactions"
    with engine.connect() as c:
        preds = c.execute(select(predictions.c.goal).where(predictions.c.run_id == run_id)).all()
    assert preds and all(g == "transactions" for (g,) in preds)
    # idempotent
    assert bi.finalize_run(engine, "acme", run_id)["status"] == "final"


def test_disagreements_flag_opposite_directions():
    scenarios = {
        "main_conv": [
            {"brand": "A", "region": "E", "category": "S", "lw_spend": 1000.0, "rec_spend": 1400.0},  # up
            {"brand": "A", "region": "W", "category": "S", "lw_spend": 1000.0, "rec_spend": 800.0},   # down
        ],
        "transactions": [
            {"brand": "A", "region": "E", "category": "S", "lw_spend": 1000.0, "rec_spend": 700.0},   # down (conflict)
            {"brand": "A", "region": "W", "category": "S", "lw_spend": 1000.0, "rec_spend": 900.0},   # down (agrees)
        ],
    }
    dis = bi._disagreements(scenarios)
    keys = {(d["brand"], d["region"], d["category"]) for d in dis}
    assert ("A", "E", "S") in keys and ("A", "W", "S") not in keys
    assert dis[0]["directions"] == {"main_conv": 1, "transactions": -1}
