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
import json
from collections import Counter

from ..ingest.store import get_engine, init_db
from ..ingest import service
from ..bundle.assemble import build_bundle
from .analytics import analytics_engine, RouterEngine


def _canon(x, nd=4):
    """Canonical, order- and float-noise-insensitive form: numbers rounded to nd
    decimals, dict keys sorted, and nested lists sorted by content. Two lists that hold
    the same rows differ only by order/last-decimal summation noise -> equal canon."""
    if isinstance(x, bool):
        return x
    if isinstance(x, (int, float)):
        return round(float(x), nd)
    if isinstance(x, dict):
        return {k: _canon(v, nd) for k, v in sorted(x.items(), key=lambda kv: str(kv[0]))}
    if isinstance(x, list):
        return sorted((_canon(v, nd) for v in x), key=lambda z: json.dumps(z, sort_keys=True, default=str))
    return x


def _key(x):
    return json.dumps(_canon(x), sort_keys=True, default=str)


def _equal(a, b, atol, rtol):
    """Deep, order-insensitive, rounding-tolerant equality (no diff paths — used to pair
    list elements). Numbers match within atol + rtol*|a|; lists match as multisets under
    the same rule; dicts match key-for-key."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= atol + rtol * abs(a)
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k], atol, rtol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return False
        rem = list(b)
        for x in a:
            j = next((i for i, y in enumerate(rem) if _equal(x, y, atol, rtol)), None)
            if j is None:
                return False
            rem.pop(j)
        return True
    return a == b


def diff(a, b, path="", tol=1e-6, out=None, atol=0.02, rtol=1e-3):
    """Recursive PG-vs-BQ diff. Numbers compare within atol + rtol*|a| (so a value that
    lands on the other side of a display-rounding boundary from float-summation-order
    noise isn't a mismatch). LISTS pair elements order-insensitively via _equal, so tied-
    row ordering isn't a mismatch either; only genuinely different rows are reported."""
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
                diff(a[k], b[k], f"{path}.{k}", tol, out, atol, rtol)
    elif isinstance(a, list) and isinstance(b, list):
        rem = list(range(len(b)))
        pg_only = []
        for x in a:
            j = next((i for i in rem if _equal(x, b[i], atol, rtol)), None)
            if j is None:
                pg_only.append(x)
            else:
                rem.remove(j)
        bq_only = [b[i] for i in rem]
        if pg_only or bq_only:
            out.append(f"{path}: list content differs — {len(pg_only)} PG-only, "
                       f"{len(bq_only)} BQ-only (of {len(a)}/{len(b)})")
            for e in pg_only[:3]:
                out.append(f"{path} PG-only: {_key(e)[:180]}")
            for e in bq_only[:3]:
                out.append(f"{path} BQ-only: {_key(e)[:180]}")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if abs(a - b) > atol + rtol * abs(a):
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
