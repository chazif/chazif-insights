#!/usr/bin/env python3
"""BigQuery warehouse: connection + partitioned/clustered table provisioning.

Phase 1 of the direct Postgres->BigQuery migration (pre-production, no dual-write).
Only the two big analytical tables live here — raw_rows and qs_history; clients /
uploads / term_relevance stay in Postgres.

Config comes entirely from env, so this module is inert unless BigQuery is wired up:
  GCP_PROJECT    e.g. searchnex-ads
  BQ_DATASET     e.g. searchnex_analytics
  BQ_LOCATION    e.g. us-east4        (must match the dataset's region)
  GCP_SA_KEY     the service-account JSON, inline (Railway var). If unset, falls back
                 to Application Default Credentials (e.g. `gcloud` in Cloud Shell).

CLI (run where the env + credentials are available — Railway one-off or Cloud Shell):
  python -m engine.warehouse.bq check   # verify auth + config (SELECT 1)
  python -m engine.warehouse.bq init    # create dataset (if needed) + both tables
  python -m engine.warehouse.bq info    # show table names / partition + cluster config

The google-cloud-bigquery import is lazy so the rest of the app (and the schema
definitions / tests below) work without the package installed locally.
"""
import json
import os

# ---- schema, as plain data so it's importable/testable without the BQ SDK --------
# (name, BigQuery type). Mirrors engine/ingest/store.py, minus the SQLite autoincrement
# `id` (BigQuery has no surrogate PK). Kept in sync by test_bq_schema_parity.
RAW_ROWS_SCHEMA = [
    ("upload_id", "INT64"), ("client_id", "STRING"), ("report_type", "STRING"),
    ("row_index", "INT64"), ("campaign", "STRING"), ("ad_group", "STRING"),
    ("entity", "STRING"), ("date", "STRING"), ("date_norm", "DATE"),
    ("clicks", "FLOAT64"), ("impressions", "FLOAT64"), ("cost", "FLOAT64"),
    ("conversions", "FLOAT64"), ("conv_value", "FLOAT64"),
    ("impr_share", "FLOAT64"), ("eligible_impr", "FLOAT64"), ("row", "JSON"),
]
RAW_ROWS_PARTITION = "date_norm"                 # DAY partitioning on the calendar date
RAW_ROWS_CLUSTER = ["client_id", "report_type"]  # every read filters on these

QS_HISTORY_SCHEMA = [
    ("client_id", "STRING"), ("kw_key", "STRING"), ("as_of_date", "DATE"),
    ("search_keyword", "STRING"), ("match_type", "STRING"), ("campaign", "STRING"),
    ("ad_group", "STRING"), ("quality_score", "FLOAT64"),
    ("exp_ctr", "INT64"), ("ad_relevance", "INT64"), ("landing_page_exp", "INT64"),
    ("exp_ctr_label", "STRING"), ("ad_relevance_label", "STRING"),
    ("landing_page_exp_label", "STRING"),
]
QS_HISTORY_PARTITION = "as_of_date"
QS_HISTORY_CLUSTER = ["client_id"]

TABLES = {
    "raw_rows": (RAW_ROWS_SCHEMA, RAW_ROWS_PARTITION, RAW_ROWS_CLUSTER),
    "qs_history": (QS_HISTORY_SCHEMA, QS_HISTORY_PARTITION, QS_HISTORY_CLUSTER),
}


# ---- config ----------------------------------------------------------------------
def bq_config():
    """Env-derived config, or None if BigQuery isn't configured for this deployment."""
    project = os.environ.get("GCP_PROJECT")
    dataset = os.environ.get("BQ_DATASET")
    if not (project and dataset):
        return None
    return {
        "project": project,
        "dataset": dataset,
        "location": os.environ.get("BQ_LOCATION", "US"),
    }


def enabled():
    return bq_config() is not None


def table_ref(name):
    cfg = bq_config()
    if not cfg:
        raise RuntimeError("BigQuery is not configured (set GCP_PROJECT + BQ_DATASET)")
    return f"{cfg['project']}.{cfg['dataset']}.{name}"


# ---- client (lazy imports so the module loads without google-cloud-bigquery) ------
_CLIENT = None


def get_client():
    global _CLIENT
    if _CLIENT is not None:
        return _CLIENT
    cfg = bq_config()
    if not cfg:
        raise RuntimeError("BigQuery is not configured (set GCP_PROJECT + BQ_DATASET)")
    from google.cloud import bigquery
    key = os.environ.get("GCP_SA_KEY")
    if key and key.strip().startswith("{"):
        from google.oauth2 import service_account
        creds = service_account.Credentials.from_service_account_info(json.loads(key))
        _CLIENT = bigquery.Client(project=cfg["project"], credentials=creds, location=cfg["location"])
    else:
        # Application Default Credentials (Cloud Shell / GOOGLE_APPLICATION_CREDENTIALS)
        _CLIENT = bigquery.Client(project=cfg["project"], location=cfg["location"])
    return _CLIENT


def _fields(schema):
    from google.cloud import bigquery
    return [bigquery.SchemaField(name, typ) for name, typ in schema]


# ---- provisioning ----------------------------------------------------------------
def ensure_dataset_and_tables():
    """Idempotently create the dataset (if missing) and the two partitioned/clustered
    tables. Safe to run repeatedly. Returns a summary dict."""
    from google.cloud import bigquery
    cfg = bq_config()
    client = get_client()

    ds_id = f"{cfg['project']}.{cfg['dataset']}"
    ds = bigquery.Dataset(ds_id)
    ds.location = cfg["location"]
    client.create_dataset(ds, exists_ok=True)

    made = {}
    for name, (schema, part, cluster) in TABLES.items():
        table = bigquery.Table(table_ref(name), schema=_fields(schema))
        table.time_partitioning = bigquery.TimePartitioning(
            type_=bigquery.TimePartitioningType.DAY, field=part)
        table.clustering_fields = cluster
        client.create_table(table, exists_ok=True)
        made[name] = {"partition": part, "cluster": cluster, "columns": len(schema)}
    return {"dataset": ds_id, "location": cfg["location"], "tables": made}


def check():
    """Verify credentials + config by running a trivial query. Returns True or raises."""
    client = get_client()
    list(client.query("SELECT 1 AS ok").result())
    return True


# ---- cutover switch + writes (Phase 4: ingestion -> BigQuery) --------------------
def active():
    """True when the LIVE app should use BigQuery for analytics (reads + writes): the
    config vars present AND an explicit USE_BIGQUERY opt-in. Keeping cutover behind its
    own switch means setting the vars for provisioning / migration / parity does NOT flip
    production — turning USE_BIGQUERY on (and off) is the cutover (and the rollback)."""
    return bool(bq_config()) and os.environ.get("USE_BIGQUERY", "").strip().lower() in ("1", "true", "yes", "on")


def _jsonify(value, bqtype):
    """Coerce a Python value for json.dumps per its BigQuery column type."""
    if value is None:
        return None
    if bqtype == "DATE":
        return value.isoformat()[:10] if hasattr(value, "isoformat") else str(value)[:10]
    if bqtype == "JSON":
        if isinstance(value, str):
            try:
                return json.loads(value)
            except (ValueError, TypeError):
                return None
        return value
    if bqtype == "INT64":
        return int(value)
    if bqtype == "FLOAT64":
        return float(value)
    return value


def ndjson_line(rec, schema):
    """One NDJSON line for a record dict per a table schema (null fields omitted)."""
    return json.dumps({n: _jsonify(rec.get(n), t) for n, t in schema if rec.get(n) is not None},
                      separators=(",", ":"))


def load_ndjson(table, path, truncate=False):
    """Load an NDJSON file into `table` via a free load job (append unless truncate)."""
    from google.cloud import bigquery
    jc = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=(bigquery.WriteDisposition.WRITE_TRUNCATE if truncate
                           else bigquery.WriteDisposition.WRITE_APPEND),
        schema=_fields(TABLES[table][0]))
    with open(path, "rb") as f:
        get_client().load_table_from_file(f, table_ref(table), job_config=jc).result()


def delete_report(client_id, report_type):
    """Snapshot-replace step (undated reports): remove a client's rows for one report_type."""
    from google.cloud import bigquery
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("c", "STRING", client_id),
        bigquery.ScalarQueryParameter("r", "STRING", report_type)])
    get_client().query(
        f"DELETE FROM `{table_ref('raw_rows')}` WHERE client_id=@c AND report_type=@r",
        job_config=jc).result()


def delete_report_window(client_id, report_type, ns, ne, undated_upload_ids=()):
    """Merge-by-window step (dated reports): remove only the rows the new upload supersedes —
    dated rows whose date_norm is in [ns, ne], plus undated rows (date_norm NULL) belonging to
    older uploads whose window overlaps (passed as upload ids). Mirrors the Postgres
    _merge_windowed; see docs/INGEST_MERGE_DESIGN.md."""
    from google.cloud import bigquery
    jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("c", "STRING", client_id),
        bigquery.ScalarQueryParameter("r", "STRING", report_type),
        bigquery.ScalarQueryParameter("ns", "DATE", ns),
        bigquery.ScalarQueryParameter("ne", "DATE", ne),
        bigquery.ArrayQueryParameter("ids", "INT64", list(undated_upload_ids))])
    get_client().query(
        f"DELETE FROM `{table_ref('raw_rows')}` WHERE client_id=@c AND report_type=@r "
        "AND ((date_norm BETWEEN @ns AND @ne) "
        "OR (date_norm IS NULL AND upload_id IN UNNEST(@ids)))",
        job_config=jc).result()


def merge_qs(staging_path):
    """Load QS records (NDJSON) into a staging table, then MERGE into qs_history inserting
    only new (client, keyword, as-of-date) rows — the append-only freeze."""
    from google.cloud import bigquery
    staging = table_ref("qs_history") + "_staging"
    jc = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        schema=_fields(TABLES["qs_history"][0]))
    with open(staging_path, "rb") as f:
        get_client().load_table_from_file(f, staging, job_config=jc).result()
    get_client().query(
        f"MERGE `{table_ref('qs_history')}` T USING `{staging}` S "
        "ON T.client_id=S.client_id AND T.kw_key=S.kw_key AND T.as_of_date=S.as_of_date "
        "WHEN NOT MATCHED THEN INSERT ROW").result()


# ---- CLI -------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="BigQuery warehouse admin")
    ap.add_argument("action", choices=["check", "init", "info"])
    args = ap.parse_args()

    cfg = bq_config()
    if not cfg:
        raise SystemExit("BigQuery not configured — set GCP_PROJECT, BQ_DATASET, BQ_LOCATION (and GCP_SA_KEY).")

    if args.action == "info":
        print(f"project={cfg['project']} dataset={cfg['dataset']} location={cfg['location']}")
        for name, (schema, part, cluster) in TABLES.items():
            print(f"  {table_ref(name)}: partition by {part}, cluster by {', '.join(cluster)}, {len(schema)} cols")
    elif args.action == "check":
        check()
        print(f"OK — authenticated to {cfg['project']} ({cfg['location']}); SELECT 1 succeeded.")
    elif args.action == "init":
        summary = ensure_dataset_and_tables()
        print("Provisioned:")
        print(json.dumps(summary, indent=2))
