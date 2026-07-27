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

from .parser import (parse_csv, stream_report, to_number, CORE_METRICS, ENTITY_COL,
                     EXPECTED_REPORTS, date_column, infer_date_order, normalize_date,
                     SHARE_SLUGS, impr_share_frac)
from .store import get_engine, init_db, uploads, raw_rows, qs_history

CHUNK = 5000


def _kw_key(row):
    return (row.get("search_keyword"), row.get("search_keyword_match_type"),
            row.get("campaign"), row.get("ad_group"))


# --- Quality Score history (append-only, frozen in time) -------------------
# Candidate column slugs per QS field; the "hist_*" variants come from Google's
# day-segmentable Historical Quality Score columns, preferred when present.
QS_FIELDS = {
    "quality_score": ("hist_quality_score", "quality_score"),
    "exp_ctr": ("hist_exp_ctr", "hist_expected_ctr", "exp_ctr", "expected_ctr"),
    "ad_relevance": ("hist_ad_relevance", "ad_relevance"),
    "landing_page_exp": ("hist_landing_page_exper", "hist_landing_page_experience",
                         "landing_page_exp", "landing_page_exper", "landing_page_experience"),
}


def _first(row, slugs):
    return next((row[s] for s in slugs if row.get(s) is not None), None)


def _rating_num(v):
    """Google component rating -> 1/2/3 (Below/Average/Above; higher is better); None else."""
    s = ("" if v is None else str(v)).strip().lower()
    if "above" in s:
        return 3
    if "below" in s:
        return 1
    if "average" in s:
        return 2
    return None


def _qs_record(client_id, row, as_of):
    """A frozen QS datapoint for one keyword as of `as_of`, or None if the row has no QS."""
    kw = row.get("search_keyword")
    if not kw or not as_of:
        return None
    qs = to_number(_first(row, QS_FIELDS["quality_score"]))
    ectr, adrel, lpx = (_rating_num(_first(row, QS_FIELDS[f]))
                        for f in ("exp_ctr", "ad_relevance", "landing_page_exp"))
    if qs is None and ectr is None and adrel is None and lpx is None:
        return None
    key = _kw_key(row)
    return dict(
        client_id=client_id, kw_key="\x1f".join("" if x is None else str(x) for x in key),
        as_of_date=as_of, search_keyword=kw, match_type=row.get("search_keyword_match_type"),
        campaign=row.get("campaign"), ad_group=row.get("ad_group"),
        quality_score=qs, exp_ctr=ectr, ad_relevance=adrel, landing_page_exp=lpx,
        exp_ctr_label=_first(row, QS_FIELDS["exp_ctr"]),
        ad_relevance_label=_first(row, QS_FIELDS["ad_relevance"]),
        landing_page_exp_label=_first(row, QS_FIELDS["landing_page_exp"]))


def _write_qs_history(conn, client_id, records):
    """Insert QS datapoints, FROZEN: an existing (keyword, as-of-date) is never
    overwritten (so a later pull with changed values can't rewrite history)."""
    dates = {r["as_of_date"] for r in records}
    existing = set()
    if dates:
        for kk, ad in conn.execute(select(qs_history.c.kw_key, qs_history.c.as_of_date).where(
                (qs_history.c.client_id == client_id) & (qs_history.c.as_of_date.in_(dates)))):
            existing.add((kk, ad))
    fresh, seen = [], set()
    for r in records:
        k = (r["kw_key"], r["as_of_date"])
        if k in existing or k in seen:
            continue
        seen.add(k); fresh.append(r)
    for i in range(0, len(fresh), CHUNK):
        conn.execute(qs_history.insert(), fresh[i:i + CHUNK])
    return len(fresh)


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
    normalized date_norm per row. For search_keyword_qs, each row's QS is also appended
    to the frozen qs_history (stamped with the row's day, else the export window-end).
    Returns the number of rows written."""
    old = conn.execute(select(uploads.c.upload_id).where(
        (uploads.c.client_id == client_id) & (uploads.c.report_type == rtype))).scalars().all()
    if old:
        conn.execute(delete(raw_rows).where(raw_rows.c.upload_id.in_(old)))
        conn.execute(delete(uploads).where(uploads.c.upload_id.in_(old)))

    # row_count is filled in after streaming, since `rows` may be a lazy iterator.
    res = conn.execute(uploads.insert().values(
        client_id=client_id, report_type=rtype, source_file=source_file,
        window_raw=window_raw, window_start=window_start, window_end=window_end,
        row_count=0, uploaded_at=now))
    upload_id = res.inserted_primary_key[0]

    collect_qs = rtype == "search_keyword_qs"
    batch, qs_records, n = [], [], 0
    for row in rows:
        if collect_qs:
            as_of = (normalize_date(row.get(date_col), order) if date_col else None) or window_end
            rec = _qs_record(client_id, row, as_of)
            if rec:
                qs_records.append(rec)
        batch.append(_row_record(client_id, upload_id, rtype, n, row, date_col, order))
        n += 1
        if len(batch) >= CHUNK:
            conn.execute(raw_rows.insert(), batch); batch = []
    if batch:
        conn.execute(raw_rows.insert(), batch)
    if qs_records:
        _write_qs_history(conn, client_id, qs_records)
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
