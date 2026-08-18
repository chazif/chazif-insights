#!/usr/bin/env python3
"""Google Ads API auto-pull tests: rolling window (first-of-last-month), API-row -> parser-row
conversion, GAQL building, row flattening, and an end-to-end sync through the real
merge-by-window loader with a fake API client (no google-ads library, no credentials needed)."""
import datetime
import types

import pytest
from sqlalchemy import create_engine, select

from engine.ingest.store import metadata as store_md, raw_rows
from engine.ingest import service
from engine.adsapi.window import pull_window
from engine.adsapi.reports import convert_row, build_query, SPECS_BY_TYPE, _conv
from engine.adsapi import client as api_client
from engine.adsapi.sync import sync_client


# --- window: first day of LAST month -> today -------------------------------------------
def test_pull_window_first_of_last_month():
    assert pull_window(datetime.date(2026, 9, 15)) == (datetime.date(2026, 8, 1), datetime.date(2026, 9, 15))
    # first day of the month still reaches back a full month
    assert pull_window(datetime.date(2026, 9, 1)) == (datetime.date(2026, 8, 1), datetime.date(2026, 9, 1))
    # crosses the year boundary
    assert pull_window(datetime.date(2026, 1, 3)) == (datetime.date(2025, 12, 1), datetime.date(2026, 1, 3))
    # end of month
    assert pull_window(datetime.date(2026, 3, 31)) == (datetime.date(2026, 2, 1), datetime.date(2026, 3, 31))


# --- value coercion: API primitive -> parser string form --------------------------------
def test_conv_kinds():
    assert _conv("micros", 12_340_000) == "12.34"      # cost_micros -> dollars
    assert _conv("micros", 100_000_000) == "100"
    assert _conv("share", 0.3478) == "34.78"           # API fraction -> percent string
    assert _conv("int", 42) == "42"
    assert _conv("num", 3.0) == "3"
    assert _conv("num", 12.5) == "12.5"
    assert _conv("channel", "PERFORMANCE_MAX") == "Performance Max"
    assert _conv("enum_title", "EXACT") == "Exact"
    assert _conv("enum", "ABOVE_AVERAGE") == "ABOVE_AVERAGE"   # QS label kept raw
    assert _conv("text", "  Brand  ") == "Brand"
    assert _conv("text", None) is None and _conv("micros", None) is None


def test_share_survives_roundtrip_through_loader():
    # the loader re-parses our percent string with impr_share_frac (which divides by 100)
    from engine.ingest.parser import impr_share_frac
    assert impr_share_frac(_conv("share", 0.3478)) == pytest.approx(0.3478)


def test_convert_row_campaign():
    spec = SPECS_BY_TYPE["campaign_performance"]
    flat = {"campaign.name": "Brand - Exact", "campaign.advertising_channel_type": "SEARCH",
            "metrics.clicks": 120, "metrics.impressions": 3400, "metrics.cost_micros": 45_600_000,
            "metrics.conversions": 8.0, "metrics.conversions_value": 950.0,
            "metrics.search_impression_share": 0.62, "segments.date": "2026-08-03"}
    row = convert_row(spec, flat)
    assert row["campaign"] == "Brand - Exact" and row["campaign_type"] == "Search"
    assert row["clicks"] == "120" and row["impr"] == "3400" and row["cost"] == "45.6"
    assert row["conversions"] == "8" and row["conv_value"] == "950"
    assert row["search_impr_share"] == "62" and row["date"] == "2026-08-03"


def test_build_query_has_window_and_paths():
    spec = SPECS_BY_TYPE["account_spend"]
    q = build_query(spec, datetime.date(2026, 8, 1), datetime.date(2026, 9, 15))
    assert q.startswith("SELECT customer.descriptive_name")
    assert "FROM customer" in q
    assert "segments.date BETWEEN '2026-08-01' AND '2026-09-15'" in q


# --- client flattening: nested proto-ish object + enum -> {path: primitive} -------------
def test_flatten_and_enum_name():
    enum = types.SimpleNamespace(name="SHOPPING")
    row = types.SimpleNamespace(
        campaign=types.SimpleNamespace(name="Shop All", advertising_channel_type=enum),
        metrics=types.SimpleNamespace(cost_micros=2_500_000),
        segments=types.SimpleNamespace(date="2026-08-09"))
    paths = ["campaign.name", "campaign.advertising_channel_type", "metrics.cost_micros", "segments.date"]
    flat = api_client._flatten(row, paths)
    assert flat == {"campaign.name": "Shop All", "campaign.advertising_channel_type": "SHOPPING",
                    "metrics.cost_micros": 2_500_000, "segments.date": "2026-08-09"}


def test_paths_from_query():
    q = build_query(SPECS_BY_TYPE["ad_group_performance"], datetime.date(2026, 8, 1), datetime.date(2026, 9, 1))
    assert api_client._paths_from_query(q)[:2] == ["campaign.name", "ad_group.name"]


def test_missing_credentials(monkeypatch):
    for env in api_client.CRED_ENV.values():
        monkeypatch.delenv(env, raising=False)
    assert api_client.missing_credentials() == list(api_client.CRED_ENV.values())
    assert not api_client.credentials_configured()
    for env in api_client.CRED_ENV.values():
        monkeypatch.setenv(env, "x")
    assert api_client.credentials_configured()


# --- end-to-end sync through the real merge-by-window loader -----------------------------
class FakeApi:
    """Stands in for GoogleAdsApiClient: yields canned flattened rows keyed by GAQL resource."""
    def __init__(self, by_resource):
        self.by_resource = by_resource

    def stream(self, customer_id, query):
        import re
        res = re.search(r"FROM (\w+)", query).group(1)
        for r in self.by_resource.get(res, []):
            yield r


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


def _account_spend_rows(day_costs, name="Acme", cid="4631945864"):
    return [{"customer.descriptive_name": name, "customer.id": cid,
             "metrics.cost_micros": int(round(cost * 1_000_000)), "segments.date": d}
            for d, cost in day_costs.items()]


def test_sync_client_ingests_and_preserves_history(engine):
    service.create_client("Acme", client_id="acme", engine=engine, google_customer_id="463-194-5864")
    client = service.get_client(engine, "acme")

    # pre-existing manual history BEFORE the pull window (July) must survive the API sync.
    from engine.ingest.store import uploads as up_t
    with engine.begin() as c:
        uid = c.execute(up_t.insert().values(
            client_id="acme", report_type="account_spend", source_file="manual.csv",
            window_start=datetime.date(2026, 7, 1), window_end=datetime.date(2026, 7, 31),
            row_count=1, uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        c.execute(raw_rows.insert().values(client_id="acme", upload_id=uid,
                  report_type="account_spend", entity="Acme", cost=90.0,
                  date=None, date_norm=datetime.date(2026, 7, 15), row={}))

    spec = SPECS_BY_TYPE["account_spend"]
    api = FakeApi({"customer": _account_spend_rows({"2026-08-10": 100.0, "2026-09-05": 120.0})})
    today = datetime.date(2026, 9, 15)   # window Aug 1 -> Sep 15

    out = sync_client(engine, client, specs=[spec], today=today, api=api)
    assert out["window"] == ["2026-08-01", "2026-09-15"]
    assert out["reports"] == [{"report_type": "account_spend", "rows": 2}]

    def dates():
        with engine.connect() as c:
            return sorted(str(d) for d in c.execute(
                select(raw_rows.c.date_norm).where(raw_rows.c.report_type == "account_spend")).scalars())
    assert dates() == ["2026-07-15", "2026-08-10", "2026-09-05"]   # July preserved, Aug/Sep added

    # re-pull (restated numbers) is idempotent for the window, July still untouched
    api2 = FakeApi({"customer": _account_spend_rows({"2026-08-10": 111.0, "2026-09-05": 130.0})})
    sync_client(engine, client, specs=[spec], today=today, api=api2)
    assert dates() == ["2026-07-15", "2026-08-10", "2026-09-05"]
    with engine.connect() as c:
        aug = c.execute(select(raw_rows.c.cost).where(raw_rows.c.date_norm == datetime.date(2026, 8, 10))).scalar()
    assert aug == 111.0   # window rows were replaced with the restated values


def test_sync_client_skips_without_customer_id(engine):
    service.create_client("NoCid", client_id="nocid", engine=engine)
    out = sync_client(engine, service.get_client(engine, "nocid"), api=FakeApi({}), today=datetime.date(2026, 9, 1))
    assert out["skipped"] == "no google_customer_id"


def test_sync_report_error_is_isolated(engine):
    service.create_client("Acme", client_id="acme", engine=engine, google_customer_id="4631945864")
    client = service.get_client(engine, "acme")

    class Boom(FakeApi):
        def stream(self, customer_id, query):
            if "FROM campaign " in query or query.rstrip().endswith("FROM campaign"):
                raise RuntimeError("api blew up")
            return iter(())
    out = sync_client(engine, client,
                      specs=[SPECS_BY_TYPE["campaign_performance"], SPECS_BY_TYPE["account_spend"]],
                      today=datetime.date(2026, 9, 1), api=Boom({}))
    kinds = {r["report_type"]: r for r in out["reports"]}
    assert "error" in kinds["campaign_performance"] and "rows" in kinds["account_spend"]
