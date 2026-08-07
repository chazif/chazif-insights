#!/usr/bin/env python3
"""Merge-by-window ingestion tests (engine/ingest/load.replace_report).

A new upload must ADD to existing data, REPLACE the overlapping date window, and keep
Quality Score frozen. Runs on a throwaway SQLite engine (same dialect posture as dev).
See docs/INGEST_MERGE_DESIGN.md.
"""
import datetime

import pytest
from sqlalchemy import create_engine, select, func

from engine.ingest.store import metadata as store_md, raw_rows, uploads, qs_history
from engine.ingest.load import replace_report

D = datetime.date
CID = "acme"


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


def load(engine, rtype, rows, ws, we, date_col="day", order="ymd"):
    """Ingest one report via replace_report inside a transaction; returns rows written."""
    now = datetime.datetime.now(datetime.timezone.utc)
    with engine.begin() as conn:
        return replace_report(conn, CID, rtype, iter(rows), "f.csv",
                              f"{ws}..{we}", ws, we, now, date_col=date_col, order=order)


def camp(day, name, cost, clicks=10, conv=1):
    return {"day": day, "campaign": name, "cost": str(cost), "clicks": str(clicks), "conversions": str(conv)}


def dates(engine):
    with engine.connect() as c:
        return sorted(str(d) for d in c.execute(select(raw_rows.c.date_norm)
                      .where(raw_rows.c.report_type == "campaign_performance")).scalars() if d)


def rowcount(engine, rtype="campaign_performance"):
    with engine.connect() as c:
        return c.execute(select(func.count()).select_from(raw_rows)
                         .where(raw_rows.c.report_type == rtype)).scalar()


# --- dated reports: the core merge behaviour --------------------------------

def test_date_norm_parses(engine):
    load(engine, "campaign_performance", [camp("2026-06-15", "C1", 100)], D(2026, 6, 1), D(2026, 6, 30))
    assert dates(engine) == ["2026-06-15"]   # guards the fixture: dates must normalize


def test_append_preserves_non_overlapping_history(engine):
    load(engine, "campaign_performance", [camp("2026-06-10", "C1", 100)], D(2026, 6, 1), D(2026, 6, 30))
    load(engine, "campaign_performance", [camp("2026-07-10", "C1", 120)], D(2026, 7, 1), D(2026, 7, 31))
    assert dates(engine) == ["2026-06-10", "2026-07-10"]   # June survives the July upload


def test_overlapping_window_replaces(engine):
    # a two-month upload, then re-upload just July with different data
    load(engine, "campaign_performance",
         [camp("2026-06-10", "C1", 100), camp("2026-07-10", "C1", 100)], D(2026, 6, 1), D(2026, 7, 31))
    load(engine, "campaign_performance",
         [camp("2026-07-10", "C1", 999), camp("2026-07-20", "C1", 50)], D(2026, 7, 1), D(2026, 7, 31))
    assert dates(engine) == ["2026-06-10", "2026-07-10", "2026-07-20"]
    with engine.connect() as c:
        july = c.execute(select(raw_rows.c.cost).where(raw_rows.c.date_norm == D(2026, 7, 10))).scalars().all()
    assert july == [999.0]        # the old July-10 (100) was replaced, not duplicated


def test_idempotent_reupload(engine):
    rows = [camp("2026-06-10", "C1", 100), camp("2026-06-11", "C2", 80)]
    load(engine, "campaign_performance", rows, D(2026, 6, 1), D(2026, 6, 30))
    load(engine, "campaign_performance", rows, D(2026, 6, 1), D(2026, 6, 30))
    assert rowcount(engine) == 2   # re-uploading the same window is stable, not doubled


def test_empty_uploads_cleaned_up(engine):
    load(engine, "campaign_performance", [camp("2026-06-10", "C1", 100)], D(2026, 6, 1), D(2026, 6, 30))
    # fully-overlapping re-upload supersedes every row of the first upload
    load(engine, "campaign_performance", [camp("2026-06-10", "C1", 200)], D(2026, 6, 1), D(2026, 6, 30))
    with engine.connect() as c:
        n_uploads = c.execute(select(func.count()).select_from(uploads)
                              .where(uploads.c.report_type == "campaign_performance")).scalar()
    assert n_uploads == 1          # the emptied first upload was removed


def test_dated_supersedes_overlapping_undated_snapshot(engine):
    # first pulled without day-segmentation (undated snapshot), later re-pulled dated for
    # the same window — the stale whole-window snapshot must not linger beside the dated data
    load(engine, "campaign_performance", [camp(None, "C1", 100)], D(2026, 6, 1), D(2026, 6, 30), date_col=None)
    load(engine, "campaign_performance", [camp("2026-06-10", "C1", 100), camp("2026-06-20", "C1", 50)],
         D(2026, 6, 1), D(2026, 6, 30))
    with engine.connect() as c:
        n_undated = c.execute(select(func.count()).select_from(raw_rows)
                              .where((raw_rows.c.report_type == "campaign_performance")
                                     & raw_rows.c.date_norm.is_(None))).scalar()
    assert n_undated == 0            # the undated snapshot was superseded
    assert dates(engine) == ["2026-06-10", "2026-06-20"]


# --- undated snapshot reports: latest-wins ----------------------------------

def test_undated_report_latest_wins(engine):
    st = lambda term, cost: {"search_terms_match_type": "e", "search_term": term, "cost": str(cost), "clicks": "5"}
    load(engine, "search_terms", [st("cheap shoes", 10)], D(2026, 6, 1), D(2026, 6, 30), date_col=None)
    load(engine, "search_terms", [st("running shoes", 20)], D(2026, 7, 1), D(2026, 7, 31), date_col=None)
    assert rowcount(engine, "search_terms") == 1   # no accumulation of undated snapshots
    with engine.connect() as c:
        terms = c.execute(select(raw_rows.c.row).where(raw_rows.c.report_type == "search_terms")).scalars().all()
    assert "running shoes" in str(terms[0])


# --- Quality Score: frozen append-only, untouched by the merge --------------

def qs_row(kw, qs, day=None):
    r = {"search_keyword": kw, "search_keyword_match_type": "e", "campaign": "C1",
         "ad_group": "G1", "quality_score": str(qs)}
    if day:
        r["day"] = day
    return r


def qs_points(engine):
    with engine.connect() as c:
        return sorted((r.search_keyword, str(r.as_of_date), r.quality_score)
                      for r in c.execute(select(qs_history.c.search_keyword, qs_history.c.as_of_date,
                                                qs_history.c.quality_score)))


def test_qs_history_frozen_on_reupload(engine):
    # undated QS -> as_of = window_end; re-pull same date with a changed QS must NOT overwrite
    load(engine, "search_keyword_qs", [qs_row("shoes", 7)], D(2026, 6, 1), D(2026, 6, 30), date_col=None)
    load(engine, "search_keyword_qs", [qs_row("shoes", 9)], D(2026, 6, 1), D(2026, 6, 30), date_col=None)
    assert qs_points(engine) == [("shoes", "2026-06-30", 7.0)]   # first value frozen


def test_qs_history_accumulates_new_dates(engine):
    load(engine, "search_keyword_qs", [qs_row("shoes", 7)], D(2026, 6, 1), D(2026, 6, 30), date_col=None)
    load(engine, "search_keyword_qs", [qs_row("shoes", 9)], D(2026, 7, 1), D(2026, 7, 31), date_col=None)
    assert qs_points(engine) == [("shoes", "2026-06-30", 7.0), ("shoes", "2026-07-31", 9.0)]
