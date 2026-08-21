"""Orchestrate the nightly pull: for each client (by google_customer_id), run every report's
GAQL over the rolling window and ingest the converted rows through the existing loader.

The loader is merge-by-window (replace_report / replace_report_bq): it replaces only the
window's dates and preserves older history, so a nightly re-pull is idempotent and never wipes
data — the reason the API branch carries merge-by-window. Rows stream lazily from the API
straight into the loader's chunked insert, so peak memory stays flat regardless of account size.
Each report ingests in its own transaction; one report failing does not abort the others.
"""
import datetime

from ..ingest.store import get_engine, init_db
from ..ingest.load import replace_report, replace_report_bq
from ..ingest.service import list_clients, get_client
from ..warehouse import bq
from .window import pull_window
from .reports import DEFAULT_SPECS, build_query, convert_row
from .client import GoogleAdsApiClient


def _window_raw(start, end):
    return f"{start.strftime('%B %d, %Y')} - {end.strftime('%B %d, %Y')}"


def backfill_window(months, today=None):
    """(start, end) covering the last `months` calendar months through today, aligned to the
    first of the month. months=1 -> just this month; months=12 -> a rolling year. Ingested via
    merge-by-window, so a backfill fills in older history without disturbing the recent window."""
    today = today or datetime.date.today()
    m0 = today.year * 12 + (today.month - 1)         # month index since year 0
    back = m0 - (max(1, months) - 1)
    return datetime.date(back // 12, back % 12 + 1, 1), today


def sync_client(engine, client, *, specs=DEFAULT_SPECS, today=None, window=None, api=None, now=None):
    """Pull + ingest every report for one client. `client` is a dict with client_id and
    google_customer_id (as list_clients/get_client return). `window` (start, end) overrides the
    default rolling window — used for historical backfill. Returns a per-report summary."""
    cid = client.get("google_customer_id")
    if not cid:
        return {"client_id": client.get("client_id"), "skipped": "no google_customer_id", "reports": []}
    start, end = window if window else pull_window(today)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    window_raw = _window_raw(start, end)
    api = api or GoogleAdsApiClient.from_env()
    writer = replace_report_bq if bq.active() else replace_report

    reports = []
    for spec in specs:
        try:
            rows = (convert_row(spec, r) for r in api.stream(cid, build_query(spec, start, end)))
            # dated reports merge by window (per-row "date"); undated ones (schedule, bid
            # strategies) carry no date -> snapshot-replace (latest wins).
            date_col = "date" if spec.dated else None
            with engine.begin() as conn:
                n = writer(conn, client["client_id"], spec.report_type, rows,
                           f"adsapi:{spec.report_type}", window_raw, start, end, now,
                           date_col=date_col, order="mdy")
            reports.append({"report_type": spec.report_type, "rows": n})
        except Exception as e:                        # keep going; never leak a credential
            reports.append({"report_type": spec.report_type, "error": f"{type(e).__name__}: {e}"})
    return {"client_id": client["client_id"], "customer_id": cid,
            "window": [start.isoformat(), end.isoformat()], "reports": reports}


def sync_all(engine=None, *, specs=DEFAULT_SPECS, today=None, window=None, api=None):
    """Sync every client that has a google_customer_id. One shared API client (the MCC login
    account can query all child accounts). Clients without a customer id are reported skipped.
    `window` (start, end) overrides the default rolling window for a historical backfill."""
    engine = engine or get_engine()
    init_db(engine)
    api = api or GoogleAdsApiClient.from_env()
    start, end = window if window else pull_window(today)
    out = []
    for client in list_clients(engine):
        if not client.get("google_customer_id"):
            out.append({"client_id": client["client_id"], "skipped": "no google_customer_id"})
            continue
        out.append(sync_client(engine, client, specs=specs, today=today, window=window, api=api))
    return {"window": [start.isoformat(), end.isoformat()], "synced": out}


def sync_one(engine, client_id, **kw):
    """Convenience: look up a client by id and sync it."""
    client = get_client(engine, client_id)
    if not client:
        return {"client_id": client_id, "error": "unknown client"}
    return sync_client(engine, client, **kw)


# --- dry run / parity check: pull + summarize, but WRITE NOTHING -------------------------
_TOTAL_SLUGS = ("clicks", "impr", "cost", "conversions", "conv_value")


def preview_client(client, *, specs=DEFAULT_SPECS, today=None, window=None, api=None, sample=2):
    """Pull each report for the window and return row counts + metric totals (and a couple of
    sample rows) WITHOUT touching the database. `window` (start, end) overrides the default
    rolling window — used to probe an account's history. Safe to run against a production env."""
    cid = client.get("google_customer_id")
    if not cid:
        return {"client_id": client.get("client_id"), "skipped": "no google_customer_id", "reports": []}
    start, end = window if window else pull_window(today)
    api = api or GoogleAdsApiClient.from_env()
    reports = []
    for spec in specs:
        try:
            n, totals, samples = 0, {k: 0.0 for k in _TOTAL_SLUGS}, []
            for raw in api.stream(cid, build_query(spec, start, end)):
                row = convert_row(spec, raw)
                n += 1
                for k in _TOTAL_SLUGS:
                    v = row.get(k)
                    if v is not None:
                        try:
                            totals[k] += float(v)
                        except (TypeError, ValueError):
                            pass
                if len(samples) < sample:
                    samples.append(row)
            reports.append({"report_type": spec.report_type, "rows": n,
                            "totals": {k: round(v, 2) for k, v in totals.items()}, "sample": samples})
        except Exception as e:                        # keep going; never leak a credential
            reports.append({"report_type": spec.report_type, "error": f"{type(e).__name__}: {e}"})
    return {"client_id": client["client_id"], "customer_id": cid,
            "window": [start.isoformat(), end.isoformat()], "wrote_to_db": False, "reports": reports}


def preview_one(engine, client_id, **kw):
    client = get_client(engine, client_id)
    if not client:
        return {"client_id": client_id, "error": "unknown client"}
    return preview_client(client, **kw)


def _metric_free_query(spec, start, end, limit=1):
    """A query with the metric columns removed (+ LIMIT) — validates that the resource and the
    ENTITY/segment field names are accepted by the live API. Works even on a manager account,
    which rejects metric requests, so it's usable when only the MCC is reachable."""
    fields = [p for (p, _slug, _kind) in spec.fields if not p.startswith("metrics.")]
    q = f"SELECT {', '.join(fields)} FROM {spec.resource}"
    if spec.dated:
        q += f" WHERE segments.date BETWEEN '{start:%Y-%m-%d}' AND '{end:%Y-%m-%d}'"
    return q + f" LIMIT {limit}"


def validate_queries(customer_id, *, specs=DEFAULT_SPECS, today=None, api=None):
    """Run a metric-free probe of every report's query against `customer_id` to confirm the API
    accepts each resource + non-metric field name. Metric fields aren't exercised here (a manager
    account rejects metrics) — those get checked once a data-bearing account is reachable."""
    start, end = pull_window(today)
    api = api or GoogleAdsApiClient.from_env()
    checks = []
    for spec in specs:
        try:
            rows = list(api.stream(customer_id, _metric_free_query(spec, start, end)))
            checks.append({"report_type": spec.report_type, "resource": spec.resource,
                           "ok": True, "rows_seen": len(rows)})
        except Exception as e:
            checks.append({"report_type": spec.report_type, "resource": spec.resource,
                           "ok": False, "error": f"{type(e).__name__}: {e}"})
    return {"window": [start.isoformat(), end.isoformat()],
            "note": "metric fields not exercised here (needs a non-manager account with data)",
            "checks": checks}


if __name__ == "__main__":       # CLI entry for Railway's native cron: `py -m engine.adsapi.sync`
    import json
    print(json.dumps(sync_all(), indent=2, default=str))
