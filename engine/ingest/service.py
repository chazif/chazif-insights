#!/usr/bin/env python3
"""Service layer between the HTTP API and the store: clients, uploads, inventory.
Plain functions so they're verifiable without a running server."""
import datetime, re, os, glob, time
from collections import defaultdict
from sqlalchemy import select, func, insert, update, delete, inspect
from .store import get_engine, init_db, clients, uploads, raw_rows, term_relevance, client_locations, geo_cache
from .store import metadata as _ingest_md
from .parser import (EXPECTED_REPORTS, account_cols, date_column, infer_date_order,
                     read_csv_header, iter_csv_rows)
from .load import load_folder, replace_report, replace_report_bq
from ..warehouse import bq
from ..geocode import geocode
from ..clientconfig import sanitize, merged


def list_locations(client_id, engine=None):
    """All saved physical locations for a client (for the Map tab + Setup screen)."""
    engine = engine or get_engine(); init_db(engine)
    with engine.connect() as c:
        rows = c.execute(select(client_locations).where(client_locations.c.client_id == client_id)
                         .order_by(client_locations.c.id)).all()
    return [dict(r._mapping) for r in rows]


def add_location(client_id, name, address, engine=None):
    """Geocode the address once and store the location. Returns the new row (with a
    `geocoded` flag so the UI can warn when an address couldn't be placed on the map)."""
    engine = engine or get_engine(); init_db(engine)
    coords = geocode(address)
    lat, lng = coords if coords else (None, None)
    with engine.begin() as c:
        res = c.execute(insert(client_locations).values(
            client_id=client_id, name=name, address=address, lat=lat, lng=lng,
            created_at=datetime.datetime.now(datetime.timezone.utc)))
        loc_id = res.inserted_primary_key[0]
    return {"id": loc_id, "client_id": client_id, "name": name, "address": address,
            "lat": lat, "lng": lng, "geocoded": coords is not None}


def delete_location(client_id, loc_id, engine=None):
    """Remove one location by id (scoped to the client so ids can't cross clients)."""
    engine = engine or get_engine(); init_db(engine)
    with engine.begin() as c:
        c.execute(delete(client_locations).where(
            (client_locations.c.id == loc_id) & (client_locations.c.client_id == client_id)))


def _norm_place(s):
    return " ".join(str(s or "").strip().lower().split())


def geocode_places(places, engine=None, budget=8):
    """Resolve place names to coordinates for the map's city bubbles, cache-first and
    progressive. Returns already-cached hits immediately and geocodes at most `budget`
    of the still-unknown places this call (Nominatim caps at ~1 req/s, so a batch is
    rate-limited); the rest come back as `pending` for the client to fetch on a follow-up.
    Failures are cached too, so an unfindable place is never retried. Never raises for a
    single bad name — the map simply shows fewer bubbles.

    -> {"resolved": {original_place: {"lat", "lng"}}, "pending": <count not yet tried>}."""
    engine = engine or get_engine(); init_db(engine)
    pairs, seen = [], set()
    for p in places or []:
        n = _norm_place(p)
        if n and n not in seen:
            seen.add(n); pairs.append((p, n))
    if not pairs:
        return {"resolved": {}, "pending": 0}
    norms = [n for _, n in pairs]
    with engine.connect() as c:
        cached = {r.place: r for r in c.execute(
            select(geo_cache.c.place, geo_cache.c.lat, geo_cache.c.lng, geo_cache.c.ok)
            .where(geo_cache.c.place.in_(norms))).all()}

    resolved, to_fetch = {}, []
    for orig, n in pairs:
        row = cached.get(n)
        if row is None:
            to_fetch.append((orig, n))
        elif row.ok and row.lat is not None:
            resolved[orig] = {"lat": row.lat, "lng": row.lng}
        # ok == 0 -> known-unfindable, skip silently

    now = datetime.datetime.now(datetime.timezone.utc)
    fetched = 0
    for orig, n in to_fetch:
        if fetched >= budget:
            break
        coords = geocode(orig)                 # the original carries fuller context (", State, Country")
        fetched += 1
        try:
            with engine.begin() as c:
                c.execute(insert(geo_cache).values(
                    place=n, lat=(coords[0] if coords else None),
                    lng=(coords[1] if coords else None), ok=1 if coords else 0, created_at=now))
        except Exception:
            pass                                # a concurrent insert already cached it — fine
        if coords:
            resolved[orig] = {"lat": coords[0], "lng": coords[1]}
        if fetched < budget:
            time.sleep(1.1)                     # respect Nominatim's ~1 req/s policy
    return {"resolved": resolved, "pending": max(0, len(to_fetch) - fetched)}


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
        # Header-only read + streamed row counting: constant memory, so a 70 MB+ MCC
        # export no longer OOMs the worker (which surfaced as an HTTP 502 on Preview).
        head = read_csv_header(path)
        if not head or not head["report_type"]:
            unknown.append(name); continue
        rtype = head["report_type"]
        cols = head["columns"]
        cidc, namec = account_cols(cols)
        nrows = 0
        if not (cidc or namec):                          # single-account file -> one bucket
            key = "__single__:" + name
            a = accounts.setdefault(key, {"customer_id": None, "account_name": None, "reports": {}, "rows": 0, "single_file": name})
            for _ in iter_csv_rows(path, cols):
                nrows += 1
            a["reports"][rtype] = a["reports"].get(rtype, 0) + nrows; a["rows"] += nrows
        else:
            for row in iter_csv_rows(path, cols):
                nrows += 1
                cid = row.get(cidc) if cidc else None
                nm = row.get(namec) if namec else None
                key = _account_key(cid, nm)
                a = accounts.setdefault(key, {"customer_id": cid, "account_name": nm, "reports": {}, "rows": 0})
                if cid and not a["customer_id"]: a["customer_id"] = cid
                if nm and not a["account_name"]: a["account_name"] = nm
                a["reports"][rtype] = a["reports"].get(rtype, 0) + 1; a["rows"] += 1
        files.append({"file": name, "report_type": rtype, "has_account": bool(cidc or namec), "rows": nrows})
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
        # Streamed ingest (constant memory): header-only read + per-account row streaming, so a
        # large MCC export no longer materializes the whole file (which OOM-killed the worker).
        # replace_report/replace_report_bq consume the row iterator lazily in chunks.
        head = read_csv_header(path)
        if not head or not head["report_type"]:
            continue
        rtype = head["report_type"]
        cols = head["columns"]
        cidc, namec = account_cols(cols)
        date_col = date_column(cols)
        # Lazy, short-circuiting scan for D/M vs M/D — reads only until a date disambiguates.
        order = infer_date_order(r.get(date_col) for r in iter_csv_rows(path, cols)) if date_col else "mdy"
        writer = replace_report_bq if bq.active() else replace_report

        def rows_for(target_key):
            """Stream just one account's rows (or the whole file for a single-account export)."""
            for row in iter_csv_rows(path, cols):
                if target_key is None or _account_key(
                        row.get(cidc) if cidc else None, row.get(namec) if namec else None) == target_key:
                    yield row

        with engine.begin() as conn:
            if not (cidc or namec):                              # single-account file -> one group
                key = "__single__:" + name
                client_id = key_to_client.get(key)
                if not client_id:
                    skipped.append({"key": key, "report_type": rtype,
                                    "rows": sum(1 for _ in iter_csv_rows(path, cols))})
                    continue
                n = writer(conn, client_id, rtype, rows_for(None), name,
                           head["window_raw"], head["window_start"], head["window_end"], now,
                           date_col=date_col, order=order)
                results.append({"client_id": client_id, "report_type": rtype, "rows": n, "file": name})
                continue
            # Multi-account: cheap count pass gives every account key present (constant memory —
            # counts only, no rows retained), then stream each account's rows into the writer.
            counts = defaultdict(int)
            for row in iter_csv_rows(path, cols):
                counts[_account_key(row.get(cidc) if cidc else None, row.get(namec) if namec else None)] += 1
            for key, cnt in counts.items():
                client_id = key_to_client.get(key)
                if not client_id:
                    skipped.append({"key": key, "report_type": rtype, "rows": cnt}); continue
                n = writer(conn, client_id, rtype, rows_for(key), name,
                           head["window_raw"], head["window_start"], head["window_end"], now,
                           date_col=date_col, order=order)
                results.append({"client_id": client_id, "report_type": rtype, "rows": n, "file": name})
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


def delete_client(client_id, engine=None):
    """Permanently remove a client and ALL its data across every store (ingest uploads/raw_rows/
    QS history/term relevance, budget-intel, decisions). Child rows before parents (FK-safe);
    tables absent from this DB are skipped. Returns the removed client_id."""
    engine = engine or get_engine(); init_db(engine)
    metadatas = [_ingest_md]
    try:
        from ..budget_intel import tables as _bi
        metadatas.append(_bi.metadata)
    except Exception:   # noqa: BLE001 — optional store
        pass
    try:
        from ..decisions import tables as _dec
        metadatas.append(_dec.metadata)
    except Exception:   # noqa: BLE001
        pass
    with engine.begin() as c:
        insp = inspect(c)
        for md in metadatas:
            for t in reversed(md.sorted_tables):        # children first (intra-store FKs)
                if "client_id" in t.c and insp.has_table(t.name):
                    c.execute(t.delete().where(t.c.client_id == client_id))
    return {"deleted": client_id}


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
