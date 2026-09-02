#!/usr/bin/env python3
"""_latest_complete_month anchoring (engine/bundle/assemble).

The dashboard anchors the "current month" on the latest complete month, stepping back
when the export window ends mid-month. The current CALENDAR month is the exception: it
is expected to be month-to-date and must still be shown (otherwise a data set ending
Aug 30, viewed on Aug 31, silently hides all of August). A genuinely truncated PAST
month is still stepped over. Throwaway SQLite engine.
"""
import datetime

import pytest
from sqlalchemy import create_engine

from engine.ingest.store import metadata as store_md, uploads
from engine.bundle.assemble import _latest_complete_month

D = datetime.date
CID = "acme"


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


def set_window_end(engine, we):
    with engine.begin() as c:
        c.execute(uploads.insert().values(
            client_id=CID, report_type="campaign_performance", source_file="f.csv",
            window_raw="w", window_start=D(2025, 1, 1), window_end=we, row_count=1,
            uploaded_at=datetime.datetime(2026, 8, 31, tzinfo=datetime.timezone.utc)))


def test_current_month_shown_as_mtd(engine):
    """The reported bug: data through Aug 30, viewed on Aug 31 -> August must show."""
    set_window_end(engine, D(2026, 8, 30))
    cm = _latest_complete_month(engine, CID, today=D(2026, 8, 31))
    assert (cm["year"], cm["month"]) == (2026, 8)
    assert cm["full"] == "August 2026"


def test_full_current_month_shown(engine):
    """Window reaches the last day of the current month -> that month, unchanged."""
    set_window_end(engine, D(2026, 8, 31))
    cm = _latest_complete_month(engine, CID, today=D(2026, 8, 31))
    assert (cm["year"], cm["month"]) == (2026, 8)


def test_past_month_ending_mid_month_is_shown(engine):
    """Data ends Aug 30, viewed in September: August is the latest month with data and is
    shown as-is — NOT stepped back to July (the export just stopped a day short)."""
    set_window_end(engine, D(2026, 8, 30))
    cm = _latest_complete_month(engine, CID, today=D(2026, 9, 15))
    assert (cm["year"], cm["month"]) == (2026, 8)


def test_complete_past_month_unchanged(engine):
    """A full past month (ends on its last day) anchors on itself."""
    set_window_end(engine, D(2026, 7, 31))
    cm = _latest_complete_month(engine, CID, today=D(2026, 8, 15))
    assert (cm["year"], cm["month"]) == (2026, 7)


def test_no_step_back_across_year_boundary(engine):
    """A window ending mid-January anchors on January — never stepped back to December."""
    set_window_end(engine, D(2026, 1, 20))
    cm = _latest_complete_month(engine, CID, today=D(2026, 3, 1))
    assert (cm["year"], cm["month"]) == (2026, 1)


def test_no_uploads_returns_none(engine):
    assert _latest_complete_month(engine, CID, today=D(2026, 8, 31)) is None
