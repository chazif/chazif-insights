#!/usr/bin/env python3
"""V2 guard, held-back accounting, override, reference period (PR bi-v2-guard, §5).

Covers: guard-band hierarchy resolution (most-specific wins, default 0.30), held-back
reconciling exactly to Σ proposed − Σ shipped, the audited override, and reference-period
exclusion changing the actuals. Throwaway SQLite; no network.
"""
import datetime
import json

import pytest
from sqlalchemy import create_engine, insert, select

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi
from engine.budget_intel.tables import allocation_results
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


def _seed(engine, cid="acme", dated=False):
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id=cid, report_type="campaign_performance", row_count=2,
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        campaigns = [
            ("ACME_G_SRCH_EAST", 40000, 2500, 0.35, 18.0),
            ("ACME_G_SRCH_WEST", 30000, 1500, 0.25, 20.0),
        ]
        if dated:
            # split each campaign's week across 3 days so a day can be excluded
            for name, impr, clicks, is_share, tcpa in campaigns:
                for day, cost, conv in [(1, 2000.0, 100.0), (2, 1500.0, 80.0), (3, 1500.0, 70.0)]:
                    c.execute(insert(raw_rows).values(
                        client_id=cid, upload_id=up, report_type="campaign_performance",
                        campaign=name, clicks=clicks // 3, impressions=impr // 3, cost=cost,
                        conversions=conv, date_norm=datetime.date(2026, 6, day),
                        row=json.dumps({"search_impr_share": is_share, "target_cpa": tcpa})))
        else:
            for name, impr, clicks, is_share, tcpa in campaigns:
                cost = 5000.0 if "EAST" in name else 3000.0
                conv = 250.0 if "EAST" in name else 120.0
                c.execute(insert(raw_rows).values(
                    client_id=cid, upload_id=up, report_type="campaign_performance",
                    campaign=name, clicks=clicks, impressions=impr, cost=cost, conversions=conv,
                    row=json.dumps({"search_impr_share": is_share, "target_cpa": tcpa})))
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


def test_guard_band_hierarchy_most_specific_wins():
    rows = [
        {"brand": "", "region": "", "category": "", "max_change_pct": 0.10},        # client
        {"brand": "ACME", "region": "", "category": "", "max_change_pct": 0.20},     # brand
        {"brand": "", "region": "EAST", "category": "", "max_change_pct": 0.30},      # region
        {"brand": "", "region": "", "category": "SRCH", "max_change_pct": 0.40},      # category
    ]
    assert bi.resolve_guard_band(rows, "ACME", "EAST", "SRCH") == 0.40   # category
    assert bi.resolve_guard_band(rows, "ACME", "EAST", "PMAX") == 0.30   # region
    assert bi.resolve_guard_band(rows, "ACME", "WEST", "PMAX") == 0.20   # brand
    assert bi.resolve_guard_band(rows, "ZED", "WEST", "PMAX") == 0.10    # client
    assert bi.resolve_guard_band([], "ZED", "WEST", "PMAX") == 0.30      # default


def test_replace_guard_config_is_full_set(engine):
    """The editor's PUT replaces the whole rule set — removed rows are deleted, not kept."""
    bi.upsert_guard_config(engine, "acme", [
        {"region": "EAST", "max_change_pct": 0.15}, {"brand": "ACME", "max_change_pct": 0.20}])
    assert len(bi.get_guard_config(engine, "acme")) == 2
    bi.replace_guard_config(engine, "acme", [{"category": "SRCH", "max_change_pct": 0.5}])
    rules = bi.get_guard_config(engine, "acme")
    assert len(rules) == 1 and rules[0]["category"] == "SRCH" and rules[0]["max_change_pct"] == 0.5


def test_held_back_reconciles_to_proposed_minus_shipped(engine):
    _seed(engine)
    bi.upsert_guard_config(engine, "acme", [{"max_change_pct": 0.05}])   # tight -> clamps
    run_id, _ = bi.create_run(engine, "acme", goal="transactions", budget=50000.0)
    run = bi.get_run(engine, "acme", run_id)
    for g, rs in run["scenarios"].items():
        total_hb = sum(r["held_back"] for r in rs)
        assert total_hb == pytest.approx(sum(r["proposed_spend"] - r["rec_spend"] for r in rs))
        assert run["held_back_total"][g] == pytest.approx(round(total_hb, 2))
        for r in rs:                                     # band respected + weeks-to-target present
            assert r["guard_band_pct"] == 0.05
            assert r["rec_spend"] <= r["lw_spend"] * 1.05 + 1e-6
            assert r["rec_spend"] >= r["lw_spend"] * 0.95 - 1e-6
    # something was actually held back somewhere
    assert any(abs(r["held_back"]) > 1e-6 for rs in run["scenarios"].values() for r in rs)


def test_override_is_recorded_and_reflected(engine):
    _seed(engine)
    bi.upsert_guard_config(engine, "acme", [{"max_change_pct": 0.05}])
    run_id, _ = bi.create_run(engine, "acme", goal="transactions", budget=50000.0)
    out = bi.override_run(engine, "acme", run_id, cell_key=("ACME", "EAST", "SRCH"),
                          spend=9999.0, reason="launch push", actor="jane", goal="transactions")
    assert out["rec_spend"] == 9999.0
    with engine.connect() as c:
        row = c.execute(select(allocation_results).where(
            (allocation_results.c.run_id == run_id) & (allocation_results.c.goal == "transactions")
            & (allocation_results.c.brand == "ACME") & (allocation_results.c.region == "EAST"))).mappings().first()
    assert row["rec_spend"] == 9999.0
    run = bi.get_run(engine, "acme", run_id)
    ov = run["params"]["overrides"]
    assert len(ov) == 1 and ov[0]["actor"] == "jane" and ov[0]["reason"] == "launch push"
    # never silent
    with pytest.raises(ValueError):
        bi.override_run(engine, "acme", run_id, ("ACME", "EAST", "SRCH"), 100.0, reason="", actor="")


def test_reference_period_exclusion_changes_actuals(engine):
    _seed(engine, dated=True)
    full = {c.key: c.cost for c in bi.build_cells(engine, "acme")}
    windowed = {c.key: c.cost for c in bi.build_cells(
        engine, "acme", reference={"mode": "week", "period_start": "2026-06-01", "weeks": 1,
                                   "exclude": ["2026-06-02"]})}
    east = ("ACME", "EAST", "SRCH")
    assert windowed[east] < full[east]                   # excluding a day lowers the actuals
    assert windowed[east] == pytest.approx(2000.0 + 1500.0)   # days 1 + 3 (day 2 excluded)
