#!/usr/bin/env python3
"""Service layer between the HTTP API and the store: clients, uploads, inventory.
Plain functions so they're verifiable without a running server."""
import datetime, re, os, glob
from collections import defaultdict
from sqlalchemy import select, func, insert, update
from .store import get_engine, init_db, clients, uploads, raw_rows, term_relevance
from .parser import EXPECTED_REPORTS, parse_csv, account_cols, date_column, infer_date_order
from .load import load_folder, replace_report, replace_report_bq
from ..warehouse import bq
from ..clientconfig import sanitize, merged


def slug_client(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().strip()).strip("-") or "client"


def _norm_cid(v):
    """Google customer id normalized to digits ('463-194-5864' -> '4631945864'). None if empty."""
    n = re.sub(r"\D", "", str(v or ""))
    return n or None


def list_clients(engine=None):
    engine = engine or get_engine(); init_db(engine)
    with engine.connect() as c:
        rows = c.execute(select(clients.c.client_id, clients.c.name, clients.c.created_at,
                                clients.c.google_customer_id).order_by(clients.c.name)).all()
        # attach report count + latest upload per client
        out = []
        for cid, name, created, gcid in rows:
            n_reports = c.execute(select(func.count(func.distinct(uploads.c.report_type)))
                                  .where(uploads.c.client_id == cid)).scalar() or 0
            last = c.execute(select(func.max(uploads.c.uploaded_at))
                             .where(uploads.c.client_id == cid)).scalar()
            out.append(dict(client_id=cid, name=name, created_at=str(created) if created else None,
                            google_customer_id=gcid, reports_loaded=n_reports,
                            last_upload=str(last) if last else None))
        return out


def get_client(engine, client_id):
    with engine.connect() as c:
        r = c.execute(select(clients).where(clients.c.client_id == client_id)).first()
        return dict(r._mapping) if r else None


def create_client(name, client_id=None, engine=None, google_customer_id=None, mcc_id=None):
    engine = engine or get_engine(); init_db(engine)
    cid = client_id or slug_client(name)
    if get_client(engine, cid):
        raise ValueError(f"client '{cid}' already exists")
    with engine.begin() as c:
        c.execute(insert(clients).values(
            client_id=cid, name=name, google_customer_id=_norm_cid(google_customer_id), mcc_id=mcc_id,
            created_at=datetime.datetime.now(datetime.timezone.utc), config=None))
    return dict(client_id=cid, name=name, google_customer_id=_norm_cid(google_customer_id))


def set_customer_id(client_id, google_customer_id, engine=None):
    """Attach a Google customer id to a client so future MCC dumps auto-map to it."""
    engine = engine or get_engine()
    n = _norm_cid(google_customer_id)
    if not n:
        return
    with engine.begin() as c:
        c.execute(update(clients).where(clients.c.client_id == client_id).values(google_customer_id=n))


def _account_client_map(engine):
    """(cid -> client_id, name_lower -> client_id) from the clients table, for MCC resolution."""
    cid_map, name_map = {}, {}
    with engine.connect() as c:
        for cid_slug, name, gcid in c.execute(select(
                clients.c.client_id, clients.c.name, clients.c.google_customer_id)):
            if gcid:
                cid_map[_norm_cid(gcid)] = cid_slug
            if name:
                name_map[str(name).strip().lower()] = cid_slug
    return cid_map, name_map


def _account_key(cid, name):
    return _norm_cid(cid) or (str(name).strip().lower() if name else "unknown")


def preview_mcc(folder, engine=None):
    """Parse an MCC export folder and report the accounts inside it (grouped by the
    Account/Customer-ID column) with a suggested mapping to existing clients. No writes."""
    engine = engine or get_engine(); init_db(engine)
    cid_map, name_map = _account_client_map(engine)
    accounts, files, unknown = {}, [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        name = os.path.basename(path)
        parsed = parse_csv(path)
        if not parsed or not parsed["report_type"]:
            unknown.append(name); continue
        rtype = parsed["report_type"]
        cidc, namec = account_cols(parsed["columns"])
        files.append({"file": name, "report_type": rtype, "has_account": bool(cidc or namec), "rows": len(parsed["rows"])})
        if not (cidc or namec):                          # single-account file -> one bucket
            key = "__single__:" + name
            a = accounts.setdefault(key, {"customer_id": None, "account_name": None, "reports": {}, "rows": 0, "single_file": name})
            a["reports"][rtype] = a["reports"].get(rtype, 0) + len(parsed["rows"]); a["rows"] += len(parsed["rows"])
            continue
        for row in parsed["rows"]:
            cid = row.get(cidc) if cidc else None
            nm = row.get(namec) if namec else None
            key = _account_key(cid, nm)
            a = accounts.setdefault(key, {"customer_id": cid, "account_name": nm, "reports": {}, "rows": 0})
            if cid and not a["customer_id"]: a["customer_id"] = cid
            if nm and not a["account_name"]: a["account_name"] = nm
            a["reports"][rtype] = a["reports"].get(rtype, 0) + 1; a["rows"] += 1
    out = []
    for key, a in accounts.items():
        client_id = (cid_map.get(_norm_cid(a["customer_id"])) if a["customer_id"] else None) \
            or (name_map.get(str(a["account_name"]).strip().lower()) if a["account_name"] else None)
        out.append({"key": key, "customer_id": a["customer_id"], "account_name": a.get("account_name"),
                    "rows": a["rows"], "reports": a["reports"],
                    "client_id": client_id, "status": "matched" if client_id else "new",
                    "suggested_slug": slug_client(a.get("account_name") or a.get("customer_id") or key)})
    return {"accounts": sorted(out, key=lambda x: -x["rows"]), "files": files, "unknown_files": unknown}


def commit_mcc(folder, mapping, engine=None):
    """Ingest an MCC folder using a confirmed {account_key -> target} mapping. Each target is
    {'client_id': existing} or {'create': True, 'name', 'slug'?}. Rows split by account; the
    per-(client, report) snapshot-replace runs for each account. Unmapped accounts are skipped."""
    engine = engine or get_engine(); init_db(engine)
    now = datetime.datetime.now(datetime.timezone.utc)

    key_to_client = {}
    for key, m in (mapping or {}).items():
        m = m or {}
        cid = m.get("customer_id")
        if m.get("client_id"):
            key_to_client[key] = m["client_id"]
            if cid:
                set_customer_id(m["client_id"], cid, engine)
        elif m.get("create"):
            name = m.get("name") or key
            slug = m.get("slug") or slug_client(name)
            if not get_client(engine, slug):
                create_client(name, client_id=slug, engine=engine, google_customer_id=cid)
            elif cid:
                set_customer_id(slug, cid, engine)
            key_to_client[key] = slug

    results, skipped = [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        name = os.path.basename(path)
        parsed = parse_csv(path)
        if not parsed or not parsed["report_type"]:
            continue
        rtype = parsed["report_type"]
        cidc, namec = account_cols(parsed["columns"])
        date_col = date_column(parsed["columns"])
        order = infer_date_order(r.get(date_col) for r in parsed["rows"]) if date_col else "mdy"
        groups = defaultdict(list)
        if not (cidc or namec):
            groups["__single__:" + name] = parsed["rows"]
        else:
            for row in parsed["rows"]:
                groups[_account_key(row.get(cidc) if cidc else None, row.get(namec) if namec else None)].append(row)
        writer = replace_report_bq if bq.active() else replace_report
        with engine.begin() as conn:
            for key, rows in groups.items():
                client_id = key_to_client.get(key)
                if not client_id:
                    skipped.append({"key": key, "report_type": rtype, "rows": len(rows)}); continue
                writer(conn, client_id, rtype, rows, name,
                       parsed["window_raw"], parsed["window_start"], parsed["window_end"], now,
                       date_col=date_col, order=order)
                results.append({"client_id": client_id, "report_type": rtype, "rows": len(rows), "file": name})
    return {"ingested": results, "skipped": skipped}


def get_config(client_id, engine=None, with_defaults=True):
    """Return the client's stored config (merged over defaults unless with_defaults=False)."""
    engine = engine or get_engine(); init_db(engine)
    with engine.connect() as c:
        row = c.execute(select(clients.c.config).where(clients.c.client_id == client_id)).first()
    if row is None:
        return None
    raw = row[0] or {}
    if isinstance(raw, str):
        import json
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            raw = {}
    return merged(raw) if with_defaults else raw


def update_config(client_id, payload, engine=None):
    """Merge the sanitized payload over the stored config (partial updates don't wipe
    other fields); invalidate cached term relevance since the context changed."""
    engine = engine or get_engine(); init_db(engine)
    if not get_client(engine, client_id):
        raise ValueError(f"unknown client '{client_id}'")
    existing = get_config(client_id, engine=engine, with_defaults=False) or {}
    clean = sanitize(payload or {})
    stored = dict(existing)
    for k, v in clean.items():
        if k in ("thresholds", "benchmarks") and isinstance(existing.get(k), dict):
            merged_d = dict(existing[k]); merged_d.update(v); stored[k] = merged_d
        else:
            stored[k] = v
    with engine.begin() as c:
        c.execute(update(clients).where(clients.c.client_id == client_id).values(config=stored))
        c.execute(term_relevance.delete().where(term_relevance.c.client_id == client_id))
    return merged(stored)


def inventory(client_id, engine=None):
    """Per-report coverage for a client + present/missing vs the expected set."""
    engine = engine or get_engine(); init_db(engine)
    with engine.connect() as c:
        rows = c.execute(select(
            uploads.c.report_type, uploads.c.source_file, uploads.c.window_raw,
            uploads.c.row_count, uploads.c.uploaded_at
        ).where(uploads.c.client_id == client_id).order_by(uploads.c.report_type)).all()
    present = [r[0] for r in rows]
    reports = [dict(report_type=r[0], source_file=r[1], window=r[2],
                    rows=r[3], uploaded_at=str(r[4]) if r[4] else None) for r in rows]
    missing = [r for r in EXPECTED_REPORTS if r not in present]
    return dict(client_id=client_id, reports=reports,
                present=present, missing=missing,
                coverage=f"{len(present)}/{len(EXPECTED_REPORTS)}")


def ingest_folder(client_id, folder, engine=None):
    """Validate the client exists, then load a folder of CSVs and return inventory."""
    engine = engine or get_engine(); init_db(engine)
    if not get_client(engine, client_id):
        raise ValueError(f"unknown client '{client_id}' — create it first")
    result = load_folder(client_id, folder, engine=engine)
    return dict(loaded=[dict(report_type=r[0], source_file=r[1], window=r[2], rows=r[3])
                        for r in result["loaded"]],
                unmapped=result["unmapped"],
                inventory=inventory(client_id, engine=engine))
