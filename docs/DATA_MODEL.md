# Data Model — v0.1 (Phase 1: raw landing warehouse)

The ingestion layer lands uploaded Google Ads CSV exports into a per-client raw
warehouse. The engine (Phase 2) reads this to produce the DATA bundle.

**Data layer:** SQLAlchemy Core. `DATABASE_URL` → Railway Postgres; unset → local
`data/dev.db` (SQLite). One codebase, both dialects.

## Tables

### `uploads` — snapshot ledger
One row per `(client_id, report_type)` load. Tracks the source file, the export
window (parsed to `window_start` / `window_end`), row count, and timestamp.
Re-loading a report for a client **replaces** its prior snapshot (Google exports
are full snapshots, so replace = correct update).

### `raw_rows` — every report row
`client_id`, `upload_id`, `report_type`, `row_index`, then:
- **Typed core metrics** — `clicks`, `impressions`, `cost`, `conversions`,
  `conv_value` — pulled out for fast aggregation.
- **Entity keys** — `campaign`, `ad_group`, `entity` (the report's primary
  object: search term / keyword / placement / product / state …), indexed.
- **`date`** — the report's Month or Day when it's segmented; `null` = window
  aggregate (see grain note below).
- **`row`** (JSON) — the full slugged record, so nothing is lost and accounts
  with different column sets (simple vs complex) coexist without schema churn.

## Key design decisions

**Mixed grain.** Google's Report Editor exports most reports as a single
window-aggregate; only Campaign Performance carries `Month` and Schedule carries
`Day`. `raw_rows.date` captures per-period rows where present and is `null`
otherwise. **To get true daily** (the target cadence), the same reports must be
re-pulled **segmented by Day** — the schema already supports it; it's an
export-settings change, not a code change.

**Column-based report detection.** Report type is inferred from the header
columns, not the `AE - NN` filename. This is required: exports can ship two
`AE - 10` files with different schemas (Audiences vs a products/revenue report),
which a number-based mapper would collide. See `parser.py::detect_report`.

**JSON fidelity + typed core.** The typed columns make the common aggregations
cheap; the JSON keeps every original field for the engine. On Postgres the JSON
column is `jsonb`; on SQLite it's text — transparent via SQLAlchemy.

## Usage
```
py -m engine.ingest.load --client <id> --dir "<folder of AE-*.csv>"
```
Prints a coverage inventory (present vs the 12 expected reports) — this drives
graceful degradation: views whose reports are absent are simply not built.

## Known quirks to revisit
- `distance_from_location` cost sums higher than account spend — the report's
  cost semantics differ; low-value report, flagged for the engine phase.
- `geographic` / `pmax_placements` / `products_sold` have no plain `Cost` column
  (they carry Conv. value / Impr. / Revenue instead) — `cost` is correctly null.

## Next (Phase 1 increment 2, then Phase 2)
- Upload API + UI (multi-file drag/drop) writing through `load_folder`.
- Normalized dimensional model (Layer 2: dims + facts) built from `raw_rows`.
