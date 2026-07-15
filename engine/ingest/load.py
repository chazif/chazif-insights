#!/usr/bin/env python3
"""Load a folder of Google Ads CSV exports into the raw landing warehouse for one client.

Snapshot semantics (idempotent): re-loading a report for the same client REPLACES
that client's rows for that report (Google exports are full snapshots). Loading a
new client ADDS alongside the others.

Usage:
  py -m engine.ingest.load --client chiarelli --dir "C:\\path\\to\\csv folder"
  # DATABASE_URL env -> Postgres; unset -> local data/dev.db (SQLite)
"""
import argparse, datetime, glob, os
from sqlalchemy import delete, select, func

from .parser import parse_csv, to_number, CORE_METRICS, ENTITY_COL, DATE_COL, EXPECTED_REPORTS
from .store import get_engine, init_db, uploads, raw_rows

CHUNK = 5000


def _row_record(client_id, upload_id, rtype, idx, row):
    ent_col = ENTITY_COL.get(rtype)
    date_col = DATE_COL.get(rtype)
    rec = dict(
        client_id=client_id, upload_id=upload_id, report_type=rtype, row_index=idx,
        campaign=row.get("campaign"), ad_group=row.get("ad_group"),
        entity=(row.get(ent_col) if ent_col else None),
        date=(row.get(date_col) if date_col else None),
        row=row,
    )
    for slug, canon in CORE_METRICS.items():
        rec[canon] = to_number(row.get(slug))
    return rec


def load_folder(client_id, folder, engine=None):
    engine = engine or get_engine()
    init_db(engine)
    now = datetime.datetime.now(datetime.timezone.utc)

    loaded, unmapped = [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        name = os.path.basename(path)
        parsed = parse_csv(path)
        if not parsed or not parsed["report_type"]:
            unmapped.append(name)
            continue
        rtype, rows = parsed["report_type"], parsed["rows"]

        with engine.begin() as conn:
            # snapshot replace for this client + report
            old = conn.execute(select(uploads.c.upload_id).where(
                (uploads.c.client_id == client_id) & (uploads.c.report_type == rtype))).scalars().all()
            if old:
                conn.execute(delete(raw_rows).where(raw_rows.c.upload_id.in_(old)))
                conn.execute(delete(uploads).where(uploads.c.upload_id.in_(old)))

            res = conn.execute(uploads.insert().values(
                client_id=client_id, report_type=rtype, source_file=name,
                window_raw=parsed["window_raw"], window_start=parsed["window_start"],
                window_end=parsed["window_end"], row_count=len(rows), uploaded_at=now))
            upload_id = res.inserted_primary_key[0]

            batch = []
            for i, row in enumerate(rows):
                batch.append(_row_record(client_id, upload_id, rtype, i, row))
                if len(batch) >= CHUNK:
                    conn.execute(raw_rows.insert(), batch); batch = []
            if batch:
                conn.execute(raw_rows.insert(), batch)

        loaded.append((rtype, name, parsed["window_raw"], len(rows)))
    return dict(loaded=loaded, unmapped=unmapped, engine=engine)


def print_inventory(client_id, result):
    loaded, unmapped = result["loaded"], result["unmapped"]
    got = {r[0] for r in loaded}
    print(f"\nIngest complete for client: {client_id}")
    print("-" * 78)
    print(f"{'Report':<26}{'Window':<34}{'Rows':>8}")
    print("-" * 78)
    for rtype, name, window, n in sorted(loaded):
        print(f"{rtype:<26}{(window or '')[:33]:<34}{n:>8,}")
    if unmapped:
        print("\nUnmapped files (skipped):")
        for u in unmapped:
            print(f"  - {u}")
    missing = [r for r in EXPECTED_REPORTS if r not in got]
    print("\nCoverage vs expected report set:")
    print(f"  present ({len(got)}): {', '.join(sorted(got))}")
    print(f"  missing ({len(missing)}): {', '.join(missing) if missing else 'none'}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--client", required=True)
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()
    res = load_folder(args.client, args.dir)
    print_inventory(args.client, res)
