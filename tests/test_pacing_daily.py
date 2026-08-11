#!/usr/bin/env python3
"""Daily budget-pacing builder tests: cumulative target vs actual, run-rate projection,
data-through (never calendar-today), gap days, and graceful fallbacks.
Throwaway SQLite, same dialect posture as dev."""
import datetime

import pytest
from sqlalchemy import create_engine, insert

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.bundle.assemble import _pacing_daily


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


def _seed(engine, client_id, day_costs):
    """day_costs: {date -> cost} for campaign_performance rows with date_norm."""
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id=client_id, report_type="campaign_performance", row_count=len(day_costs),
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        for d, cost in day_costs.items():
            c.execute(insert(raw_rows).values(
                client_id=client_id, upload_id=up, report_type="campaign_performance",
                campaign="C", cost=cost, date_norm=d, row={}))


CFG = {"thresholds": {"monthly_budget": 3100}}   # $100/day flat over a 31-day month


def test_daily_pacing_cumulative_and_projection(engine):
    # 10 days of data at $100/day in a 31-day month -> exactly on target, projects to budget.
    days = {datetime.date(2026, 8, d): 100.0 for d in range(1, 11)}
    _seed(engine, "acme", days)
    out = _pacing_daily(engine, "acme", CFG)
    assert out["month"] == "Aug 2026" and out["daily_budget"] == 100.0 and out["days_in_month"] == 31
    assert out["data_through"] == "2026-08-10" and out["days_with_data"] == 10
    assert out["mtd_spend"] == 1000.0 and out["mtd_target"] == 1000.0
    assert out["pace_pct"] == 1.0 and out["status"] == "on-track"
    assert out["projection"]["spend"] == 3100.0 and out["projection"]["status"] == "on-track"
    assert len(out["days"]) == 10 and out["days"][-1]["cum_target"] == 1000.0


def test_overpacing_projects_over(engine):
    days = {datetime.date(2026, 8, d): 150.0 for d in range(1, 11)}   # 50% hot
    _seed(engine, "acme", days)
    out = _pacing_daily(engine, "acme", CFG)
    assert out["pace_pct"] == 1.5 and out["status"] == "over"
    assert out["projection"]["spend"] == pytest.approx(4650.0)      # 1500/10*31
    assert out["projection"]["status"] == "over"


def test_data_through_not_calendar_today(engine):
    # Spend is on target for the days we HAVE — a short/stale upload must not read as under.
    days = {datetime.date(2026, 8, d): 100.0 for d in range(1, 6)}   # only 5 days uploaded
    _seed(engine, "acme", days)
    out = _pacing_daily(engine, "acme", CFG)
    assert out["data_through"] == "2026-08-05" and out["pace_pct"] == 1.0 and out["status"] == "on-track"


def test_latest_month_wins_and_months_available(engine):
    _seed(engine, "acme", {**{datetime.date(2026, 7, d): 100.0 for d in range(1, 6)},
                           **{datetime.date(2026, 8, d): 100.0 for d in range(1, 4)}})
    out = _pacing_daily(engine, "acme", CFG)
    assert out["month"] == "Aug 2026" and out["days_with_data"] == 3
    assert out["months_available"][0] == "Aug 2026" and "Jul 2026" in out["months_available"]


def test_no_budget_or_no_daily_returns_none(engine):
    _seed(engine, "acme", {datetime.date(2026, 8, 1): 100.0})
    assert _pacing_daily(engine, "acme", {}) is None                 # no budget
    with engine.begin() as c:                                        # dateless client
        up = c.execute(insert(uploads).values(client_id="b", report_type="campaign_performance",
                                              row_count=1, uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        c.execute(insert(raw_rows).values(client_id="b", upload_id=up,
                                          report_type="campaign_performance", campaign="C", cost=50.0, row={}))
    assert _pacing_daily(engine, "b", CFG) is None                   # no date_norm anywhere
