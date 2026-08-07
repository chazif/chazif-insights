# Ingestion: merge-by-window (stop wiping history on upload)

Status: **implemented on `fix/ingest-merge-by-window`** (off `main`). Ships to production.

## The bug

`replace_report` (engine/ingest/load.py) treats every upload as a **full snapshot**:
it deletes *all* of a client's rows for that `report_type`, then inserts the new file.
So uploading July's export wipes June — the user's report: *"I uploaded new data and the
app did not keep the historical data."*

Quality Score is already handled correctly and separately: `qs_history` is append-only and
**frozen** per `(keyword, as-of-date)` — a later pull never overwrites a measured value.
That stays exactly as-is (Google only returns the *latest* QS regardless of date range, so
it can't be merged by window like the rest). This change does **not** touch QS history.

## The fix

Replace the blanket delete with a **windowed merge**, keyed on the export's date window
`[window_start, window_end]` (present in every Google Ads export header) and on whether the
report carries per-row dates (`date_col` present → rows get `date_norm`).

**Dated reports** (per-row `date_norm` — e.g. campaign_performance, and every report
re-uploaded day/month-segmented; for real accounts this is the large majority):
- Delete existing rows whose `date_norm` falls in the new window `[ns, ne]` — the overlap is
  replaced.
- Delete undated rows from any *older* upload whose window overlaps `[ns, ne]` — so a stale
  whole-window snapshot can't linger beside fresh dated data.
- Insert the new upload's rows.
- Drop uploads left with zero rows, so Data Inventory stays honest.
- **Result:** non-overlapping history (earlier/later dates) is preserved; overlapping dates
  are replaced by the newer data. Append + overlap-replace, exactly as asked.

**Undated snapshot reports** (no `date_col` — one aggregate row per entity for the whole
window): keep today's **latest-snapshot-wins** behavior (delete-all then insert). Accumulating
multiple undated snapshots would double-count in the bundle (its aggregations keep all
NULL-`date_norm` rows regardless of the requested range), so we deliberately do **not**
accumulate these. History for undated reports would require making the bundle window-aware for
NULL-date rows — out of scope here, and low-value since most reports are dated in practice.

## Why this is safe

- Fixes history where it is date-meaningful (the dated reports that drive trends), with no
  double-count regression for undated reports.
- QS freeze is untouched.
- Same code path serves single-account (`load_folder`) and MCC (`commit_mcc`) ingestion.
- Streaming/constant-memory ingest is preserved (rows still consumed once in CHUNK batches).
- Idempotent: re-uploading the same window reproduces the same state (overlap replaced by an
  identical set).

## BigQuery path

`replace_report_bq` mirrors the same semantics (BigQuery is inactive in production today, but
the code stays consistent): a new `bq.delete_report_window(client, report, ns, ne)` removes the
overlapping date range from `raw_rows`; the Postgres uploads ledger drops only overlapping
uploads; QS still MERGEs append-only. Undated reports keep the full `bq.delete_report`.

## Tests (`tests/test_ingest_merge.py`)

Throwaway SQLite (same dialect posture as dev). Covers: append preserves non-overlapping
history; overlapping window replaces; undated report is latest-wins; QS history stays frozen
across re-upload; empty uploads are cleaned up; idempotent re-upload.
