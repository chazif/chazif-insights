#!/usr/bin/env python3
"""Service layer between the HTTP API and the store: clients, uploads, inventory.
Plain functions so they're verifiable without a running server."""
import datetime, re
from sqlalchemy import select, func, insert
from .store import get_engine, init_db, clients, uploads, raw_rows
from .parser import EXPECTED_REPORTS
from .load import load_folder


def slug_client(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().strip()).strip("-") or "client"


def list_clients(engine=None):
    engine = engine or get_engine(); init_db(engine)
    with engine.connect() as c:
        rows = c.execute(select(clients.c.client_id, clients.c.name, clients.c.created_at)
                         .order_by(clients.c.name)).all()
        # attach report count + latest upload per client
        out = []
        for cid, name, created in rows:
            n_reports = c.execute(select(func.count(func.distinct(uploads.c.report_type)))
                                  .where(uploads.c.client_id == cid)).scalar() or 0
            last = c.execute(select(func.max(uploads.c.uploaded_at))
                             .where(uploads.c.client_id == cid)).scalar()
            out.append(dict(client_id=cid, name=name, created_at=str(created) if created else None,
                            reports_loaded=n_reports, last_upload=str(last) if last else None))
        return out


def get_client(engine, client_id):
    with engine.connect() as c:
        r = c.execute(select(clients).where(clients.c.client_id == client_id)).first()
        return dict(r._mapping) if r else None


def create_client(name, client_id=None, engine=None):
    engine = engine or get_engine(); init_db(engine)
    cid = client_id or slug_client(name)
    if get_client(engine, cid):
        raise ValueError(f"client '{cid}' already exists")
    with engine.begin() as c:
        c.execute(insert(clients).values(
            client_id=cid, name=name,
            created_at=datetime.datetime.now(datetime.timezone.utc), config=None))
    return dict(client_id=cid, name=name)


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
