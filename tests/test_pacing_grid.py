#!/usr/bin/env python3
"""Per-segment pacing board (engine/bundle/assemble._pacing_grid + _pacing_segments).

Covers the consistent-view design: one row for a non-segmented account, one row per segment
plus a Total when the budget is broken out, the budget-source cascade (allocation run →
budget lines → total → none), the daily-average pace math, window anchoring to the last day
with data, the unmapped bucket, and the daily-less fallback. Deterministic resolver +
throwaway SQLite engine; no network."""
import datetime

import pytest
from sqlalchemy import create_engine

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel.tables import metadata as bi_md, allocation_runs, allocation_results
from engine.mapping import Resolver
from engine.bundle.assemble import _pacing_grid, _pacing_segments

D = datetime.date
CID = "acme"
Y, MO, DIM = 2026, 10, 31           # October 2026 has 31 days
THROUGH = 7                          # data runs through Oct 7 -> elapsed 7, days_left 24


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    bi_md.create_all(eng)
    with eng.begin() as c:
        c.execute(uploads.insert().values(
            client_id=CID, report_type="campaign_performance", source_file="f.csv",
            window_raw="w", window_start=D(Y, MO, 1), window_end=D(Y, MO, THROUGH), row_count=1,
            uploaded_at=datetime.datetime(2026, 10, 8, tzinfo=datetime.timezone.utc)))
    return eng


def add_day(engine, campaign, day, cost, dated=True):
    """One campaign_performance row for Oct <day>, 2026. `dated=False` omits date_norm (to
    exercise the month-total fallback) while keeping the parseable `date` string."""
    iso = f"{Y}-{MO:02d}-{day:02d}"
    with engine.begin() as c:
        c.execute(raw_rows.insert().values(
            client_id=CID, upload_id=1, report_type="campaign_performance", row_index=0,
            campaign=campaign, date=iso, date_norm=(D(Y, MO, day) if dated else None),
            cost=cost, clicks=0, impressions=0, conversions=0,
            row={"campaign": campaign, "cost": cost}))


def res_for(mappings, config=None):
    return Resolver(mappings, config or {})


# ---- cascade ----------------------------------------------------------------

def test_segments_cascade_prefers_allocation_run(engine):
    """Allocation run wins over budget lines; both present."""
    with engine.begin() as c:
        c.execute(allocation_runs.insert().values(id=1, client_id=CID, budget=9300, status="final"))
        c.execute(allocation_results.insert().values(run_id=1, brand="MAVIS", region="New York", category="Search", rec_spend=3100))
        c.execute(allocation_results.insert().values(run_id=1, brand="MAVIS", region="New Jersey", category="Search", rec_spend=6200))
    cfg = {"budget_lines": [{"region": "New York", "category": "Search", "monthly": 1}]}
    segs, source, segmented = _pacing_segments(engine, CID, cfg)
    assert source == "allocation" and segmented is True
    assert {s["budget"] for s in segs} == {3100.0, 6200.0}


def test_segments_cascade_budget_lines_then_total_then_none(engine):
    lines = {"budget_lines": [{"region": "NY", "category": "Search", "monthly": 500},
                              {"region": "NJ", "category": "Search", "monthly": 700}]}
    segs, source, segmented = _pacing_segments(engine, CID, lines)
    assert source == "lines" and segmented is True and len(segs) == 2

    segs, source, segmented = _pacing_segments(engine, CID, {"thresholds": {"monthly_budget": 3000}})
    assert source == "total" and segmented is False and len(segs) == 1 and segs[0]["budget"] == 3000.0

    segs, source, segmented = _pacing_segments(engine, CID, {})
    assert source == "none" and segmented is False and segs[0]["budget"] is None


# ---- the board --------------------------------------------------------------

def test_single_row_account_pacing(engine):
    """Non-segmented account: one 'whole account' row, no Total, MTD vs daily-avg pace."""
    for day in range(1, THROUGH + 1):
        add_day(engine, "Brand Search", day, 100.0)     # $100/day, budget 3100 -> daily 100
    g = _pacing_grid(engine, CID, {"thresholds": {"monthly_budget": 3100}}, res_for([]))
    assert g["segmented"] is False and g["totals"] is None
    assert len(g["rows"]) == 1
    r = g["rows"][0]
    assert r["label"] == "Whole account"
    assert r["daily_budget"] == 100.0 and g["days_in_month"] == 31
    assert g["elapsed"] == 7 and g["days_left"] == 24 and g["data_through"] == f"{Y}-{MO:02d}-07"
    assert r["mtd"]["spend"] == 700.0 and r["mtd"]["expected"] == 700.0 and r["mtd"]["diff"] == 0.0
    assert r["yesterday"]["spend"] == 100.0 and r["last3"]["spend"] == 300.0 and r["last7"]["spend"] == 700.0
    assert r["rest"]["left"] == 2400.0 and r["rest"]["daily_sugg"] == 100.0    # 2400 / 24
    assert len(g["calendar"]) == 31 and len(r["days"]) == 7


def test_multi_row_with_total_and_pace_diffs(engine):
    mappings = [{"campaign": "NY Search", "region": "New York", "category": "Search"},
                {"campaign": "NJ Search", "region": "New Jersey", "category": "Search"}]
    cfg = {"budget_lines": [{"region": "New York", "category": "Search", "monthly": 3100},
                            {"region": "New Jersey", "category": "Search", "monthly": 6200}]}
    for day in range(1, THROUGH + 1):
        add_day(engine, "NY Search", day, 100.0)        # on pace: 700 vs 700
        add_day(engine, "NJ Search", day, 150.0)        # under: 1050 vs 1400
    g = _pacing_grid(engine, CID, cfg, res_for(mappings))
    assert g["segmented"] is True and g["source"] == "lines"
    by = {r["label"]: r for r in g["rows"]}
    ny, nj = by["New York · Search"], by["New Jersey · Search"]
    assert ny["mtd"]["diff"] == 0.0 and ny["mtd"]["status"] == "on-track"
    assert nj["daily_budget"] == 200.0 and nj["mtd"]["expected"] == 1400.0
    assert nj["mtd"]["diff"] == -350.0 and nj["mtd"]["status"] == "under"
    assert nj["last7"]["spend"] == 1050.0 and nj["yesterday"]["spend"] == 150.0
    # Total row reconciles.
    assert g["totals"]["month_budget"] == 9300.0 and g["totals"]["mtd"]["spend"] == 1750.0


def test_unmapped_campaign_bucket(engine):
    """A campaign that matches no budget segment lands in an (unmapped) row, so totals foot."""
    mappings = [{"campaign": "NY Search", "region": "New York", "category": "Search"},
                {"campaign": "Rogue", "region": "Nevada", "category": "Display"}]
    cfg = {"budget_lines": [{"region": "New York", "category": "Search", "monthly": 3100}]}
    for day in range(1, THROUGH + 1):
        add_day(engine, "NY Search", day, 100.0)
        add_day(engine, "Rogue", day, 20.0)
    g = _pacing_grid(engine, CID, cfg, res_for(mappings))
    labels = {r["label"] for r in g["rows"]}
    assert "(unmapped)" in labels
    unmapped = next(r for r in g["rows"] if r["label"] == "(unmapped)")
    assert unmapped["month_budget"] is None and unmapped["mtd"]["spend"] == 140.0   # 7 × 20
    assert g["totals"]["mtd"]["spend"] == 840.0                                     # 700 + 140


def test_daily_less_fallback_shows_month_total_no_windows(engine):
    """No day-level dates: calendar + short windows drop out, MTD falls back to the month total."""
    for day in range(1, THROUGH + 1):
        add_day(engine, "Brand Search", day, 100.0, dated=False)   # date string only, no date_norm
    g = _pacing_grid(engine, CID, {"thresholds": {"monthly_budget": 3100}}, res_for([]))
    assert g["has_daily"] is False
    r = g["rows"][0]
    assert r["mtd"]["spend"] == 700.0 and r["yesterday"] is None and r["days"] == []
    assert r["rest"]["left"] == 2400.0


def test_none_when_no_campaign_data(engine):
    assert _pacing_grid(engine, CID, {"thresholds": {"monthly_budget": 3000}}, res_for([])) is None
