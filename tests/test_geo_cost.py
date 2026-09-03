#!/usr/bin/env python3
"""_geo cost sourcing (engine/bundle/assemble._geo).

A Geographic export that carries a real Cost column must report that cost verbatim —
including a region with clicks but zero conversions (which the old derived path, Cost/conv
× conversions, silently reported as $0). Older exports with no Cost column still fall back
to the derived value. Throwaway SQLite engine.
"""
import datetime

import pytest
from sqlalchemy import create_engine

from engine.ingest.store import metadata as store_md, raw_rows
from engine.bundle.assemble import _geo

D = datetime.date
CID = "acme"


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


def add_geo(engine, entity, clicks, impr, cost, conv, cost_conv):
    """Insert one geographic raw row. `cost` is the typed Cost column (None = export had
    no Cost column); `cost_conv` lives in the full row JSON as the derived fallback source."""
    with engine.begin() as c:
        c.execute(raw_rows.insert().values(
            client_id=CID, upload_id=1, report_type="geographic", row_index=0,
            entity=entity, date_norm=D(2026, 8, 15), clicks=clicks, impressions=impr,
            cost=cost, conversions=conv, conv_value=0.0,
            row={"state_matched": entity, "clicks": clicks, "impressions": impr,
                 "cost": cost, "conversions": conv, "cost_conv": cost_conv}))


def test_real_cost_column_used_even_with_zero_conversions(engine):
    """The reported bug: Montana has clicks but 0 conversions. With a real Cost column the
    derived path would show $0; the real column must report the actual spend."""
    add_geo(engine, "Montana", clicks=2, impr=40, cost=7.50, conv=0, cost_conv=0)
    add_geo(engine, "New York", clicks=100, impr=2000, cost=250.0, conv=10, cost_conv=25.0)
    g = _geo(engine, CID)
    by_loc = {r["location"]: r for r in g["rows"]}
    assert by_loc["Montana"]["cost"] == 7.50          # not $0
    assert by_loc["New York"]["cost"] == 250.0
    assert g["totals"]["cost"] == 257.50


def test_falls_back_to_derived_when_no_cost_column(engine):
    """Older export with no Cost column (typed cost is 0/None everywhere): derive cost as
    Cost/conv × conversions, as before."""
    add_geo(engine, "Ohio", clicks=50, impr=1000, cost=None, conv=4, cost_conv=30.0)
    g = _geo(engine, CID)
    ohio = next(r for r in g["rows"] if r["location"] == "Ohio")
    assert ohio["cost"] == 120.0                       # 30 * 4


def test_none_when_no_geo_rows(engine):
    assert _geo(engine, CID) is None
