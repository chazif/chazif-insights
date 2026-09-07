#!/usr/bin/env python3
"""KPI scorecard projection (engine/bundle/assemble.build_bundle).

The scorecard gains a run-rate 'Projected' full-month total for the current (open) month:
additive metrics scale by days-in-month ÷ days-elapsed, CPA/CVR hold at the current rate.
It appears only for a partial current month in a whole-month view (not a day-range, not a
complete month). Throwaway SQLite engine; no network."""
import datetime

import pytest
from sqlalchemy import create_engine

from engine.ingest.store import metadata as store_md, raw_rows, uploads, clients
from engine.bundle.assemble import build_bundle

D = datetime.date
CID = "acme"


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    with eng.begin() as c:
        c.execute(clients.insert().values(client_id=CID, name="Acme", created_at=datetime.datetime.now(datetime.timezone.utc)))
    return eng


def add(engine, day, cost, clicks, conv):
    with engine.begin() as c:
        c.execute(raw_rows.insert().values(
            client_id=CID, upload_id=1, report_type="campaign_performance", row_index=0,
            campaign="Brand Search", date=day.isoformat(), date_norm=day,
            cost=cost, clicks=clicks, impressions=clicks * 20, conversions=conv,
            row={"campaign": "Brand Search", "cost": cost}))


def seed(engine, window_end):
    with engine.begin() as c:
        c.execute(uploads.insert().values(
            client_id=CID, report_type="campaign_performance", source_file="f",
            window_raw="w", window_start=D(2026, 8, 1), window_end=window_end, row_count=1,
            uploaded_at=datetime.datetime.now(datetime.timezone.utc)))


def kpi(bundle, metric):
    return next(k for k in bundle["kpis"] if k["Metric"] == metric)


def test_projection_for_partial_current_month(engine):
    """Sep runs through the 6th of 30 days -> ×5. Additive metrics scale; ratios hold."""
    seed(engine, D(2026, 9, 6))
    for d in range(1, 32):
        add(engine, D(2026, 8, d), 100.0, 100, 5.0)     # Aug full: 3100 / 155 conv
    for d in range(1, 7):
        add(engine, D(2026, 9, d), 90.0, 100, 4.0)      # Sep partial: 540 / 24 conv
    b = build_bundle(CID, engine=engine, compare="mom")
    assert b["meta"]["periods"]["current"] == "Sep 2026"
    assert kpi(b, "Total Spend")["Projected"] == 2700.0        # 540 × 30/6
    assert kpi(b, "Main Conversions")["Projected"] == 120.0    # 24 × 5
    assert kpi(b, "CPA (Main Conv)")["Projected"] == 22.5      # ratio holds (540/24)
    assert kpi(b, "CVR (Main Conv)")["Projected"] == 0.04      # ratio holds (24/600)


def test_no_projection_for_complete_month(engine):
    """A month whose data reaches its last day has nothing to project -> Projected is None."""
    seed(engine, D(2026, 8, 31))
    for d in range(1, 32):
        add(engine, D(2026, 8, d), 100.0, 100, 5.0)
    b = build_bundle(CID, engine=engine, compare="mom")
    assert kpi(b, "Total Spend")["Projected"] is None


def test_no_projection_for_day_range_selection(engine):
    """A day-range selection has no 'current month' to project -> Projected is None."""
    seed(engine, D(2026, 9, 6))
    for d in range(1, 32):
        add(engine, D(2026, 8, d), 100.0, 100, 5.0)
    for d in range(1, 7):
        add(engine, D(2026, 9, d), 90.0, 100, 4.0)
    b = build_bundle(CID, engine=engine, date_from="2026-09-01", date_to="2026-09-06", compare="mom")
    assert kpi(b, "Total Spend")["Projected"] is None
