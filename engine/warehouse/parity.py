#!/usr/bin/env python3
"""Phase 6: Postgres-vs-BigQuery parity check — the correctness gate before cutover.

For each client, builds the DATA bundle from Postgres and from BigQuery (via the read
router) and diffs them field by field with a float tolerance. Cutover only proceeds
once every client matches.

Run where both stores are reachable (Cloud Shell / Railway one-off) with DATABASE_URL
+ the GCP_* vars set:
  python -m engine.warehouse.parity                       # all clients
  python -m engine.warehouse.parity --client chiarelli
  python -m engine.warehouse.parity --clients a,b --tolerance 0.01
"""
import argparse

from ..ingest.store import get_engine, init_db
from ..ingest import service
from ..bundle.assemble import build_bundle
from .analytics import analytics_engine, RouterEngine


def diff(a, b, path="", tol=1e-6, out=None):
    """Recursive PG-vs-BQ diff. Numbers compare within a relative tolerance (rounding);
    everything else must be equal. Returns a list of human-readable mismatch paths."""
    out = [] if out is None else out
    if isinstance(a, bool) or isinstance(b, bool):
        if a != b:
            out.append(f"{path}: PG={a!r} BQ={b!r}")
    elif isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a:
                out.append(f"{path}.{k}: absent in PG")
            elif k not in b:
                out.append(f"{path}.{k}: absent in BQ")
            else:
                diff(a[k], b[k], f"{path}.{k}", tol, out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: list length PG={len(a)} BQ={len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                diff(x, y, f"{path}[{i}]", tol, out)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(a - b) > tol * (1 + abs(a)):
            out.append(f"{path}: PG={a} BQ={b}")
    else:
        if a != b:
            out.append(f"{path}: PG={a!r} BQ={b!r}")
    return out


def check_client(cid, pg_engine, router, tol):
    try:
        pgb = build_bundle(cid, pg_engine)
    except Exception as e:                              # noqa: BLE001
        return {"client": cid, "status": "pg_error", "detail": f"{type(e).__name__}: {e}"}
    try:
        bqb = build_bundle(cid, router)
    except Exception as e:                              # noqa: BLE001
        return {"client": cid, "status": "bq_error", "detail": f"{type(e).__name__}: {e}"}
    if pgb is None and bqb is None:
        return {"client": cid, "status": "match", "n_diffs": 0}
    if (pgb is None) != (bqb is None):
        return {"client": cid, "status": "one_none",
                "detail": f"PG={'None' if pgb is None else 'ok'} BQ={'None' if bqb is None else 'ok'}"}
    diffs = diff(pgb, bqb, tol=tol)
    return {"client": cid, "status": "match" if not diffs else "mismatch",
            "n_diffs": len(diffs), "diffs": diffs}


def run(clients=None, tol=1e-6):
    pg = get_engine(); init_db(pg)
    an = analytics_engine()
    if an is None:
        raise SystemExit("BigQuery not configured — set GCP_PROJECT/BQ_DATASET (+ creds).")
    router = RouterEngine(pg, an)
    ids = clients or [c["client_id"] for c in service.list_clients(engine=pg)]
    return [check_client(cid, pg, router, tol) for cid in ids]


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Postgres vs BigQuery bundle parity check")
    ap.add_argument("--client")
    ap.add_argument("--clients")
    ap.add_argument("--tolerance", type=float, default=1e-6)
    args = ap.parse_args()
    sel = [args.client] if args.client else (args.clients.split(",") if args.clients else None)
    results = run(sel, tol=args.tolerance)

    clean = [r for r in results if r["status"] == "match"]
    for r in results:
        head = f"[{r['status'].upper()}] {r['client']}"
        if r.get("n_diffs"):
            head += f" — {r['n_diffs']} diffs"
        if r.get("detail"):
            head += f" — {r['detail']}"
        print(head)
        for d in r.get("diffs", [])[:20]:
            print(f"    {d}")
    print(f"\n{len(clean)}/{len(results)} clients match.")
    if len(clean) != len(results):
        raise SystemExit("Parity not clean — investigate before cutover.")
    print("PARITY CLEAN — BigQuery reads match Postgres for every client.")
