#!/usr/bin/env python3
"""M0-A3: the React console is the only frontend, and /api/bundle is always computed.

Covers: / serves the React build (assets + SPA fallback, traversal-guarded), /api/* never
falls back to HTML, /next redirects to /, /api/bundle requires a client (422) and never
reads a pre-baked bundle.json from data/clients, and the legacy frontend is gone.
Throwaway SQLite + a fake build directory; no network.
"""
import importlib
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def main(tmp_path_factory):
    if "backend.main" not in __import__("sys").modules:   # engine is created at import time
        db = tmp_path_factory.mktemp("db") / "web.db"
        old = os.environ.get("DATABASE_URL")
        os.environ["DATABASE_URL"] = f"sqlite:///{db.as_posix()}"
        try:
            mod = importlib.import_module("backend.main")
        finally:
            if old is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = old
        return mod
    return importlib.import_module("backend.main")


@pytest.fixture()
def dist(tmp_path, monkeypatch, main):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><div id=root>REACT-CONSOLE</div>", encoding="utf-8")
    (d / "assets" / "app-123.js").write_text("console.log('app')", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("outside the build", encoding="utf-8")
    monkeypatch.setattr(main, "WEB_DIST", d)
    return d


@pytest.fixture()
def client(main):
    return TestClient(main.app)


# ── / serves the React console ───────────────────────────────────────────────────

def test_root_serves_react_index(client, dist):
    r = client.get("/")
    assert r.status_code == 200 and "REACT-CONSOLE" in r.text


def test_assets_are_served(client, dist):
    r = client.get("/assets/app-123.js")
    assert r.status_code == 200 and "console.log" in r.text


def test_client_side_routes_fall_back_to_index(client, dist):
    r = client.get("/c/acme/brief")
    assert r.status_code == 200 and "REACT-CONSOLE" in r.text


def test_path_traversal_never_escapes_the_build(main, dist):
    resp = main.web_app("../secret.txt")
    assert Path(resp.path).resolve() == (dist / "index.html").resolve()


def test_api_paths_never_fall_back_to_html(client, dist):
    for p in ("/api", "/api/does-not-exist"):
        r = client.get(p)
        assert r.status_code == 404, p
        assert r.headers["content-type"].startswith("application/json"), p


def test_api_routes_still_win(client, dist):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_missing_build_is_a_clear_404(client, main, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "WEB_DIST", tmp_path / "no-build")
    r = client.get("/")
    assert r.status_code == 404 and "npm run build" in r.json()["detail"]


# ── /next is retired ─────────────────────────────────────────────────────────────

def test_next_redirects_to_root_keeping_path_and_query(client, dist):
    r = client.get("/next", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/"
    r = client.get("/next/c/acme/brief?view=1", follow_redirects=False)
    assert r.status_code == 308 and r.headers["location"] == "/c/acme/brief?view=1"


# ── /api/bundle ──────────────────────────────────────────────────────────────────

def test_bundle_requires_a_client(client):
    assert client.get("/api/bundle").status_code == 422


def test_bundle_is_computed_even_when_a_prebaked_file_exists(client, main, monkeypatch, tmp_path):
    calls = []
    monkeypatch.setattr(main, "build_bundle", lambda cid, *a, **k: calls.append(cid) or {"computed": cid})
    main._bundle_cache_clear()
    prebaked = ROOT / "data" / "clients" / "mavis" / "2026-03" / "bundle.json"
    # The legacy demo fixture may or may not be on disk; either way it must not be served.
    r = client.get("/api/bundle", params={"client": "mavis", "period": "2026-03"})
    assert r.status_code == 200 and r.json() == {"computed": "mavis"} and calls == ["mavis"], prebaked


def test_backend_never_references_prebaked_bundles():
    src = (ROOT / "backend" / "main.py").read_text(encoding="utf-8")
    for needle in ("data\" / \"clients", "bundle.json", "CLIENTS", "\"mavis\"", "2026-03", "StaticFiles"):
        assert needle not in src, needle


# ── the legacy frontend is gone ──────────────────────────────────────────────────

def test_legacy_frontend_removed(main):
    assert not (ROOT / "frontend").exists()
    assert not (ROOT / "backend" / "dev_server.py").exists()
    assert not any(getattr(r, "name", None) == "frontend" for r in main.app.routes)
