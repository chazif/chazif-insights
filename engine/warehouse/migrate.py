#!/usr/bin/env python3
"""One-time data migration: Postgres raw_rows + qs_history -> BigQuery.

Direct migration (pre-production; no dual-write). Streams each table out of Postgres
as newline-delimited JSON and loads it into the matching BigQuery table with
WRITE_TRUNCATE, so re-running is idempotent (full replace). Constant memory — rows are
streamed and written a line at a time, never all held at once.

Run where BOTH stores are reachable (a Railway one-off, or locally/Cloud Shell with
DATABASE_URL + the GCP_* vars exported):
  python -m engine.warehouse.migrate --dry-run            # write NDJSON, skip the load
  python -m engine.warehouse.migrate --table raw_rows --limit 100   # small real load
  python -m engine.warehouse.migrate                       # full migration, both tables

--dry-run needs no BigQuery credentials — it just serializes and reports counts, so the
pipeline can be validated before touching BigQuery.
"""
import argparse
import datetime
import json
import os
import tempfile

from sqlalchemy import text

from ..ingest.store import get_engine, init_db
from . import bq


def _jsonify(value, bqtype):
    """Coerce a Postgres value to something json.dumps can emit for the BQ column type."""
    if value is None:
        return None
    if bqtype == "DATE":
        if isinstance(value, (datetime.date, datetime.datetime)):
            return value.isoformat()[:10]
        return str(value)[:10]                       # SQLite stores as 'YYYY-MM-DD' text
    if bqtype == "JSON":
        if isinstance(value, str):
            try:
                return json.loads(value)             # SQLite: JSON stored as text
            except (ValueError, TypeError):
                return None
        return value                                 # Postgres jsonb -> dict already
    if bqtype == "INT64":
        return int(value)
    if bqtype == "FLOAT64":
        return float(value)
    return value


def _stream_ndjson(engine, table, schema, out, limit=None):
    """Stream `table` from Postgres to NDJSON lines in `out`. Returns the row count."""
    cols = [c for c, _ in schema]
    sql = f"SELECT {', '.join(cols)} FROM {table}"
    if limit:
        sql += f" LIMIT {int(limit)}"
    n = 0
    with engine.connect() as c:
        result = c.execution_options(stream_results=True).execute(text(sql))
        for row in result:
            m = row._mapping
            rec = {c: _jsonify(m[c], t) for c, t in schema if m[c] is not None}
            out.write(json.dumps(rec, separators=(",", ":")))
            out.write("\n")
            n += 1
    return n


def _load(table, schema, ndjson_path):
    """Load an NDJSON file into the (already partitioned/clustered) BigQuery table,
    replacing its contents. Returns the destination table's row count."""
    from google.cloud import bigquery
    client = bq.get_client()
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        schema=bq._fields(schema),
    )
    with open(ndjson_path, "rb") as f:
        job = client.load_table_from_file(f, bq.table_ref(table), job_config=job_config)
    job.result()                                     # wait; raises on failure
    return client.get_table(bq.table_ref(table)).num_rows


def migrate(tables, dry_run=False, limit=None):
    pg = get_engine(); init_db(pg)
    summary = {}
    for name in tables:
        schema = bq.TABLES[name][0]
        fd, path = tempfile.mkstemp(suffix=f"_{name}.ndjson")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                pg_n = _stream_ndjson(pg, name, schema, out, limit=limit)
            if dry_run:
                head = ""
                with open(path, encoding="utf-8") as f:
                    head = f.readline().strip()
                summary[name] = {"pg_rows": pg_n, "loaded": None,
                                 "sample": (head[:300] + "…") if len(head) > 300 else head}
            else:
                bq_n = _load(name, schema, path)
                summary[name] = {"pg_rows": pg_n, "loaded": bq_n, "match": pg_n == bq_n}
        finally:
            os.remove(path)
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Migrate Postgres analytics tables to BigQuery")
    ap.add_argument("--table", choices=["raw_rows", "qs_history", "all"], default="all")
    ap.add_argument("--dry-run", action="store_true", help="serialize only; no BigQuery load")
    ap.add_argument("--limit", type=int, default=None, help="cap rows per table (for a test run)")
    args = ap.parse_args()

    if not args.dry_run and not bq.enabled():
        raise SystemExit("BigQuery not configured — set GCP_PROJECT/BQ_DATASET (or use --dry-run).")
    tables = ["raw_rows", "qs_history"] if args.table == "all" else [args.table]
    result = migrate(tables, dry_run=args.dry_run, limit=args.limit)
    print(("DRY RUN — " if args.dry_run else "") + "migration summary:")
    print(json.dumps(result, indent=2))
    if not args.dry_run:
        bad = [t for t, r in result.items() if not r.get("match")]
        if bad:
            raise SystemExit(f"Row-count mismatch in: {', '.join(bad)} — investigate before cutover.")
        print("\nAll table row counts match between Postgres and BigQuery.")
