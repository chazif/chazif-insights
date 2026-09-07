#!/usr/bin/env python3
"""V2 explanatory signals + target-CPA compare (PR bi-v2-signals, §6). Covers: lost-IS
aggregation (eligible-impression weighted) with the display caution at IS-lost-to-rank ≥ 0.35,
and the budget-vs-target-CPA compare report. Throwaway SQLite; no network.
"""
import datetime
import json

import pytest
from sqlalchemy import create_engine, insert

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
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
    return eng


def _add(engine, cid, up, campaign, impr, is_share, lost_rank, lost_budget, cost=3000.0, conv=120.0):
    with engine.begin() as c:
        c.execute(insert(raw_rows).values(
            client_id=cid, upload_id=up, report_type="campaign_performance", campaign=campaign,
            clicks=1000, impressions=impr, cost=cost, conversions=conv,
            row=json.dumps({"search_impr_share": is_share, "target_cpa": 18.0,
                            "search_lost_is_rank": lost_rank, "search_lost_is_budget": lost_budget})))


def _curves(engine, cid):
    params, diag = fit_master_curves(SIM)
    save_fit(engine, cid, params, diag, source="simulator")


def test_lost_is_aggregates_eligible_weighted_and_cautions(engine):
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id="acme", report_type="campaign_performance", row_count=3,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
    # EAST: two campaigns -> eligible-weighted lost-to-rank
    #   A: impr 40000 / IS 0.40 = eligible 100000, lost_rank 0.60
    #   B: impr 10000 / IS 0.50 = eligible  20000, lost_rank 0.10
    #   weighted = (0.60*100000 + 0.10*20000) / 120000 = 0.51667
    _add(engine, "acme", up, "A_EAST", 40000, 0.40, 0.60, 0.20)
    _add(engine, "acme", up, "B_EAST", 10000, 0.50, 0.10, 0.05)
    _add(engine, "acme", up, "C_WEST", 30000, 0.35, 0.05, 0.10)   # low rank -> no caution
    bi.upsert_mappings(engine, "acme", [
        {"campaign": "A_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"},
        {"campaign": "B_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"},
        {"campaign": "C_WEST", "brand": "ACME", "region": "WEST", "category": "SRCH"},
    ])
    _curves(engine, "acme")

    cells = {c.key: c for c in bi.build_cells(engine, "acme")}
    east = cells[("ACME", "EAST", "SRCH")]
    assert east.is_lost_rank == pytest.approx(0.51667, abs=1e-4)
    assert east.is_lost_budget == pytest.approx((0.20 * 100000 + 0.05 * 20000) / 120000, abs=1e-4)

    run_id, _ = bi.create_run(engine, "acme", goal="main_conv", budget=30000.0)
    run = bi.get_run(engine, "acme", run_id)
    by = {r["region"]: r for r in run["scenarios"]["main_conv"]}
    assert by["EAST"]["is_lost_rank"] == pytest.approx(0.5167, abs=1e-3)
    assert "pair with the tCPA move" in by["EAST"]["caution"]      # ≥ 0.35 -> caution
    assert "caution" not in by["WEST"]                             # 0.05 -> none


def test_target_cpa_compare_report(engine):
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id="acme", report_type="campaign_performance", row_count=1,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
    _add(engine, "acme", up, "A_EAST", 40000, 0.35, 0.1, 0.1)
    bi.upsert_mappings(engine, "acme", [
        {"campaign": "A_EAST", "brand": "ACME", "region": "EAST", "category": "SRCH"}])
    _curves(engine, "acme")

    # no tCPA sim yet -> budget series present, tCPA empty
    rep = bi.simulations_compare(engine, "acme")
    assert rep["budget"] and rep["available"] is False and rep["target_cpa"] == []
    assert all(p["implied_cpa"] is not None for p in rep["budget"])

    # ingest a TARGET_CPA simulation (stored, not fit into the master curve)
    bi.add_snapshot(engine, "acme", campaign="A_EAST", sim_type="target_cpa",
                    points=[{"target_cpa": 20, "spend_week": 10000, "conversions": 500},
                            {"target_cpa": 30, "spend_week": 15000, "conversions": 600}])
    rep = bi.simulations_compare(engine, "acme")
    assert rep["available"] is True and len(rep["target_cpa"]) == 2
    assert rep["target_cpa"][0] == {"spend": 10000.0, "conversions": 500.0, "cpa": 20.0}
    # the budget curve exposes an implied CPA at each spend, for the side-by-side comparison
    assert rep["budget"][-1]["implied_cpa"] > 0
