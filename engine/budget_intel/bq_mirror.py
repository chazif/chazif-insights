#!/usr/bin/env python3
"""BigQuery homes for Budget Intelligence analytical data.

Division of labor (mirrors the app-wide split in engine/warehouse/):
  Postgres  — operational state, small + UI-edited: bi_campaign_mappings,
              bi_business_metrics, bi_curve_fits, bi_allocation_runs.
  BigQuery  — analytical history that grows and gets analyzed: simulator
              snapshots, allocation results, predictions (calibration).

Postgres remains the source of truth for the app; BigQuery rows are an
append-only analytical mirror written fail-soft at the same moments the PG
rows are written (a BQ hiccup must never break an operator's save). Gated on
engine.warehouse.bq.active() — inert until the BigQuery cutover switch is on.

Provision:  python -m engine.budget_intel.bq_mirror init
"""
import datetime
import json

from engine.warehouse import bq

# (name, BigQuery type) — same plain-data convention as engine/warehouse/bq.py
BI_SIM_SNAPSHOTS_SCHEMA = [
    ("client_id", "STRING"), ("campaign", "STRING"), ("taken_at", "TIMESTAMP"),
    ("taken_date", "DATE"), ("source", "STRING"), ("points", "JSON"),
]
BI_ALLOC_RESULTS_SCHEMA = [
    ("run_id", "INT64"), ("client_id", "STRING"), ("run_at", "TIMESTAMP"),
    ("run_date", "DATE"), ("goal", "STRING"), ("budget", "FLOAT64"),
    ("mode", "STRING"), ("status", "STRING"),
    ("brand", "STRING"), ("region", "STRING"), ("category", "STRING"),
    ("opp_score", "FLOAT64"), ("lw_spend", "FLOAT64"), ("rec_spend", "FLOAT64"),
    ("spend_cap", "FLOAT64"), ("expected_is", "FLOAT64"), ("lw_is", "FLOAT64"),
    ("expected_cpa", "FLOAT64"), ("lw_cpa", "FLOAT64"),
    ("tcpa_current", "FLOAT64"), ("tcpa_recommended", "FLOAT64"),
    ("expected_cars", "FLOAT64"), ("lw_cars", "FLOAT64"),
    ("expected_revenue", "FLOAT64"), ("expected_adroi", "FLOAT64"),
]
BI_PREDICTIONS_SCHEMA = [
    ("run_id", "INT64"), ("client_id", "STRING"), ("stamped_at", "TIMESTAMP"),
    ("stamped_date", "DATE"),
    ("brand", "STRING"), ("region", "STRING"), ("category", "STRING"),
    ("predicted", "JSON"), ("actual", "JSON"), ("measured_at", "TIMESTAMP"),
]

BI_TABLES = {
    "bi_simulator_snapshots": (BI_SIM_SNAPSHOTS_SCHEMA, "taken_date", ["client_id"]),
    "bi_allocation_results": (BI_ALLOC_RESULTS_SCHEMA, "run_date", ["client_id"]),
    "bi_predictions": (BI_PREDICTIONS_SCHEMA, "stamped_date", ["client_id"]),
}


def provision():
    """Idempotently create the three BI tables in the existing dataset
    (partitioned by day, clustered by client_id — same posture as raw_rows)."""
    from google.cloud import bigquery
    client = bq.get_client()
    made = {}
    for name, (schema, part, cluster) in BI_TABLES.items():
        table = bigquery.Table(
            bq.table_ref(name),
            schema=[bigquery.SchemaField(n, t) for n, t in schema])
        table.time_partitioning = bigquery.TimePartitioning(
            type_=bigquery.TimePartitioningType.DAY, field=part)
        table.clustering_fields = cluster
        client.create_table(table, exists_ok=True)
        made[name] = {"partition": part, "cluster": cluster}
    return made


def _mirror(table, rows):
    """Append rows to a BI mirror table. Fail-soft by design: returns the error
    string (for logging) instead of raising — the operational PG write already
    succeeded and must not be rolled back by an analytics hiccup."""
    if not bq.active() or not rows:
        return None
    try:
        errors = bq.get_client().insert_rows_json(bq.table_ref(table), rows)
        return str(errors) if errors else None
    except Exception as e:                     # noqa: BLE001 — mirror is best-effort
        return f"{type(e).__name__}: {e}"


def _iso(dt=None):
    dt = dt or datetime.datetime.now(datetime.timezone.utc)
    return dt.isoformat(), dt.date().isoformat()


def mirror_snapshot(client_id, points, source, campaign=None):
    ts, d = _iso()
    return _mirror("bi_simulator_snapshots", [{
        "client_id": client_id, "campaign": campaign, "taken_at": ts,
        "taken_date": d, "source": source, "points": json.dumps(points)}])


def mirror_finalized_run(run):
    """run: the dict returned by service.get_run (status already 'final')."""
    ts = run.get("run_at") or _iso()[0]
    d = str(ts)[:10]
    rows, preds = [], []
    for r in run["results"]:
        rows.append({
            "run_id": run["id"], "client_id": run["client_id"], "run_at": ts,
            "run_date": d, "goal": run["goal"], "budget": run["budget"],
            "mode": run["mode"], "status": "final",
            **{k: r.get(k) for k, _t in BI_ALLOC_RESULTS_SCHEMA
               if k in r}})
        preds.append({
            "run_id": run["id"], "client_id": run["client_id"],
            "stamped_at": _iso()[0], "stamped_date": _iso()[1],
            "brand": r["brand"], "region": r["region"], "category": r["category"],
            "predicted": json.dumps({"is": r["expected_is"], "cpa": r["expected_cpa"],
                                     "cars": r["expected_cars"], "spend": r["rec_spend"]})})
    err = _mirror("bi_allocation_results", rows)
    err2 = _mirror("bi_predictions", preds)
    return err or err2


def sync_mappings_from_bq(engine, client_id, table, column_map=None):
    """One-time import of an existing BigQuery campaign-mapping table into
    bi_campaign_mappings (Postgres stays the operational store the UI edits).
    column_map adapts source column names, default expects
    campaign/brand/region/category."""
    from . import service
    cm = column_map or {}
    cols = {k: cm.get(k, k) for k in ("campaign", "brand", "region", "category")}
    sql = (f"SELECT {cols['campaign']} AS campaign, {cols['brand']} AS brand, "
           f"{cols['region']} AS region, {cols['category']} AS category "
           f"FROM `{bq.table_ref(table)}`")
    rows = [dict(r) for r in bq.get_client().query(sql).result()]
    return service.upsert_mappings(engine, client_id, rows)


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="Budget Intelligence BigQuery admin")
    ap.add_argument("action", choices=["init", "info"])
    args = ap.parse_args()
    if args.action == "info":
        for name, (schema, part, cluster) in BI_TABLES.items():
            print(f"{name}: partition {part}, cluster {cluster}, {len(schema)} cols")
    else:
        print(json.dumps(provision(), indent=2))
