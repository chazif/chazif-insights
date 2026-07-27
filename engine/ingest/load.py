#!/usr/bin/env python3
"""Load a folder of Google Ads CSV exports into the raw landing warehouse for one client.

Snapshot semantics (idempotent): re-loading a report for the same client REPLACES
that client's rows for that report (Google exports are full snapshots). Loading a
new client ADDS alongside the others.

Usage:
  py -m engine.ingest.load --client chiarelli --dir "C:\\path\\to\\csv folder"
  # DATABASE_URL env -> Postgres; unset -> local data/dev.db (SQLite)
"""
import argparse, datetime, glob, json, os
from sqlalchemy import delete, select, func

from .parser import (parse_csv, stream_report, to_number, CORE_METRICS, ENTITY_COL,
                     EXPECTED_REPORTS, date_column, infer_date_order, normalize_date,
                     SHARE_SLUGS, impr_share_frac)
from .store import get_engine, init_db, uploads, raw_rows

CHUNK = 5000

# Fields that must NOT be overwritten on re-upload — Quality Score and its components
# are point-in-time; we keep the earliest measured value so QS history isn't lost.
PRESERVE_ON_REUPLOAD = {"search_keyword_qs": ["quality_score", "exp_ctr", "ad_relevance", "landing_page_exp"]}


def _kw_key(row):
    return (row.get("search_keyword"), row.get("search_keyword_match_type"),
            row.get("campaign"), row.get("ad_group"))


def _row_record(client_id, upload_id, rtype, idx, row, date_col=None, order="mdy"):
    ent_col = ENTITY_COL.get(rtype)
    date_raw = row.get(date_col) if date_col else None
    rec = dict(
        client_id=client_id, upload_id=upload_id, report_type=rtype, row_index=idx,
        campaign=row.get("campaign"), ad_group=row.get("ad_group"),
        entity=(row.get(ent_col) if ent_col else None),
        date=date_raw,
        date_norm=normalize_date(date_raw, order),
        row=row,
    )
    for slug, canon in CORE_METRICS.items():
        rec[canon] = to_number(row.get(slug))
    # Impression share -> fraction, and reverse-engineered eligible impressions so a
    # rollup can weight IS correctly: weighted IS = Σ impressions / Σ eligible_impr.
    share = impr_share_frac(next((row[s] for s in SHARE_SLUGS if s in row), None))
    rec["impr_share"] = share
    rec["eligible_impr"] = (rec["impressions"] / share) if (share and rec["impressions"] is not None) else None
    return rec


def replace_report(conn, client_id, rtype, rows, source_file, window_raw, window_start, window_end, now,
                   date_col=None, order="mdy"):
    """Snapshot-replace one client's rows for one report_type within an open transaction.
    Reused by single-account (load_folder) and MCC (per-account) ingestion. `rows` may be
    a list OR a lazy iterator (streaming ingest) — it's consumed once, in CHUNK batches,
    so peak memory stays flat regardless of file size. `date_col`/`order` drive the
    normalized date_norm per row. Returns the number of rows written."""
    preserve_fields = PRESERVE_ON_REUPLOAD.get(rtype)
    old = conn.execute(select(uploads.c.upload_id).where(
        (uploads.c.client_id == client_id) & (uploads.c.report_type == rtype))).scalars().all()

    # capture QS-component values from the EXISTING rows before delete (keep earliest measured QS)
    preserve = {}
    if preserve_fields and old:
        for (rj,) in conn.execute(select(raw_rows.c.row).where(raw_rows.c.upload_id.in_(old))):
            d = rj if isinstance(rj, dict) else (json.loads(rj) if rj else {})
            kept = {f: d.get(f) for f in preserve_fields if d.get(f) is not None}
            if kept:
                preserve[_kw_key(d)] = kept

    if old:
        conn.execute(delete(raw_rows).where(raw_rows.c.upload_id.in_(old)))
        conn.execute(delete(uploads).where(uploads.c.upload_id.in_(old)))

    # row_count is filled in after streaming, since `rows` may be a lazy iterator.
    res = conn.execute(uploads.insert().values(
        client_id=client_id, report_type=rtype, source_file=source_file,
        window_raw=window_raw, window_start=window_start, window_end=window_end,
        row_count=0, uploaded_at=now))
    upload_id = res.inserted_primary_key[0]

    batch, n = [], 0
    for row in rows:
        if preserve:
            ov = preserve.get(_kw_key(row))
            if ov:
                row = dict(row); row.update(ov)
        batch.append(_row_record(client_id, upload_id, rtype, n, row, date_col, order))
        n += 1
        if len(batch) >= CHUNK:
            conn.execute(raw_rows.insert(), batch); batch = []
    if batch:
        conn.execute(raw_rows.insert(), batch)
    conn.execute(uploads.update().where(uploads.c.upload_id == upload_id).values(row_count=n))
    return n


def load_folder(client_id, folder, engine=None):
    engine = engine or get_engine()
    init_db(engine)
    now = datetime.datetime.now(datetime.timezone.utc)

    loaded, unmapped = [], []
    for path in sorted(glob.glob(os.path.join(folder, "*.csv"))):
        name = os.path.basename(path)
        info, rows = stream_report(path)          # streaming parse: constant memory
        if not info:
            unmapped.append(name)
            continue
        if not info["report_type"]:
            rows.close()                          # release the file handle we won't read
            unmapped.append(name)
            continue
        rtype = info["report_type"]
        date_col = date_column(info["columns"])
        order = "mdy"
        if date_col:                              # cheap pre-pass to infer D/M vs M/D (short-circuits)
            _i2, rows2 = stream_report(path)
            try:
                order = infer_date_order(r.get(date_col) for r in rows2)
            finally:
                rows2.close()
        with engine.begin() as conn:
            n = replace_report(conn, client_id, rtype, rows, name,
                               info["window_raw"], info["window_start"], info["window_end"], now,
                               date_col=date_col, order=order)
        loaded.append((rtype, name, info["window_raw"], n))
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
