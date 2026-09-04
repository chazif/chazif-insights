#!/usr/bin/env python3
"""geocode_places: cache-first, rate-limited, progressive geocoding for the map's city
bubbles (engine/ingest/service). Nominatim and the 1 req/s sleep are stubbed so the test
is fast and offline. Throwaway SQLite engine."""
import pytest
from sqlalchemy import create_engine, select

from engine.ingest import service
from engine.ingest.store import metadata as store_md, geo_cache


@pytest.fixture()
def engine(tmp_path):
    return create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(service.time, "sleep", lambda *_: None)


def fake_geocoder(known):
    calls = []
    def _g(place):
        calls.append(place)
        return known.get(place)
    _g.calls = calls
    return _g


def test_resolves_and_caches(engine, monkeypatch):
    g = fake_geocoder({"Brooklyn, New York, United States": (40.65, -73.95)})
    monkeypatch.setattr(service, "geocode", g)
    out = service.geocode_places(["Brooklyn, New York, United States"], engine=engine)
    assert out["pending"] == 0
    assert out["resolved"]["Brooklyn, New York, United States"] == {"lat": 40.65, "lng": -73.95}
    # second call is served from cache — the geocoder is not hit again
    out2 = service.geocode_places(["Brooklyn, New York, United States"], engine=engine)
    assert out2["resolved"]["Brooklyn, New York, United States"]["lat"] == 40.65
    assert len(g.calls) == 1


def test_budget_limits_batch_and_reports_pending(engine, monkeypatch):
    places = [f"City {i}" for i in range(5)]
    g = fake_geocoder({p: (1.0 * i, 2.0 * i) for i, p in enumerate(places)})
    monkeypatch.setattr(service, "geocode", g)
    out = service.geocode_places(places, engine=engine, budget=2)
    assert len(out["resolved"]) == 2 and out["pending"] == 3
    # a follow-up call geocodes the next batch (the first two now come from cache)
    out2 = service.geocode_places(places, engine=engine, budget=2)
    assert len(out2["resolved"]) == 4 and out2["pending"] == 1
    assert len(g.calls) == 4


def test_unfindable_place_is_cached_and_not_retried(engine, monkeypatch):
    g = fake_geocoder({})  # everything returns None
    monkeypatch.setattr(service, "geocode", g)
    out = service.geocode_places(["Nowhere Land"], engine=engine)
    assert out["resolved"] == {} and out["pending"] == 0
    with engine.connect() as c:
        row = c.execute(select(geo_cache.c.ok).where(geo_cache.c.place == "nowhere land")).first()
    assert row is not None and row.ok == 0          # failure recorded
    service.geocode_places(["Nowhere Land"], engine=engine)
    assert len(g.calls) == 1                         # never retried


def test_empty_input(engine):
    assert service.geocode_places([], engine=engine) == {"resolved": {}, "pending": 0}
