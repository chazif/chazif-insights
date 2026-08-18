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


def sync_client(engine, client, *, specs=DEFAULT_SPECS, today=None, api=None, now=None):
    """Pull + ingest every report for one client. `client` is a dict with client_id and
    google_customer_id (as list_clients/get_client return). Returns a per-report summary."""
    cid = client.get("google_customer_id")
    if not cid:
        return {"client_id": client.get("client_id"), "skipped": "no google_customer_id", "reports": []}
    start, end = pull_window(today)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    window_raw = _window_raw(start, end)
    api = api or GoogleAdsApiClient.from_env()
    writer = replace_report_bq if bq.active() else replace_report

    reports = []
    for spec in specs:
        try:
            rows = (convert_row(spec, r) for r in api.stream(cid, build_query(spec, start, end)))
            with engine.begin() as conn:
                n = writer(conn, client["client_id"], spec.report_type, rows,
                           f"adsapi:{spec.report_type}", window_raw, start, end, now,
                           date_col="date", order="mdy")
            reports.append({"report_type": spec.report_type, "rows": n})
        except Exception as e:                        # keep going; never leak a credential
            reports.append({"report_type": spec.report_type, "error": f"{type(e).__name__}: {e}"})
    return {"client_id": client["client_id"], "customer_id": cid,
            "window": [start.isoformat(), end.isoformat()], "reports": reports}


def sync_all(engine=None, *, specs=DEFAULT_SPECS, today=None, api=None):
    """Sync every client that has a google_customer_id. One shared API client (the MCC login
    account can query all child accounts). Clients without a customer id are reported skipped."""
    engine = engine or get_engine()
    init_db(engine)
    api = api or GoogleAdsApiClient.from_env()
    start, end = pull_window(today)
    out = []
    for client in list_clients(engine):
        if not client.get("google_customer_id"):
            out.append({"client_id": client["client_id"], "skipped": "no google_customer_id"})
            continue
        out.append(sync_client(engine, client, specs=specs, today=today, api=api))
    return {"window": [start.isoformat(), end.isoformat()], "synced": out}


def sync_one(engine, client_id, **kw):
    """Convenience: look up a client by id and sync it."""
    client = get_client(engine, client_id)
    if not client:
        return {"client_id": client_id, "error": "unknown client"}
    return sync_client(engine, client, **kw)
