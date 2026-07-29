#!/usr/bin/env python3
"""Service-layer tests for Budget Intelligence: mappings, metrics, curve fits,
run persistence, client isolation, and the unmapped-campaign guard.
Runs on a throwaway SQLite engine (same dialect posture as local dev)."""
import datetime
import json

import pytest
from sqlalchemy import create_engine, insert

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
from engine.budget_intel.curves import fit_master_curves, save_fit, get_active_curves


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    bi_tables.init_db(eng)
    return eng


def _seed_campaigns(engine, client_id, campaigns):
    """campaigns: [(name, cost, impr, clicks, conv, is_share, tcpa)]"""
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id=client_id, report_type="campaign_performance",
            row_count=len(campaigns),
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        for name, cost, impr, clicks, conv, is_share, tcpa in campaigns:
            c.execute(insert(raw_rows).values(
                client_id=client_id, upload_id=up,
                report_type="campaign_performance", campaign=name,
                clicks=clicks, impressions=impr, cost=cost, conversions=conv,
                row=json.dumps({"search_impr_share": is_share,
                                "target_cpa": tcpa})))


SIM_POINTS = [
    {"is_share": 0.15, "spend_week": 20912, "leads_week": 1754},
    {"is_share": 0.20, "spend_week": 23242, "leads_week": 2664},
    {"is_share": 0.25, "spend_week": 25582, "leads_week": 3563},
    {"is_share": 0.30, "spend_week": 28292, "leads_week": 4351},
    {"is_share": 0.35, "spend_week": 31852, "leads_week": 4873},
    {"is_share": 0.40, "spend_week": 35602, "leads_week": 5314},
]


def _setup_client(engine, cid="acme"):
    _seed_campaigns(engine, cid, [
        ("ACME_G_SRCH_EAST", 5000.0, 40000, 2500, 250.0, 0.35, 18.0),
        ("ACME_G_SRCH_WEST", 3000.0, 30000, 1500, 120.0, 0.25, 20.0),
    ])
    bi.upsert_mappings(engine, cid, [
        {"campaign": "ACME_G_SRCH_EAST", "brand": "ACME", "region": "EAST",
         "category": "SRCH"},
        {"campaign": "ACME_G_SRCH_WEST", "brand": "ACME", "region": "WEST",
         "category": "SRCH"},
    ])
    bi.upsert_business_metrics(engine, cid, [
        {"brand": "ACME", "region": "EAST", "category": "SRCH",
         "period_start": "2026-07-01", "revenue_per_conv": 400.0,
         "gp_pct": 0.8, "car_count": 200.0},
        {"brand": "ACME", "region": "WEST", "category": "SRCH",
         "period_start": "2026-07-01", "revenue_per_conv": 380.0,
         "gp_pct": 0.75, "car_count": 100.0},
    ])
    params, diag = fit_master_curves(SIM_POINTS)
    save_fit(engine, cid, params, diag, source="simulator")


def test_unmapped_campaigns_block_runs(engine):
    _seed_campaigns(engine, "acme", [("ACME_G_SRCH_EAST", 100.0, 1000, 50, 5.0, 0.3, 10.0)])
    assert bi.unmapped_campaigns(engine, "acme") == ["ACME_G_SRCH_EAST"]
    with pytest.raises(ValueError, match="unmapped campaigns"):
        bi.create_run(engine, "acme", goal="car_count", budget=1000.0)


def test_suggest_mapping_parses_convention():
    s = bi.suggest_mapping("BP_G_PMX_ARIZONA")
    assert (s["brand"], s["engine"], s["camp_type"], s["region"]) == \
        ("BP", "G", "PMX", "ARIZONA")


def test_end_to_end_csv_mode_run(engine):
    """Acceptance: a CSV-mode client with pasted simulator points and business
    metrics runs end-to-end with no API dependency."""
    _setup_client(engine)
    cells = bi.build_cells(engine, "acme")
    assert len(cells) == 2
    east = next(c for c in cells if c.region == "EAST")
    assert east.cost == 5000.0 and east.main_conv == 250.0
    assert east.is_current == 35
    assert east.tcpa == pytest.approx(18.0)
    assert east.cost_per_car == pytest.approx(25.0)      # 5000 / 200 cars

    run_id, results = bi.create_run(engine, "acme", goal="car_count",
                                    budget=9000.0, created_by="test")
    assert len(results) == 2
    run = bi.get_run(engine, "acme", run_id)
    assert run["status"] == "draft" and len(run["results"]) == 2
    total = sum(r["rec_spend"] for r in run["results"])
    assert total <= 9000.0 + 1e-6

    final = bi.finalize_run(engine, "acme", run_id)
    assert final["status"] == "final"
    # finalize is idempotent
    assert bi.finalize_run(engine, "acme", run_id)["status"] == "final"


def test_max_change_guard(engine):
    _setup_client(engine)
    _, results = bi.create_run(engine, "acme", goal="car_count", budget=50000.0,
                               run_params={"max_change_pct": 0.30})
    for r in results:
        assert r["rec_spend"] <= r["lw_spend"] * 1.30 + 1e-6
        assert r["rec_spend"] >= r["lw_spend"] * 0.70 - 1e-6


def test_client_isolation(engine):
    """Acceptance: two seeded clients never see each other's data."""
    _setup_client(engine, "acme")
    _seed_campaigns(engine, "zed", [("ZED_G_SRCH_N", 700.0, 9000, 400, 30.0, 0.2, 9.0)])
    assert bi.unmapped_campaigns(engine, "zed") == ["ZED_G_SRCH_N"]
    assert bi.get_mappings(engine, "zed") == []
    assert bi.get_business_metrics(engine, "zed") == []
    with pytest.raises(LookupError, match="no active curve fit"):
        get_active_curves(engine, "zed")
    run_id, _ = bi.create_run(engine, "acme", goal="gp", budget=5000.0)
    assert bi.list_runs(engine, "zed") == []
    assert bi.get_run(engine, "zed", run_id) is None


def test_fit_quality_on_simulator_points():
    params, diag = fit_master_curves(SIM_POINTS)
    assert diag["n_points"] == 6
    assert diag["r2_leads"] > 0.98
    assert diag["r2_cpl"] > 0.90
    lp = params["leads"]
    assert 0 < lp["x0"] < 100 and lp["k"] > 0


def test_detects_new_report_types():
    from engine.ingest.parser import detect_report
    assert detect_report(["date", "bid_strategy", "bid_strategy_type",
                          "target_cpa"]) == "bid_strategies"
    assert detect_report(["dates", "campaign", "cost", "impr",
                          "search_impr_share", "clicks"]) == "campaign_performance"
    # existing detection unaffected
    assert detect_report(["campaign", "campaign_type", "cost"]) == "campaign_performance"
    assert detect_report(["search_term", "cost"]) == "search_terms"
