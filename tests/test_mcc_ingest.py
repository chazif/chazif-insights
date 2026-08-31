#!/usr/bin/env python3
"""End-to-end MCC (manager-account) preview + commit (engine/ingest/service).

One export covers several accounts; preview detects them (no writes), commit splits the
rows per account into the mapped clients. Both paths stream in constant memory so a large
export doesn't OOM the worker (the bug that surfaced as an HTTP 502 on "Preview accounts").
Throwaway SQLite engine, same posture as test_ingest_merge.
"""
import tracemalloc

import pytest
from sqlalchemy import create_engine, select, func

from engine.ingest.store import metadata as store_md, raw_rows, clients
from engine.ingest import service


HEADER = ["Month", "Account name", "Customer ID", "Campaign", "Campaign type",
          "Clicks", "Impr.", "Cost", "Conversions"]


def write_mcc_csv(path, rows):
    """Google Report-Editor style: 3-line preamble, data rows, trailing Total."""
    lines = ['"Campaign performance"',
             '"January 1, 2026 - July 31, 2026"',
             ",".join(HEADER)]
    lines += [",".join(str(c) for c in r) for r in rows]
    lines.append("Total,,,,,0,0,0,0")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def row(acct, cid, camp):
    return ["March 2026", acct, cid, camp, "Search", 10, 100, "5.00", 2]


@pytest.fixture()
def engine(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 't.db'}", future=True)
    store_md.create_all(eng)
    return eng


@pytest.fixture()
def mcc_folder(tmp_path):
    folder = tmp_path / "mcc"
    folder.mkdir()
    write_mcc_csv(folder / "campaigns.csv", [
        row("Alpha Co", "111-111-1111", "Alpha - Brand"),
        row("Alpha Co", "111-111-1111", "Alpha - NonBrand"),
        row("Beta Co", "222-222-2222", "Beta - Brand"),
        row("Gamma Co", "333-333-3333", "Gamma - Brand"),
        row("Gamma Co", "333-333-3333", "Gamma - NonBrand"),
        row("Gamma Co", "333-333-3333", "Gamma - Shopping"),
    ])
    return str(folder)


def test_preview_detects_accounts_and_counts(engine, mcc_folder):
    out = service.preview_mcc(mcc_folder, engine=engine)
    by_name = {a["account_name"]: a for a in out["accounts"]}
    assert set(by_name) == {"Alpha Co", "Beta Co", "Gamma Co"}
    assert by_name["Alpha Co"]["rows"] == 2
    assert by_name["Beta Co"]["rows"] == 1
    assert by_name["Gamma Co"]["rows"] == 3
    # all "new" — no clients exist yet
    assert all(a["status"] == "new" for a in out["accounts"])
    assert out["files"][0]["rows"] == 6 and out["files"][0]["has_account"] is True


def test_commit_splits_rows_per_client_and_skips_unmapped(engine, mcc_folder):
    service.create_client("Alpha Co", client_id="alpha", engine=engine)
    prev = service.preview_mcc(mcc_folder, engine=engine)
    keys = {a["account_name"]: a["key"] for a in prev["accounts"]}

    mapping = {
        keys["Alpha Co"]: {"client_id": "alpha", "customer_id": "111-111-1111"},
        keys["Beta Co"]: {"create": True, "name": "Beta Co", "customer_id": "222-222-2222"},
        # Gamma Co intentionally left unmapped -> must be skipped, not ingested
    }
    res = service.commit_mcc(mcc_folder, mapping, engine=engine)

    ingested = {r["client_id"]: r["rows"] for r in res["ingested"]}
    assert ingested["alpha"] == 2
    assert ingested["beta-co"] == 1
    assert "gamma" not in "".join(ingested)                      # no gamma client created
    assert [s["rows"] for s in res["skipped"]] == [3]            # Gamma's 3 rows skipped

    # rows actually landed in raw_rows for the mapped clients only
    with engine.connect() as c:
        counts = dict(c.execute(select(raw_rows.c.client_id, func.count()).group_by(raw_rows.c.client_id)).all())
    assert counts == {"alpha": 2, "beta-co": 1}
    # created client carries the customer id from the mapping (stored normalized to digits)
    with engine.connect() as c:
        gcid = c.execute(select(clients.c.google_customer_id).where(clients.c.client_id == "beta-co")).scalar()
    assert gcid == service._norm_cid("222-222-2222")


def test_commit_is_constant_memory(engine, tmp_path):
    """A large multi-account export must ingest without materializing the file — peak
    allocation stays flat, not O(rows). This is the regression guard for the 502/OOM."""
    folder = tmp_path / "big"
    folder.mkdir()
    rows = []
    for i in range(60_000):                       # 12k rows/account >> CHUNK, so batches must flush
        acct = f"Acct {i % 5}"
        rows.append(row(acct, f"{i % 5:03d}-000-0000", f"Camp {i}"))
    write_mcc_csv(folder / "big.csv", rows)

    prev = service.preview_mcc(folder, engine=engine)
    mapping = {a["key"]: {"create": True, "name": a["account_name"], "customer_id": a["customer_id"]}
               for a in prev["accounts"]}

    tracemalloc.start()
    res = service.commit_mcc(folder, mapping, engine=engine)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()

    assert sum(r["rows"] for r in res["ingested"]) == 60_000
    # Streamed ingest is bounded by the CHUNK insert batch (~10 MB), NOT by total rows:
    # materializing all 60k rows would peak north of 60 MB. 30 MB cleanly separates the two.
    assert peak < 30_000_000, f"commit peak {peak} bytes — should not scale with row count"
