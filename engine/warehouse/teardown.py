#!/usr/bin/env python3
"""Decommission the legacy Postgres analytical tables after the BigQuery cutover.

Once USE_BIGQUERY is live and verified, raw_rows + qs_history in Postgres are dead
copies — the app reads and writes BigQuery for those. This drops them, reclaiming
space and permanently removing the raw_rows->uploads foreign key. The config / ledger
/ cache tables (clients, uploads, term_relevance) stay in Postgres, untouched.

SAFE BY DEFAULT: a dry run (the default) only reports; pass --commit to actually drop.
Before dropping, for each table it:
  1. verifies BigQuery holds AT LEAST as many rows as Postgres (refuses otherwise), and
  2. backs the Postgres table up to an NDJSON file on disk.
If any table fails the count check, NOTHING is dropped.

(init_db stops recreating these tables once USE_BIGQUERY is set, so the drop sticks
across restarts. To reverse a teardown you'd re-run engine.warehouse.migrate the other
way, or restore from the NDJSON backup — after cutover, rollback is not the intent.)

Run where BOTH stores are reachable (a Railway one-off, or Cloud Shell with DATABASE_URL
+ the GCP_* vars exported), with USE_BIGQUERY set so the BigQuery counts can be read:
  python -m engine.warehouse.teardown                    # dry run: counts + plan, no changes
  python -m engine.warehouse.teardown --commit           # back up, verify, then drop
  python -m engine.warehouse.teardown --commit --backup-dir /tmp/bq_backup
"""
import argparse
import datetime
import os

from sqlalchemy import text, inspect

from ..ingest.store import get_engine
from . import bq
from .migrate import _stream_ndjson

TABLES = ["raw_rows", "qs_history"]


def _pg_count(engine, table):
    with engine.connect() as c:
        return c.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0


def _bq_count(table):
    client = bq.get_client()
    rows = list(client.query(f"SELECT COUNT(*) AS n FROM `{bq.table_ref(table)}`").result())
    return int(rows[0]["n"])


def _backup(engine, table, backup_dir, stamp):
    """Stream the Postgres table to an NDJSON file. Returns (path, rows_written)."""
    os.makedirs(backup_dir, exist_ok=True)
    path = os.path.join(backup_dir, f"{table}_{stamp}.ndjson")
    with open(path, "w", encoding="utf-8") as out:
        n = _stream_ndjson(engine, table, bq.TABLES[table][0], out)
    return path, n


def plan(engine):
    """Compute per-table counts + safety, without changing anything."""
    insp = inspect(engine)
    report = {}
    for t in TABLES:
        if not insp.has_table(t):
            report[t] = {"present": False, "note": "already gone — nothing to do"}
            continue
        pg_n = _pg_count(engine, t)
        bq_n = _bq_count(t)
        report[t] = {"present": True, "pg_rows": pg_n, "bq_rows": bq_n,
                     "safe_to_drop": bq_n >= pg_n}
    return report


def teardown(commit=False, backup_dir="."):
    engine = get_engine()
    engine = getattr(engine, "pg_engine", None) or engine   # drops always target Postgres
    report = plan(engine)

    present = {t: r for t, r in report.items() if r.get("present")}
    unsafe = [t for t, r in present.items() if not r["safe_to_drop"]]
    if not commit:
        report["_action"] = "dry-run — no changes made"
        return report
    if not present:
        report["_action"] = "nothing present to drop"
        return report
    if unsafe:                          # gate: never drop if BigQuery is short on any table
        report["_action"] = (f"ABORTED — BigQuery has fewer rows than Postgres for: "
                              f"{', '.join(unsafe)}. Nothing dropped; investigate.")
        return report

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for t, r in present.items():        # back everything up before dropping anything
        r["backup"], r["backup_rows"] = _backup(engine, t, backup_dir, stamp)
    for t in present:                   # then drop (children first is irrelevant; nothing refs these)
        with engine.begin() as conn:
            conn.execute(text(f"DROP TABLE IF EXISTS {t}"))
        report[t]["dropped"] = True
    report["_action"] = f"dropped {', '.join(present)} (backed up to {backup_dir})"
    return report


if __name__ == "__main__":
    import json
    ap = argparse.ArgumentParser(description="Decommission legacy Postgres analytics tables post-cutover")
    ap.add_argument("--commit", action="store_true", help="actually back up + drop (default: dry run)")
    ap.add_argument("--backup-dir", default=".", help="where to write NDJSON backups (default: cwd)")
    args = ap.parse_args()

    if not bq.active():
        raise SystemExit("Refusing to run: BigQuery is not active (need GCP_* vars + USE_BIGQUERY). "
                         "The count-check reads BigQuery, and dropping only makes sense post-cutover.")
    result = teardown(commit=args.commit, backup_dir=args.backup_dir)
    print(("" if args.commit else "DRY RUN — ") + "teardown plan:")
    print(json.dumps(result, indent=2, default=str))
