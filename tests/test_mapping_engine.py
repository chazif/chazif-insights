#!/usr/bin/env python3
"""Central campaign-mapping engine tests: auto-mapping + confidence, sync
(insert-new-only, idempotent, preserves human rows), the mapping-first resolver
with name-heuristic fallback, approval, and mapping-file parsing.
Runs on a throwaway SQLite engine (same dialect posture as local dev)."""
import datetime

import pytest
from sqlalchemy import create_engine, insert, select

from engine.ingest.store import metadata as store_md, raw_rows, uploads
from engine.budget_intel.tables import metadata as bi_md, campaign_mappings
from engine import mapping as m


CFG = {"brand_terms": ["chiarelli's"], "product_categories": ["candles", "church supplies"]}

CAMPAIGNS = [
    "Search | Brand Defense",
    "Search | Conquest - Competitors",
    "Search | Non-Brand | Tier A - NYC Metro Core",
    "pMax Candles (Legacy)",
    "Mystery 123",
]


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    bi_md.create_all(eng)
    return eng


def _seed(engine, client_id, campaigns):
    with engine.begin() as c:
        up = c.execute(insert(uploads).values(
            client_id=client_id, report_type="campaign_performance", row_count=len(campaigns),
            uploaded_at=datetime.datetime.now())).inserted_primary_key[0]
        for name in campaigns:
            c.execute(insert(raw_rows).values(
                client_id=client_id, upload_id=up, report_type="campaign_performance",
                campaign=name, cost=100.0, row={}))


# ---- auto-mapping + confidence ----

def test_auto_map_signals():
    a = m.auto_map("Search | Brand Defense", CFG)
    assert a["category"] == "Brand" and a["confidence"] >= 0.85
    a = m.auto_map("Search | Conquest - Competitors", CFG)
    assert a["category"] == "Competitors"
    a = m.auto_map("pMax Candles (Legacy)", CFG)
    assert a["category"] == "Candles" and a["camp_type"] == "PMax"
    a = m.auto_map("Search | Non-Brand | Tier A - NYC Metro Core", CFG)
    assert a["region"] == "NYC Metro Core" and a["category"] == "General"
    weak = m.auto_map("Mystery 123", CFG)
    assert weak["category"] == "General" and weak["region"] == "All"
    assert weak["confidence"] < m.auto_map("Search | Brand Defense", CFG)["confidence"]


# ---- sync ----

def test_sync_inserts_pending_and_preserves_user_rows(engine):
    _seed(engine, "acme", CAMPAIGNS)
    out = m.sync(engine, "acme", CFG)
    assert sorted(out["new"]) == sorted(CAMPAIGNS) and out["pending"] == len(CAMPAIGNS)
    # user edit overrides; re-sync must not touch it and must add only new campaigns
    m.save_user(engine, "acme", [{"campaign": "Mystery 123", "brand": "Chiarelli's",
                                  "region": "Boston", "category": "Rosaries"}])
    _seed(engine, "acme", ["Brand New Campaign"])
    out2 = m.sync(engine, "acme", CFG)
    assert out2["new"] == ["Brand New Campaign"]
    rows = {r["campaign"]: r for r in m.get_all(engine, "acme")["mappings"]}
    assert rows["Mystery 123"]["region"] == "Boston" and rows["Mystery 123"]["source"] == "user"
    assert rows["Brand New Campaign"]["status"] == "pending"


def test_sync_is_client_isolated(engine):
    _seed(engine, "a", ["Alpha"])
    _seed(engine, "b", ["Beta"])
    m.sync(engine, "a", CFG)
    assert [r["campaign"] for r in m.get_all(engine, "b")["mappings"]] == []


# ---- resolver ----

def test_resolver_mapping_first_with_fallback(engine):
    _seed(engine, "acme", CAMPAIGNS)
    m.sync(engine, "acme", CFG)
    m.save_user(engine, "acme", [{"campaign": "Search | Non-Brand | Tier A - NYC Metro Core",
                                  "brand": "Chiarelli's", "region": "NYC Metro", "category": "General"}])
    r = m.resolver(engine, "acme", CFG)
    # mapped: user's label wins over the name parse
    assert r.region("Search | Non-Brand | Tier A - NYC Metro Core") == "NYC Metro"
    # mapped region "All" -> None (account-wide, not a region slice)
    assert r.region("Search | Brand Defense") is None
    assert r.is_brand("Search | Brand Defense") is True
    assert r.nb_category("Search | Brand Defense") is None
    assert r.nb_category("pMax Candles (Legacy)") == "Candles"
    # unmapped campaign -> name-heuristic fallback
    assert r.region("Unseen | Tier B - Boston Metro") == "Boston Metro"
    assert "NYC Metro" in r.regions


def test_resolver_without_engine_is_pure_fallback():
    r = m.resolver(None, "acme", CFG)
    assert r.known("anything") is False
    assert r.is_brand("Chiarelli's Brand Push") is True
    assert r.category("candles sale") == "Candles"


# ---- approve ----

def test_approve_all_and_subset(engine):
    _seed(engine, "acme", CAMPAIGNS)
    m.sync(engine, "acme", CFG)
    assert m.approve(engine, "acme", campaigns=["Mystery 123"]) == 1
    assert m.get_all(engine, "acme")["pending"] == len(CAMPAIGNS) - 1
    assert m.approve(engine, "acme") == len(CAMPAIGNS) - 1
    assert m.get_all(engine, "acme")["pending"] == 0


# ---- mapping file ----

def test_parse_mapping_file_csv():
    csv = b"Campaign,Brand,Region,Category\nSearch | Brand Defense,Chiarelli's,All,Brand\nX,,NYC Metro,General\n"
    rows = m.parse_mapping_file(csv, "map.csv")
    assert rows[0]["campaign"] == "Search | Brand Defense" and rows[0]["category"] == "Brand"
    assert rows[1]["region"] == "NYC Metro" and rows[1]["brand"] is None
    with pytest.raises(ValueError):
        m.parse_mapping_file(b"a,b\n1,2\n", "bad.csv")
