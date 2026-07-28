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
