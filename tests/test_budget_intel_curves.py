#!/usr/bin/env python3
"""V2 per-campaign curves + spend-indexed canonical form + partial pooling
(PR bi-v2-curves, §6). Covers the three named acceptance tests plus curve-naming on
results. Pure-function math; one small service test for the resolve path.
"""
import json
from pathlib import Path

import pytest

from engine.budget_intel.model import MasterCurves
from engine.budget_intel.curves import (spend_curve_from_master, spend_curve_from_points,
                                         sum_curves, pool)

FIX = Path(__file__).resolve().parents[1] / "docs" / "budget-intel" / "fixtures"


def test_campaign_curves_sum_on_a_shared_grid():
    c1 = spend_curve_from_points([{"spend_week": 0, "conversions": 0},
                                  {"spend_week": 100, "conversions": 10},
                                  {"spend_week": 200, "conversions": 15}])
    c2 = spend_curve_from_points([{"spend_week": 0, "conversions": 0},
                                  {"spend_week": 100, "conversions": 20},
                                  {"spend_week": 200, "conversions": 30}])
    cell = sum_curves([c1, c2])
    for s in (50, 100, 150, 200):
        assert cell.conv_at(s) == pytest.approx(c1.conv_at(s) + c2.conv_at(s), abs=1e-6)
    assert cell.conv_at(100) == pytest.approx(30, abs=0.5)
    assert cell.max_spend == pytest.approx(200)


def test_partial_pooling_weight_moves_toward_account_as_points_vanish():
    cell = spend_curve_from_points([{"spend_week": 0, "conversions": 0},
                                    {"spend_week": 100, "conversions": 50}])   # steep
    account = spend_curve_from_points([{"spend_week": 0, "conversions": 0},
                                       {"spend_week": 100, "conversions": 10}])  # shallow
    thin, w_thin = pool(cell, account, n_points=1, k=8)     # w = 1/9
    thick, w_thick = pool(cell, account, n_points=80, k=8)  # w = 80/88
    assert w_thin == pytest.approx(1 / 9) and w_thick == pytest.approx(80 / 88)
    assert w_thin < w_thick
    s = 100
    # thin -> nearer the account fit; thick -> nearer the cell fit
    assert abs(thin.conv_at(s) - account.conv_at(s)) < abs(thin.conv_at(s) - cell.conv_at(s))
    assert abs(thick.conv_at(s) - cell.conv_at(s)) < abs(thick.conv_at(s) - account.conv_at(s))
    # n -> 0 collapses to the account fit exactly
    zero, w0 = pool(cell, account, n_points=0, k=8)
    assert w0 == 0.0 and zero.conv_at(s) == pytest.approx(account.conv_at(s), abs=1e-6)


def test_master_curve_converts_to_spend_table_and_reproduces_projections():
    p = json.loads((FIX / "curve_params.json").read_text())
    mc = MasterCurves.from_tables(p["master_tables"]["leads"], p["master_tables"]["cpl"])
    sc = spend_curve_from_master(mc)
    # reading conversions at spend(t) = cpl(t)·leads(t) reproduces leads(t) for every t
    for t in range(1, 101):
        spend_t = mc.cpl_at(t) * mc.leads_at(t)
        assert sc.conv_at(spend_t) == pytest.approx(mc.leads_at(t), abs=1e-6)


# ---- resolve path + curve naming on results --------------------------------
import datetime
from sqlalchemy import create_engine, insert, select
from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
from engine.budget_intel.tables import allocation_results
from engine.budget_intel.curves import fit_master_curves, save_fit

SIM = [
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
    with eng.begin() as conn:
        up = conn.execute(insert(uploads).values(
            client_id="acme", report_type="campaign_performance", row_count=2,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        for name, cost, conv, isshare in [("ACME_G_SRCH_EAST", 5000.0, 250.0, 0.35),
                                          ("ACME_G_SRCH_WEST", 3000.0, 120.0, 0.25)]:
            conn.execute(insert(raw_rows).values(
                client_id="acme", upload_id=up, report_type="campaign_performance",
                campaign=name, clicks=1000, impressions=40000, cost=cost, conversions=conv,
                row=json.dumps({"search_impr_share": isshare, "target_cpa": 18.0})))
    bi.upsert_mappings(eng, "acme", [
        {"campaign": "ACME_G_SRCH_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"},
        {"campaign": "ACME_G_SRCH_WEST", "brand": "ACME", "region": "WEST", "category": "SRCH"},
    ])
    bi.upsert_business_metrics(eng, "acme", [
        {"brand": "ACME", "region": "EAST", "category": "SRCH", "period_start": "2026-06-01",
         "revenue_per_conv": 400.0, "gp_pct": 0.8, "car_count": 200.0}])
    params, diag = fit_master_curves(SIM)
    save_fit(eng, "acme", params, diag, source="simulator")
    return eng


def test_results_name_their_curve_cell_vs_account(engine):
    # a per-campaign BUDGET simulation for EAST only -> that cell resolves to a pooled
    # cell curve; WEST (no campaign points) falls back to the account fit.
    bi.add_snapshot(engine, "acme", campaign="ACME_G_SRCH_EAST", sim_type="budget",
                    points=[{"spend_week": 1000, "leads_week": 40},
                            {"spend_week": 3000, "leads_week": 90},
                            {"spend_week": 6000, "leads_week": 120}])
    run_id, _ = bi.create_run(engine, "acme", goal="main_conv", budget=30000.0)
    with engine.connect() as c:
        rows = c.execute(select(allocation_results).where(
            (allocation_results.c.run_id == run_id)
            & (allocation_results.c.goal == "main_conv"))).mappings().all()
    by_region = {r["region"]: r["curve"] for r in rows}
    assert by_region["EAST"]["scope"] == "cell" and by_region["EAST"]["w"] > 0
    assert by_region["EAST"]["campaigns"] == 1
    assert by_region["WEST"]["scope"] == "account" and by_region["WEST"]["w"] == 0.0
