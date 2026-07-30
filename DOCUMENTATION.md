# SearchNex Ads — Complete Technical Documentation

> **What this is.** A single, exhaustive reference for the SearchNex Ads application: architecture, every subsystem's logic, all formulas, the data model, the API, the frontend, and the design decisions behind them. If you are new to the codebase, read §1–§3 first, then dive into whichever subsystem you're touching.

**Product:** SearchNex Ads — a multi-client, config-driven paid-search intelligence platform (by Chazif LLC). Upload Google Ads CSV/MCC exports → the engine normalizes and analyzes them → the web console renders observations, findings, recommendations, and (Module 2) a goal-driven budget allocation.

**Non-negotiable principles** (they recur everywhere below):
- The AI model **never sees account data or credentials** — deterministic Python owns all the math; the only AI touchpoint classifies *search-term text* against business context (§10).
- **Human approval before writes** — ingestion and config edits are explicit; the roadmap's action loop keeps a human in the loop.
- **Config-driven multi-tenancy** — one codebase flexes from a single-brand account to multi-brand/multi-region; no `if client == …` branching.
- **Weighted metrics, never averaged** — every rate (CTR/CVR/CPC/CPA/impression share) is derived from summed totals, never a mean of per-row rates (§8.3).
- **Constant-memory ingestion** — the Railway worker OOMs on large exports, so ingest streams end-to-end (§5).
- **Quality Score is frozen in time** — append-only history, never overwritten (§4, §5.4).

---

## Table of Contents

1. [High-level architecture](#1-high-level-architecture)
2. [Tech stack & deployment](#2-tech-stack--deployment)
3. [The data bundle contract](#3-the-data-bundle-contract)
4. [Data model (database schema)](#4-data-model-database-schema)
5. [Ingestion pipeline](#5-ingestion-pipeline)
6. [Client configuration](#6-client-configuration)
7. [The warehouse: Postgres ↔ BigQuery](#7-the-warehouse-postgres--bigquery)
8. [Bundle assembler (`build_bundle`)](#8-bundle-assembler-build_bundle)
9. [Deterministic analyzers → findings & recommendations](#9-deterministic-analyzers--findings--recommendations)
10. [LLM term relevance](#10-llm-term-relevance)
11. [Budget file parsing](#11-budget-file-parsing)
12. [Module 2 — Budget Intelligence (the DRM model)](#12-module-2--budget-intelligence-the-drm-model)
13. [Backend API](#13-backend-api)
14. [Frontend architecture](#14-frontend-architecture)
15. [Performance design (caching + parallelism)](#15-performance-design-caching--parallelism)
16. [Consolidated formula reference](#16-consolidated-formula-reference)
17. [Consolidated design decisions](#17-consolidated-design-decisions)
18. [Roadmap (ROADMAP_V2)](#18-roadmap-roadmap_v2)
19. [Repository map](#19-repository-map)

---

## 1. High-level architecture

The system is a linear pipeline with the **DATA bundle (JSON) as the contract** between the engine and the frontend:

```
CSV / MCC export
      │  (upload, streaming + gzip)
      ▼
  Ingestion  ──►  raw_rows + qs_history + uploads + clients + term_relevance   (Layer 1: raw landing warehouse)
      │
      ▼
  Bundle assembler (build_bundle)  ──►  runs ~17 section builders + 8 analyzers
      │            (reads warehouse; weighted aggregation; deterministic math)
      ▼
  DATA bundle (one JSON object)  ──►  cached per (client, filters, date range, compare)
      │
      ▼
  Web console (vanilla-JS SPA)  ──►  ~25 read-only views, filters, charts, recommendations
```

Parallel to the main pipeline, **Module 2 — Budget Intelligence** reads the same `raw_rows` warehouse but has its own tables (`bi_*`), math engine, API router, and standalone UI page (§12).

**Two-tier storage model:**
- **Layer 1 (raw landing):** `uploads` (snapshot ledger) + `raw_rows` (every report row: typed core metrics + full JSON fidelity). Plus `clients`, `term_relevance` (AI cache), `qs_history` (frozen QS). A normalized dimensional "Layer 2" is on the roadmap but not built.
- The big analytical tables (`raw_rows`, `qs_history`) can be **migrated to BigQuery** behind a single switch; the small config/ledger/cache tables always stay in Postgres (§7).

**The ROADMAP "one spine, two edges" principle:** the system is designed to serve both CSV clients and (future) Google Ads API clients through one identical core; mode differences live only in two adapter seams — the **ingestion seam** (`CsvUpload | GoogleAdsApi`) and the **activation seam** (`Manual | EditorExport | ApiWrite`). Client capabilities are two axes stored in `clients.config`: `data_source` and `activation`. Anti-pattern: any `if client.mode == "csv"`.

---

## 2. Tech stack & deployment

| Layer | Choice |
|---|---|
| Backend | FastAPI (`backend/main.py`), served by uvicorn |
| Data layer | SQLAlchemy Core (dialect-agnostic) |
| DB (local/dev) | SQLite at `<repo>/data/dev.db` |
| DB (production) | Postgres via `DATABASE_URL` (Railway) |
| Analytics warehouse (optional) | Google BigQuery (behind `USE_BIGQUERY`) |
| Frontend | Static HTML + vanilla JS (no framework/bundler); Chart.js 4.4.1 (CDN); Google Fonts |
| Math deps | `scipy` (curve fitting, lazy), `numpy` |
| AI (optional) | DeepSeek (priority) or Anthropic; only for search-term relevance |

**Deployment (Railway):**
- `Procfile`: `web: uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
- `railway.json`: NIXPACKS builder; `restartPolicyType: ON_FAILURE`, max 3 retries.
- **Single uvicorn worker** — the app relies on in-process singletons (`_JOBS`, `_BUNDLE_CACHE`, the BigQuery client, curve caches), so it must run as one process. The background-job pattern (§13) is designed around this.
- Dependencies install from `backend/requirements.txt` via Nixpacks.

**`get_engine()` (`engine/ingest/store.py`):** `url = DATABASE_URL` if set else `sqlite:///data/dev.db`. Driver normalization: `postgres://` and `postgresql://` are rewritten to `postgresql+psycopg://` (psycopg v3). Always `create_engine(url, future=True)`.

**Environment variables:**

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection; absent → local SQLite |
| `PORT` | Railway-injected uvicorn port |
| `GCP_PROJECT`, `BQ_DATASET` | Required together to enable BigQuery config |
| `BQ_LOCATION` | Dataset region (default `"US"`) |
| `GCP_SA_KEY` | Inline service-account JSON (must start with `{`); used for BigQuery auth; absent → Application Default Credentials |
| `USE_BIGQUERY` | The **cutover switch** (`1/true/yes/on`); with the config vars, flips reads/writes to BigQuery |
| `GOOGLE_APPLICATION_CREDENTIALS` | ADC path (Cloud Shell fallback) |
| `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY` | Search-term relevance LLM (only used when set) |

**`backend/requirements.txt` (why each dep):** `fastapi` (web), `uvicorn[standard]` (ASGI), `python-multipart` (uploads), `sqlalchemy>=2.0` (data layer), `psycopg[binary]>=3.1` (Postgres v3 driver), `anthropic` (relevance LLM, only when keyed), `openpyxl` (.xlsx budget files), `scipy>=1.11` (budget-intel curve fitting, imported lazily), `google-cloud-bigquery` + `sqlalchemy-bigquery` + `google-cloud-bigquery-storage` + `pyarrow` (BigQuery warehouse + fast Arrow reads, only when configured).

---

## 3. The data bundle contract

`build_bundle()` returns one JSON object — the sole contract between engine and frontend. Top-level keys:

| Key | Contents |
|---|---|
| `meta` | client_id, name, `periods {current, prior}`, `complexity {n_brands, has_pmax}`, `views` (which tabs to show), `date_range {from, to, applied, granularity, windowed_views}`, `filters`, `compare {mode, from, to, label}`, `filters_meta`, `generated_from: "warehouse"` |
| `total_trend` | monthly spend/clicks/conv/CPA/CVR time series (drives Overview chart) |
| `kpis` | KPI scorecard rows (Metric / prior / current / change) |
| `findings` | Overview findings (from analyzers) |
| `recommendations` | Recs view (from analyzers) |
| `campaigns`, `geo_performance`, `budget_pacing`, `budget_section`, `quality_score`, `keyword_section`, `qs_breakdown_section`, `region_category_section`, `keyword_regions_section`, `search_terms_section`, `ads_section`, `landing_pages_section`, `nb_categories_section`, `regions_section`, `auction_insights_section` | one per dashboard tab (§8.5) |

The frontend hides any tab whose key isn't in `meta.views`. A pre-baked `bundle.json` on disk (the "Mavis demo") bypasses computation entirely (§13).

---

## 4. Data model (database schema)

Defined in `engine/ingest/store.py` (SQLAlchemy Core, dialect-agnostic). When BigQuery is live, `raw_rows`/`qs_history` are owned by BigQuery and are **not** created in Postgres; `clients`/`uploads`/`term_relevance` always stay in Postgres.

### `clients` (Postgres always)
| Column | Type | Notes |
|---|---|---|
| `client_id` | String(64) **PK** | slug, e.g. `"chiarelli"` |
| `name` | String(256) NOT NULL | display name |
| `google_customer_id` | String(32) | Google Ads CID (digits only) — the MCC-export join key |
| `mcc_id` | String(64) | parent manager account |
| `created_at` | DateTime | UTC |
| `config` | JSON | business-context config (§6) |

### `uploads` (snapshot ledger — Postgres always)
`upload_id` (Integer **PK**, autoincrement), `client_id`, `report_type`, `source_file`, `window_raw` (raw range string from CSV line 2), `window_start`/`window_end` (Date), `row_count` (filled *after* streaming), `uploaded_at`. Index `ix_uploads_client_report (client_id, report_type)`. **One row per (client, report_type) load.**

### `raw_rows` (every report row)
| Column | Type | Purpose |
|---|---|---|
| `id` | BigInteger PK (Integer on SQLite) | surrogate |
| `client_id` | String(64) | owning client |
| `upload_id` | Integer **FK → uploads** | snapshot linkage |
| `report_type` | String(48) | denormalized |
| `row_index` | Integer | 0-based ordinal within the load (also the deterministic sort key for BigQuery parity) |
| `campaign`, `ad_group` | String(512) | if present |
| `entity` | String(1024) | the report's **primary** entity (per `ENTITY_COL[rtype]`) |
| `date` | String(32) | **raw** Month/Day cell as exported |
| `date_norm` | Date | **normalized** calendar date (day precision; month-only → 1st) — enables range filters |
| `clicks`, `impressions`, `cost`, `conversions`, `conv_value` | Float | typed core metrics (fast aggregation) |
| `impr_share` | Float | Search impression share as a **fraction** (buckets: `<10% → .05`, `>90% → .95`) |
| `eligible_impr` | Float | `impressions / impr_share` — the weight for correct weighted IS |
| `row` | JSON | full slugged record (ALL columns) — cross-account fidelity |

Indexes: `(client_id, report_type)`, `(client_id, report_type, entity)`, `(client_id, report_type, date_norm)`.

**Why the design:** typed columns exist only for fast aggregation; the JSON `row` preserves every column because simple vs complex accounts export different columns. `date_norm` normalizes Google's varied date cells so range filters work. `impr_share`/`eligible_impr` enable **weighted** impression-share rollups (`Σ impressions / Σ eligible_impr`), never an average of percentages.

### `term_relevance` (AI classification cache — Postgres always)
Composite PK `(client_id, term)`. Columns: `relevant` ("yes"/"no" — a portable string, not a bool), `category` (product/brand/competitor/unrelated), `reason`, `source` ("llm"/"heuristic"/"deepseek"), `classified_at`. Ensures the LLM classifies each term at most once.

### `qs_history` (append-only frozen Quality Score)
Composite PK `(client_id, kw_key, as_of_date)`. Columns: `search_keyword`, `match_type`, `campaign`, `ad_group`, `quality_score` (1–10 Float), `exp_ctr`/`ad_relevance`/`landing_page_exp` (Integer 1/2/3 = Below/Average/Above), and parallel `*_label` raw strings. Index `(client_id, as_of_date)`.

**Design decision:** Quality Score is point-in-time and non-additive — Google only returns the *current* value. The composite PK enforces a **freeze**: a measured value for a `(keyword, as-of-date)` is never overwritten by a later pull. This lets the app build a true QS history/trend that Google itself doesn't provide.

### `init_db(engine)` behavior
Unwraps the analytics router to the underlying Postgres engine (schema creation always targets Postgres). If `bq.active()`, `create_all` only for `[clients, uploads, term_relevance]` (so a BigQuery decommission stays torn down across restarts); else all tables. Then add-column-if-missing migrations (SQLite + Postgres): `google_customer_id`/`mcc_id` on `clients`; and `date_norm`/`impr_share`/`eligible_impr` on `raw_rows` (only if that table exists — skipped post-decommission).

---

## 5. Ingestion pipeline

Files: `engine/ingest/parser.py` (detection + parsing), `load.py` (writing), `service.py` (orchestration).

### 5.1 Report-type detection (`parser.py`)

Google exports carry a 3-line header (title, date-window, column header). Columns are **slugged**: lowercased, non-alphanumeric runs → `_`, deduped with `_1/_2` suffixes.

`detect_report(header_slugs)` order:
1. **keyword_geo** special-case first: `search_keyword` present AND any `GEO_SLUGS` present.
2. Iterate `_DETECT` (ordered required-slug → type rules), first match wins:

| Needle slug | report_type |
|---|---|
| `search_term` | search_terms |
| `search_keyword` | search_keyword_qs |
| `performance_max_placement` | pmax_placements |
| `landing_page` | landing_pages |
| `hour_of_the_day` | schedule_dow_hod |
| `audience_segment` | audiences |
| `item_id_sold` / `product_title_sold` | products_sold |
| `distance_from_location_assets` | distance_from_location |
| `display_url_domain` | auction_insights |
| `state_matched` | geographic |
| `headline_1` | ads_performance |
| `keywords_active` | ad_group_performance |
| `bid_strategy_type` | bid_strategies *(Budget Intelligence)* |

3. Fallback A: `campaign` + `campaign_type` present, no `ad_group` → **campaign_performance**.
4. Fallback B: `campaign` present, no `ad_group`, any `SHARE_SLUGS` present → **campaign_performance** (the Budget-Intelligence "Campaign - Raw" shape without a type column).
5. Else `None`.

`ENTITY_COL` maps each report_type → its primary entity column (e.g. search_terms → `search_term`, campaign_performance → `campaign`, bid_strategies → `bid_strategy`).

`EXPECTED_REPORTS` (12, the per-account coverage target): campaign_performance, ad_group_performance, search_keyword_qs, search_terms, ads_performance, landing_pages, schedule_dow_hod, audiences, geographic, pmax_placements, distance_from_location, products_sold. (`keyword_geo`, `auction_insights`, `bid_strategies` are recognized but not counted in coverage.)

**MCC detection:** `ACCOUNT_ID_SLUGS = (customer_id, account_id)`, `ACCOUNT_NAME_SLUGS = (account_name, account)`. Presence of either marks a multi-account (manager) export, which splits rows by account.

### 5.2 Date handling

- `DATE_SLUGS = ("day", "date", "week", "month")` — `date_column()` returns the finest present, else None (report not date-segmented). (Schedule's "Day of the week" slugs to `day_of_the_week` and is deliberately *not* matched — it's categorical.)
- `infer_date_order(values)` → `"dmy"`/`"mdy"`: scans slash-dates; first component >12 → dmy, second >12 → mdy; default `"mdy"` (Google US).
- `normalize_date(raw, order)` → `datetime.date | None`. Accepts: `2026-03`/`2026-03-15`/`2026/03/15` (missing day → 1st); `D/M/Y` or `M/D/Y` (2-digit year +2000; impossible month → swap); `M/YYYY` (day → 1st); `March 2026`/`Mar 2026` (day → 1st). Requires year+month or returns None.
- `parse_window(raw)` — `"January 1, 2025 - July 13, 2026"` → `(date, date)`.

**Granularity is derived, not flagged** (§8.2): the app inspects the actual `date_norm` values to decide daily vs weekly vs monthly, and adapts the UI accordingly. This is what lets "big clients upload monthly, small clients upload daily" work automatically.

### 5.3 Impression share

`SHARE_SLUGS = (search_impr_share, search_impression_share, impr_share, impression_share)` — deliberately excludes the auction-insights variant. `impr_share_frac(v)`: strips `%`/`,`; empty/`--`/`-` → None; starts with `<` → **0.05**; starts with `>` → **0.95**; else `float/100`. Rationale: Google buckets the extremes and can't give exact values there. `eligible_impr = impressions / impr_share`.

Cell cleaning: `clean(v)` strips quotes/whitespace, returns None for `--`/`""`/`<0.1` but **keeps** `< 10%` (a share bucket). `to_number(v)` strips `,$%`. `is_total_row(first)` skips `Total`/`Total: …` rows (older exports use `Total: <report>` — a prior exact-match check leaked totals rows and inflated sums).

### 5.4 Writing (`load.py`, CHUNK = 5000)

**Streaming parse:** `stream_report(path)` yields cleaned row dicts one at a time (constant memory), consuming the 3-line header. The caller must fully consume or `.close()` the iterator to release the file handle.

**Snapshot-replace semantics** (`replace_report`): Google exports are full snapshots, so re-loading a report for a client **deletes that client's prior rows for that report** then inserts the new ones (idempotent). Loading a new client adds alongside. Rows are inserted in CHUNK batches; `uploads.row_count` is filled after streaming completes.

`_row_record(...)` builds each `raw_rows` dict: campaign/ad_group/entity, raw `date`, `date_norm = normalize_date(...)`, typed metrics, `impr_share`, `eligible_impr`, full `row` JSON.

**Quality-Score freeze** (`search_keyword_qs` only): per row, `_qs_record` extracts QS + 3 components (preferring `hist_*` Historical-QS columns), encodes components as 1/2/3 via `_rating_num` ("above"→3, "below"→1, "average"→2), and serializes the keyword identity `kw_key = search_keyword ⋮ match_type ⋮ campaign ⋮ ad_group` (joined with `\x1f`). As-of date = the row's day, else the export window-end. `_write_qs_history` inserts only `(kw_key, as_of_date)` pairs not already present — **append-only, never overwrite** (belt-and-suspenders alongside the composite PK).

**BigQuery write path** (`replace_report_bq`, post-cutover): the `uploads` ledger stays in Postgres; `raw_rows`/`qs_history` stream to NDJSON temp files and load into BigQuery via free load jobs — snapshot-replace for raw_rows (`delete_report` then `load_ndjson`), append-with-freeze MERGE for qs_history (`merge_qs`). A guarded cleanup (`if inspect(conn).has_table("raw_rows")`) clears any stale Postgres raw_rows for the report before deleting its `uploads` parent — this fixes a foreign-key violation during the transition and becomes a harmless no-op once Postgres raw_rows is decommissioned.

The writer is chosen at runtime everywhere: `replace_report_bq if bq.active() else replace_report`.

### 5.5 Orchestration (`service.py`)

- **Client CRUD:** `list_clients` (with per-client report count + latest upload), `create_client`, `set_customer_id`, `get_config`/`update_config` (partial merge; special-cases the `thresholds` dict; invalidates the `term_relevance` cache since context changed).
- **MCC flow:** `preview_mcc(folder)` parses each CSV, groups rows by account (via `customer_id`/`account_name`), and suggests a mapping to existing clients (by CID then name) — **no writes**. `commit_mcc(folder, mapping)` ingests with the confirmed account→client mapping, splitting rows per account, snapshot-replacing per (client, report). Unmapped accounts are skipped.
- `inventory(client_id)` → per-report coverage + present/missing vs `EXPECTED_REPORTS` (`"N/12"`).
- `ingest_folder` / `load_folder` drive single-account uploads.

---

## 6. Client configuration

`engine/clientconfig.py` — the per-client business context stored in `clients.config` (JSON).

| Field | Default | Meaning |
|---|---|---|
| `brand_terms` | `[]` | brand strings (drives brand/non-brand split) |
| `product_categories` | `[]` | what the business sells — the relevance signal |
| `competitors_friendly` | `[]` | never conquest/negate |
| `competitors_conquest` | `[]` | real conquest targets |
| `thresholds` | see below | deterministic-analyzer overrides |
| `waste_exclusions` | `[]` | term substrings never flagged as waste |
| `seasonality` | `[]` | `[{label, months:["May"]}]` — suppresses expected dips |
| `notes` | `""` | free text |
| `budget_lines` | `[]` | `{brand, region, category, monthly}` dimensional budgets |

`thresholds` defaults: `smart_bidding_floor=30`, `low_vol_conv=15`, `low_vol_spend=100`, `qs_floor=3`, `monthly_budget=None`.

`merged(raw)` overlays raw over defaults (thresholds merge only non-None values; unknown keys ignored). `sanitize(raw)` coerces to the stored shape and drops unknown keys.

---

## 7. The warehouse: Postgres ↔ BigQuery

The two big analytical tables (`raw_rows`, `qs_history`) can live in BigQuery for scale, while everything else stays in Postgres. All of this is inert unless BigQuery is configured **and** switched on.

### 7.1 Two-tier switch (`engine/warehouse/bq.py`)
- `enabled()` = `GCP_PROJECT` + `BQ_DATASET` present. Used for provisioning / migration / parity.
- `active()` = enabled **and** `USE_BIGQUERY ∈ {1,true,yes,on}`. **This is the production cutover switch** — flipping it changes reads, writes, and Postgres-table recreation all at once; unsetting it is an instant rollback.

**BigQuery schemas** (mirror the Postgres tables, minus the SQLite `id`):
- `raw_rows`: 16 fields; **partitioned by `date_norm` (DAY), clustered by `(client_id, report_type)`** — every read filters on these.
- `qs_history`: 14 fields; partitioned by `as_of_date`, clustered by `client_id`.

Auth (`get_client()`): memoized singleton; uses `service_account.Credentials.from_service_account_info(json.loads(GCP_SA_KEY))` if the key is inline JSON, else Application Default Credentials. Write helpers: `load_ndjson` (WRITE_APPEND/TRUNCATE load job), `delete_report` (parameterized DELETE), `merge_qs` (load to staging then `MERGE … WHEN NOT MATCHED THEN INSERT ROW` — the append-only freeze). `ndjson_line` omits null fields.

### 7.2 Read routing (`engine/warehouse/analytics.py`)
`RouterEngine` wraps the Postgres engine and a BigQuery SQLAlchemy engine. Each `.connect()` returns a fresh `RouterConnection` that lazily opens the underlying connections and routes each `execute()` by the table the SQL touches: statements mentioning `raw_rows`/`qs_history` go to BigQuery, everything else to Postgres. This is the standard thread-safe SQLAlchemy pattern (one shared engine, per-use connections) — which is what makes the parallel bundle build safe (§15).

- `_with_deterministic_order` appends `ORDER BY row_index` to plain `raw_rows` row-SELECTs so BigQuery and Postgres return rows in the **same** order (skipped for aggregates and for `qs_history`, which has no `row_index`). Without this, tie-breaks in downstream top-N/first-seen logic would diverge — the only non-noise parity differences.
- `analytics_engine()` uses **explicit `credentials_info`** from `GCP_SA_KEY` because sqlalchemy-bigquery's default auth can't refresh Cloud Shell ADC and ignores a client passed via connect_args.
- `read_engine(pg)` returns the plain Postgres engine unless `bq.active()`, else the `RouterEngine`. Writes/transactions (`.begin()`) always go to Postgres; analytics writes use the load-job path.

### 7.3 Migration, parity, teardown
- **`migrate.py`** — one-time Postgres→BigQuery ETL. Streams each table to NDJSON and loads with `WRITE_TRUNCATE` (idempotent full replace); asserts `pg_rows == bq_rows` per table and aborts on mismatch. `--dry-run` validates the pipeline without BigQuery credentials.
- **`parity.py`** — builds each client's bundle from Postgres and from BigQuery (via the router) and diffs field-by-field with float tolerance (`atol=0.02, rtol=1e-3`), pairing list elements **order-insensitively** so tied-row ordering and rounding-from-summation-order aren't false mismatches. Cutover proceeds only when every client matches.
- **`teardown.py`** — post-cutover decommission of the legacy Postgres `raw_rows`/`qs_history`. **Dry-run by default**; `--commit` required. Before dropping, it verifies BigQuery holds ≥ as many rows as Postgres (aborts otherwise) and backs each table up to NDJSON. `init_db` stops recreating the two tables once `bq.active()`, so the drop stays torn down across restarts.

**Migration status (as of the BigQuery cutover):** complete — data migrated, read parity byte-identical across all clients, reads and writes verified live, and the legacy Postgres analytical tables decommissioned. Postgres now holds only `clients`/`uploads`/`term_relevance`.

---

## 8. Bundle assembler (`build_bundle`)

`engine/bundle/assemble.py` (~2,240 lines) — the heart of the read path.

Signature: `build_bundle(client_id, engine=None, date_from=None, date_to=None, filters=None, compare="yoy", compare_from=None, compare_to=None)`. Returns the bundle dict, or `None` if the client has no `campaign_performance` data.

### 8.1 Flow
1. Resolve config; build the global filter predicate `keep` (§8.6).
2. Early exit if no `campaign_performance` rows.
3. Build `total_trend` from campaign_performance, aggregating **row-level** (so global filters apply) into months. `dateless = not series` (a whole-window export with no parseable month collapses to a single current-month bucket).
4. Determine the latest complete month `cm` (`_latest_complete_month` reads `max(uploads.window_end)`, stepping back one month if the export ends mid-month).
5. Build the KPI scorecard (§8.4).
6. Run all section builders + analyzers via `_run_sections` (parallel when BigQuery is active — §15).
7. Compose `view_list`, `dated_reports`, granularity, and `windowed_views`.
8. Return the bundle.

### 8.2 Date filtering & granularity
- `_range_sql(d_from, d_to)` → `AND (date_norm IS NULL OR date_norm BETWEEN :d_from AND :d_to)`. **NULL-date rows are always kept** so whole-window snapshots still show. Bounds are real `date` objects so they bind as DATE on BigQuery.
- `_date_bound(s, end)` turns `2026-03` into the first (or last) day of the month; `2026-03-15` into that exact day.
- **Granularity detection:** from the distinct non-null `date_norm` values — `monthly` if every date is a month's 1st; `weekly` if all dates share one weekday; else `daily`; `none` if there are no dated rows. Exposed as `meta.date_range.granularity` and used by the UI to hide sub-period date presets.
- **`windowed_views`:** a report's tabs "honor the date range" only if that report has any dated rows (`date_norm IS NOT NULL`). Base windowed set = the always-dated campaign views; each dated report adds its views via `REPORT_VIEWS`. Non-windowed tabs show a "whole-window, ignores the range" note.

### 8.3 Weighted metrics (critical)
Every rate is derived from **summed totals**, never averaged across rows:
- CTR = `Σclicks / Σimpressions`
- CVR / conv_rate = `Σconversions / Σclicks`
- CPC = `Σcost / Σclicks`
- CPA = `Σcost / Σconversions`
- spend share = `cost / total_cost`; kw share = `kws / total_kw`
- **Impression share (Auction Insights)** is impression-weighted per domain: `Σ(frac × w) / Σw`, where `w` = our own campaign impressions for that `(campaign, day)` — because Google reports a competitor's share only over the auctions we were eligible for. Fallback = equal-weighted mean when no impressions can be joined.

### 8.4 KPI scorecard & comparison
Current period = latest month in the series. Prior period:
- `custom` → sum of series months in `[cfrom, cto]` (excluding current);
- `mom` → the immediately preceding month;
- `yoy` (default) → same month prior year, falling back to prior month, then zeros.

**Day-range override:** if the selected range is day-precise, current and prior are recomputed from **daily** data over the exact window (`_cp_range_sums`), with prior = same window prior year (yoy) / preceding equal-length window (mom) / the custom compare range. Rows: Total Spend, Main Conversions, CPA, CVR; `change = (cur - prev)/prev`.

### 8.5 Section builders (formulas)

Each builds one bundle key. Highlights (full formulas in §16):

- **`_campaigns`** — per-campaign latest-month snapshot + MoM Δconv; `cpa`, `cvr`, `share`; sorted by cost.
- **`_geo`** — by location; **cost is derived** (geo export has no cost column): `cost += cost_per_conv × conversions`. Top 60.
- **`_budget` / `_budget_section` / `_budget_reconciliation`** — effective budget from `budget_lines` (else `thresholds.monthly_budget`); status over/under/on-track at ±5%/−10%; planned-vs-actual for the latest month, by category when budget lines carry categories.
- **`_quality_score`** — non-brand QS overview from `_kw_qs_rows`. Per-QS (1–10) and per-bucket rollups; `avg_qs` is keyword-weighted; `pct_weak` (QS ≤5), `pct_strong` (QS ≥7); **savings estimate**: `weak_clicks × max(0, cpc_weak − cpc_qs7)`. Includes `trend` (see below).
- **`_qs_trend`** — monthly average QS from the frozen `qs_history` (full history, not range-bound). For each `(keyword, month)` take that month's latest QS, then average across the non-brand portfolio. Powers the QS Overview trend chart.
- **`_qs_breakdown`** — per-component rating rollups; the 27-combo eCTR×LP×AdRel grid (avg CPC / spend / avg QS per cell); savings-by-brand; the primary component gap; top QS≤6 keywords.
- **`_kw_qs_rows`** — foundational: sums performance per keyword over the range, and joins the **latest `qs_history` snapshot with `as_of_date ≤ range end`** so day-segmented QS exports don't double-count keywords.
- **`_keyword_section`** — Keyword Deep Dive top-40 by cost; component breakdown; `savings_estimate = below_ctr_spend × 0.33` (modeled 33% CPC penalty).
- **`_keyword_regions`** — keyword × region pivot for the heatmap (top 25 regions; top 100 keywords by spend ∪ conv, per branded/non-branded).
- **`_region_category`** — Brand × Region × Category CPC-by-rating with `spread = below_cpc − above_cpc`.
- **`_search_terms_section`** — grades every term by CVR (`_grade_term`: A ≥40%, B ≥25%, C ≥15%, D ≥5%, F <5% w/ ≥5 clicks, Low Volume <5 clicks); classifies intent (Relevant/Competitor/Needs Review/Irrelevant); status (Recommend to Add / Already Added / Review / Excluded / Unassigned); rolls up by `(term, campaign, ad_group, search_keyword)` so day-segmented exports show each combination once. Emits relevant/competitor/flagged lists (each carrying Campaign / Ad Group / Search Keyword columns) + intent segments + competitor summary.
- **`_ads_section`** — headline/description counts; grades ads by CTR (`_grade_ad`, thresholds differ branded vs non-branded) and LP by CVR (`_grade_lp`); the Ad-CTR × LP-CVR **pairing grid** (aligned / fix-LP / fix-ad / low-vol).
- **`_landing_pages` / `_lp_performance` / `_lp_category_grid`** — LP metrics (+ mobile speed); LP-level CVR from ads_performance (the only source with LP conversions); URL × category CVR matrix with `weighted_cvr`.
- **`_nb_categories` / `_regions`** — YoY non-brand spend/conv by category and by region×category, bucketed from campaign names, with a prior-month fallback when <1 year of history exists.
- **`_auction_insights_section`** — the Competition tab; impression-weighted competitor metrics (§8.3).

### 8.6 Global filters
`_row_filter(filters, config, engine, client_id)` builds `keep(row)` for the top-bar filters (seg = all/br/nb, campaign, region, category, brand). It builds ad_group→campaign and ad_group→region bridges only when needed (so a region filter can reach campaign-keyed rows), and skips a filter for a row only when genuinely unresolvable. `_filters_meta` supplies the dropdown options.

---

## 9. Deterministic analyzers → findings & recommendations

`engine/analyze/analyzers.py`. Each analyzer reads the warehouse and returns `F(...)` finding dicts (module, severity, title, observation, magnitude, impact, recommendation, summary, dollar, effort, timing, action, data). `run_analyzers` runs them in order and returns a flat list.

| Analyzer | Module | What it flags | Key formula/threshold |
|---|---|---|---|
| `_density` | D | campaigns below the Smart Bidding conversion floor | `SMART_BIDDING_FLOOR=30` conv/mo; low-vol = conv<15 & cost>$100; filters by `date_norm` month range |
| `_trend` | D | MoM conversion decline (seasonality-aware) | `drop = (cur−prior)/prior`; flags if ≤ −15% (CRITICAL ≤ −40%); suppressed to PASS if the month is a configured seasonal trough |
| `_match_types` | K | match-type allocation & idle inventory | Exact/Phrase/Broad rollups; idle = present but ~$0 spend |
| `_brand_split` | K | brand vs non-brand CPA gap | `gap = ncpa / bcpa` |
| `_three_bucket` | K | missing Brand/Non-Brand/Conquest separation | PASS if ≥2 architectures present |
| `_waste` | K | n-gram spend on zero-conversion terms | `pct = waste/total`; CRITICAL ≥40% |
| `_quality` | Q | below-average expected CTR / QS danger zone | `overpay = below_ctr_cost × 0.33`; danger zone = QS ≤ `qs_floor` (3) |
| `_pmax` | P | PMax placement "spray" | `served/total` where served = impressions ≥ 2 |

Mapping to the UI: `_to_overview_findings` (top 6, excludes PASS) → Overview "Key findings"; `_to_recommendations` → the Recs view with Priority/Category/Expected-Impact/Effort + a "See data" evidence table. Severity order: CRITICAL < IMPORTANT < OPPORTUNITY < PASS.

Note: analyzers sum in sorted order and use deterministic tie-breaks so formatted dollar amounts don't drift between engines from float-summation-order noise.

---

## 10. LLM term relevance

`engine/llm/relevance.py` — the **only** AI touchpoint, and it sees only search-term *text* + business context (never account data or credentials).

`get_or_classify(engine, client_id, terms, context)` is cache-first: it reads `term_relevance`, classifies only the missing terms (capped at `MAX_TERMS=40`), and writes results back. Provider priority: **DeepSeek** (if `DEEPSEEK_API_KEY`) → **Anthropic** (`ANTHROPIC_API_KEY`, default model `claude-haiku-4-5-20251001`) → **heuristic**. Any LLM/network error falls back to the heuristic (brand-substring → brand; conquest-substring → competitor; product-category keyword overlap → product; else unrelated). The prompt requests a strict JSON array `[{term, relevant, category, reason}]`; dropped terms are back-filled by the heuristic.

*(ROADMAP note: DeepSeek is currently priority; the roadmap calls for routing Anthropic-first.)*

---

## 11. Budget file parsing

`engine/budget/parse.py` — `parse_budget_file(data, filename, period, window_months)` turns an uploaded budget spreadsheet into monthly `budget_lines`. Accepts `.csv` and `.xlsx` (via `openpyxl`). Detects columns by header substring (brand / region / category / amount), finds the header row in the first 5 rows, and normalizes amounts to monthly: divide by 12 for `annual`, by `window_months` for `total`, else as-is. Returns `{lines, dimensions, total_monthly, period, count}`.

---

## 12. Module 2 — Budget Intelligence (the DRM model)

A faithful port of an internal Excel workbook — **DRM = "Dynamic Reallocation Model"** ("Revenue & AdROI", V5.2, proven on the Mavis account). It answers: *given this weekly budget and this goal, how should spend be distributed across Brand × Region × Category, and what tCPA changes does that imply?* It is deterministic (no LLM), per-client isolated, and runs entirely from ingested data + a few config/business-metric inputs.

Docs: `docs/budget-intel/{README, FEATURE_SPEC, MODEL_SPEC}.md`. Code: `engine/budget_intel/{model, curves, allocate, service, tables, bq_mirror}.py`, `backend/budget_intel_routes.py`, `frontend/budgetintel.{html,js}`. Acceptance gate: `tests/test_budget_intel_golden.py` reproduces the workbook exactly (14 tests total incl. `test_budget_intel_service.py`).

### 12.1 Unit of analysis & pipeline
**Cell** = Brand × Region × Category. Campaigns roll up to cells via a mapping. Pipeline:

```
ingest campaign-perf (with IS) + bid-strategy (with tCPA)
   → map campaigns to cells (bi_campaign_mappings)
   → build_cells (weighted IS, cost-weighted tCPA, business metrics)  [the "Actuals sheet"]
   → fit master curves from Google budget-simulator points
   → project 6 surfaces per cell across IS = 1..100
   → score each cell for the chosen goal
   → allocate the budget (caps/floors/±% guard)
   → emit a recommendation per cell (spend + tCPA moves) → finalize → predictions
```

Vocabulary: IS = search impression share (1–100); Leads = "Main Conv."; Car Count = the business conversion; LW = last week.

### 12.2 Master response curves
One account-level curve pair, fitted offline from budget-simulator points:

```
Leads(IS) = L / (1 + exp(−k·(IS − x0)))     # logistic
CPL(IS)   = a·IS² + b·IS + c                  # quadratic
```

Fitting (`curves.py`, needs `scipy`+`numpy`, ≥4 usable points): logistic via `scipy.optimize.curve_fit` (bounds `L∈[1e-6,1e9], k∈[1e-4,5], x0∈[0,100]`), quadratic via `numpy.polyfit`; reports R² for both.

**Critical production nuance:** the workbook ran on *pasted table literals*, not fresh formula evaluation — both curves **plateau from IS≈60** (a monotone cap: once CPL stops rising at 2dp, both leads and CPL freeze). `MasterCurves.from_params` reproduces this "peak-freeze"; the golden test uses the literal tables in `curve_params.json`. Excel `MROUND(x,1)` (round half away from zero) is reproduced for leads.

### 12.3 Per-cell projection (6 surfaces)
The 100×100 ratio grid is replaced by direct evaluation. For target IS `t`, base index = the cell's current IS:

```
leads_cell(t) = main_conv · Leads(t)/Leads(is_current)
cpl_cell(t)   = cpa       · CPL(t)/CPL(is_current)

leads(t)   = mround(leads_cell(t))
cpl(t)     = cpl_cell(t)
spend(t)   = cpl(t) · leads(t)
cars(t)    = mround(spend(t) / cost_per_car)     # constant cost-per-car (a known, deliberate model debt)
revenue(t) = cars(t) · rev_per_car
adroi(t)   = revenue(t) · gp_pct − spend(t)      # gross profit minus spend
```

Derived per cell: `max_adroi = max_t adroi(t)`; `is_at_max_roi = argmax_t adroi(t)`; `spend_cap = spend(is_at_max_roi)` (profit-max spend); `spend_floor ≈ spend(IS=1)`.

### 12.4 Opportunity scores (goal-specific)
```
score_main_conv = (conv/cost)·(conv/impr)·(impr/is)·(1−is)·w
score_car_count = (cars/impr)·(cars/cost)²·max(0.75−is, 0.01)·w
score_gp        = (cars/impr)·(cars/cost)²·gp_per_car²·max(0.55−is, 0.01)·w
score_revenue   = (cars/impr)·(cars/cost)·rev_per_car·max(0.55−is, 0.01)·w
```
Interpretation: efficiency × propensity × headroom (unclaimed IS, capped) × value weight. The large weight constants only normalize magnitude — scores are used *proportionally*, so uniform constants cancel in allocation.

### 12.5 Allocation
- **`legacy_waterfall`** (exact workbook port, golden-tested): 5-pass proportional allocation. Each pass distributes the remaining budget across still-eligible cells in proportion to score, clamped to each cell's `[floor, cap]`; a capped cell drops out of later passes.
- **`greedy_marginal`** (default): walks each cell's own curve grid, repeatedly committing the globally best marginal-return step (`gain/extra_spend`) until the budget or positive-return steps are exhausted.
- **`max_roi` goal** ignores the budget — every cell gets its profit-max `spend_cap`.
- **Playbook guard:** each cell is clamped to `[LW_spend·(1−pct), LW_spend·(1+pct)]` (default ±30%); safety caps outrank hitting the exact budget.

Each recommendation row: recommended spend, and (read off the curve at the implied IS) expected IS/CPA/cars/conv/revenue/AdROI plus the tCPA adjustment.

### 12.6 Data model & mirror
Postgres source of truth (`bi_campaign_mappings`, `bi_business_metrics`, `bi_curve_fits`, `bi_allocation_runs`). Analytical history (`bi_simulator_snapshots`, `bi_allocation_results`, `bi_predictions`) is mirrored fail-soft to BigQuery when `USE_BIGQUERY` is on (day-partitioned, client-clustered). Tables create lazily on first request. `bq_mirror.sync_mappings_from_bq` can one-time import an existing BigQuery campaign-mapping table.

### 12.7 API & UI
Router `/api/clients/{client_id}/budget-intel/*`: `mappings` (GET/PUT), `business-metrics` (GET/PUT), `simulator-snapshots` (POST, fits curves), `curves` (GET), `runs` (GET/POST), `runs/{id}` (GET), `runs/{id}/finalize` (POST). The UI is a **standalone page** at `/budgetintel.html` (goal selector, budget, mode, results table, mapping editor, simulator-points input) — deliberately **not linked in the main nav** (an explicit exception to the "no new views" freeze).

### 12.8 Known data-integrity bugs (MODEL_SPEC §4)
The engine implements only the correct formulas; the golden test reproduces the workbook's real (buggy) numbers via test-side overrides. Three quirks in the source spreadsheet:
1. A stray `×0.25` on each region's first score row.
2. A one-row input shift on two Colorado rows.
3. **★ Live Mavis bug:** `Budget Allocation I5/I12` reference `Recommendation 2!D6/D13` instead of `D5/D12`, so the allocator consumed the *next* row's opportunity score for two NB-BRAKES cells — the allocation input disagrees with the displayed score column on those rows. **This affects live Mavis allocations and should be fixed in the source sheet.**

---

## 13. Backend API

`backend/main.py` — FastAPI, `title="SearchNex Ads"`. Module-level `_engine = read_engine(get_engine())` (BigQuery-routed once active). Static frontend mounted last so `/api/*` wins.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/health` | `{ok, service, version, db, persistent}` |
| GET | `/api/clients` | list clients (+ report counts, last upload) |
| POST | `/api/clients` | create client (409 if exists) |
| GET/PUT | `/api/clients/{id}/config` | get / update business context (PUT clears the bundle cache) |
| POST | `/api/clients/{id}/budget` | parse a budget file → `budget_lines` (clears cache) |
| POST | `/api/upload` | stream-save CSVs → background ingest job → `{job_id}` |
| GET | `/api/upload/status/{job_id}` | poll job status |
| POST | `/api/upload/mcc/preview` | stage MCC export, return account mapping (no writes) |
| POST | `/api/upload/mcc/commit` | ingest with confirmed mapping (background job) |
| GET | `/api/inventory` | per-report coverage for a client |
| GET | `/api/bundle` | serve/compute the DATA bundle (params: client, period, from, to, seg, campaign, region, category, brand, compare, cfrom, cto) |
| — | `/api/clients/{id}/budget-intel/*` | Budget Intelligence router (§12.7) |

**Background jobs:** ingestion is heavy; running it in-request would let Railway's edge time out with a 502. So uploads register a job (`_JOBS`), run in a threadpool, and the UI polls `/api/upload/status`. On success the job clears the bundle cache.

**Upload handling (`_save_upload`):** streams to disk in 1 MB chunks (constant memory); browser-gzipped `.csv.gz` files are gunzipped on the way in (`zlib.decompressobj(16 + MAX_WBITS)`), so everything downstream sees plain `.csv`.

**Bundle serving:** a pre-baked `data/clients/<client>/<period>/bundle.json` wins if present and no filters/range/non-yoy-compare are set (the Mavis demo). Otherwise the response is served from the cache (§15) or computed by `build_bundle` and cached.

`revalidate_assets` middleware sets `Cache-Control: no-cache` on `/`, `.html`, `.js`, `.css` so deploys/edits appear without a manual hard-refresh.

---

## 14. Frontend architecture

`frontend/` — static HTML + vanilla JS, Chart.js from CDN. No build step.

### 14.1 Boot & two modes
`index.html` runs one inline IIFE: it checks the session auth flag, fetches `/api/bundle`, sets `window.__BUNDLE__`, then chain-loads `app.js → admin.js → dashviews.js → profile.js → totals.js`. It defines the shared toast helpers (`chzToast`, `chzBundleHasData`, `chzFiltersActive`).

The app runs in **two modes**:
- **Demo mode** (bundle has no `meta`): all renderers from `app.js`, static sidebar; profile.js returns early.
- **Computed-client mode** (bundle has `meta`): `dashviews.js` loads last and *overrides* the overlapping view renderers, registers new ones, and **rebuilds the sidebar** into collapsible sections; profile.js activates the filter bar, client switcher, and date picker.

**Auth** is a client-side gate only (`sessionStorage['chz_authed']`) — a demo login, not server auth (real auth is on the roadmap).

### 14.2 Navigation
`setView(name)` replaces `#view-root` with a fresh `#view-pane` and calls the view's renderer, preserving scroll on in-place refreshes and prepending a "whole-window, ignores range" note on non-windowed views. For computed clients the sidebar is rebuilt from `SECTIONS` (Recommendations, Business, Budget, Campaign, Keyword, Search Terms, Ad Copy, Landing Pages, Geo, Competition) filtered to `meta.views`, plus admin "Data" and "Settings" groups.

### 14.3 Filters, date range, comparison (`profile.js`)
- **Global filter bar:** Segment (All/BR/NB) + Campaign/Region/Category/Brand dropdowns (from `meta.filters_meta`). Any change triggers an **in-place refresh** — `refresh()` re-fetches `/api/bundle`, mutates `window.__BUNDLE__` in place (so `app.js`'s `const DATA` keeps identity), and re-renders the current view without a page reload.
- **Date-range picker:** presets (MTD, Last month, YTD, Today, Yesterday, This week, Last 7/14/30, Last week, All time) + custom range + "Last N days". **Granularity-aware:** for a monthly client it hides the sub-month presets and shows a "Monthly data" badge (weekly hides Today/Yesterday, shows "Weekly data").
- **VS comparison:** YoY / MoM / Custom (custom reveals two month inputs).
- **No-data toast:** when an applied filter/range resolves to nothing, a toast appears instead of a blank view.

### 14.4 Views
~25 dashboard views. In computed-client mode the key ones (from `dashviews.js`) are: Overview, Monthly Trends, NB Categories, Regions, Campaign Performance, Budget, Pacing, Budget Input, Keyword Deep Dive (region heatmap + flat table, both with a live keyword filter), QS Overview (incl. the avg-QS trend chart), QS Breakdown (27-combo grid), Region & Category, the four Search Terms tabs (Intent/Relevant/Competitor/Flagged — the latter three now carrying Campaign/Ad Group/Search Keyword columns), Ad Copy, Ad↔LP Pairing, LP Performance, LP Category Grid, Geo, Auction Insights (Competition — currently a scaffold), and Recommendations (with a "See data" evidence modal). Charts are Chart.js line/bar/doughnut/combo. Heavy tables cap at 100 rows with a "Show all" expansion.

### 14.5 Auto Total row (`totals.js`)
An IIFE adds a computed sticky `<tfoot>` "Total" row to every data table. Rate columns (`CTR/CVR/CPA/CPC/CPM/ROAS/share/rate/avg/score/position/…` or any `%` column) are **left blank** — summing rates is meaningless (honors the weighted-metrics rule). It skips transposed tables (first header = "Metric"), the `pair-grid`, and anything marked `no-total`. A `MutationObserver` re-runs it on view switch / filter / sort (debounced, disconnecting during its own writes to avoid loops).

### 14.6 Formatting & helpers
`fmt.money/num/pct` (pct treats values as 0–1 fractions); `fmtSmart` formats by metric name; `makeSortable` (click-to-sort, `data-sort` aware, numeric columns strip non-numeric); brand inference from landing-page URLs; several heatmap colorers (green→yellow→red / sqrt-scaled / CVR-banded).

### 14.7 Admin (`admin.js`)
The "Data" and "Settings" section: **Clients** (create + list), **Upload Data** (single-account drag-drop with browser-gzip; MCC multi-account with a per-account mapping UI + job polling), **Data Inventory** (coverage + per-report table), **Business Context** (edit brand terms, product categories, competitors, waste exclusions, thresholds, seasonality, notes).

---

## 15. Performance design (caching + parallelism)

A fresh bundle build fans out ~40–46 warehouse queries; in production each is a separate BigQuery job, so a naive build ran for tens of seconds and every reload/filter re-ran it. Two mechanisms address this:

- **Parallel section builders** (`_run_sections` in `assemble.py`): the ~17 independent section builders + the analyzer pass run on a thread pool **when BigQuery is active** (each builder opens its own connection — the standard thread-safe SQLAlchemy pattern), so the many BigQuery jobs overlap instead of running one-by-one. Local SQLite/plain-Postgres runs sequentially (SQLite can't share connections across threads and is already fast). Verified to produce a byte-identical bundle.
- **Bundle cache** (`backend/main.py`): computed bundles are cached in-process keyed by client + date range + filters + compare, with a 120s TTL and a size bound, **cleared on any ingest or config change**. A warm reload / filter re-toggle serves from cache in ~10ms (vs. multi-second cold builds).

---

## 16. Consolidated formula reference

**Core rates (everywhere):** `CTR = Σclicks/Σimpr`, `CVR = Σconv/Σclicks`, `CPC = Σcost/Σclicks`, `CPA = Σcost/Σconv`.

**Impression share:** stored as fraction with buckets `<10%→0.05`, `>90%→0.95`; `eligible_impr = impressions/impr_share`; **weighted IS = Σimpressions/Σeligible_impr**. Auction-Insights competitor metric = `Σ(frac·w)/Σw` with `w` = our campaign impressions for that `(campaign, day)`.

**QS:** `avg_qs = Σ(i·keywords_i)/Σkeywords_i` (keyword-weighted, i=1..10); components encoded 1/2/3. QS Overview savings = `weak_clicks · max(0, cpc_weak − cpc_qs7)` (weak = QS ≤5). Keyword-section savings = `below_ctr_spend · 0.33`. Analyzer QS overpay = `below_ctr_cost · 0.33`.

**Geo cost (derived):** `cost = cost_per_conv · conversions` (geo export has no cost column).

**Analyzer thresholds:** Smart Bidding floor 30 conv/mo; low-volume conv <15 & cost >$100; MoM decline flagged at ≤ −15% (CRITICAL ≤ −40%); waste CRITICAL at ≥40% of spend; QS danger zone ≤ `qs_floor` (3).

**Budget Intelligence:** `Leads(IS)=L/(1+e^(−k(IS−x0)))`; `CPL(IS)=a·IS²+b·IS+c`; per-cell ratio scaling by current IS; `spend=cpl·leads`, `cars=mround(spend/cost_per_car)`, `revenue=cars·rev_per_car`, `adroi=revenue·gp_pct−spend`; opportunity scores in §12.4; greedy allocation by marginal `gain/extra_spend`; playbook clamp `[LW·(1−pct), LW·(1+pct)]`.

**Comparison:** `change = (cur − prev)/prev`; prior period by yoy/mom/custom, recomputed from daily data for day-precise ranges.

---

## 17. Consolidated design decisions

- **Bundle as the contract.** The engine's only output to the frontend is one JSON object; the frontend is a pure renderer of it.
- **AI stays out of the math.** Deterministic Python owns every number; the LLM only classifies search-term text against business context, cached per term, with a heuristic fallback.
- **Weighted, never averaged.** Rates are `Σnumerator/Σdenominator`. Impression share carries `eligible_impr` so it can be weighted correctly. The auto-Total row blanks rate columns for the same reason.
- **QS frozen in time.** Append-only history keyed by `(keyword, as-of-date)`, enforced by both the composite PK and the write-time skip / BigQuery MERGE — so the app can show a QS trajectory Google doesn't provide.
- **Snapshot idempotency.** Google exports are full snapshots; re-loading a report replaces that client's rows for it.
- **Constant-memory ingestion.** Streaming parse + chunked inserts + NDJSON temp files keep peak memory flat regardless of export size (Railway OOM constraint).
- **Granularity is inferred, not configured.** Daily/weekly/monthly is detected from the data; the UI adapts (which tabs honor the range; which date presets are offered) so big-vs-small clients "just work."
- **BigQuery behind one switch.** `enabled()` (config present, for provisioning/migration/parity) vs `active()` (config + `USE_BIGQUERY`, the production cutover). Reads flip, writes flip, and Postgres-table recreation stops — all on the same flag, with instant rollback. Deterministic ordering + tolerant parity guaranteed correctness before cutover; a safe teardown decommissioned the legacy tables afterward.
- **Determinism for parity.** `ORDER BY row_index` on row-SELECTs and sorted-sum / tie-break discipline in builders and analyzers keep output identical across Postgres and BigQuery.
- **Performance = parallel + cache.** Overlap BigQuery jobs across threads; cache whole bundles per param-set with write-invalidation.
- **Budget Intelligence is a faithful port.** The engine implements only the correct formulas; the golden test reproduces the source workbook exactly (including its known bugs via test overrides), so drift is caught immediately.

---

## 18. Roadmap (ROADMAP_V2)

The system today is an excellent **analyst console**; the roadmap turns it into an **operator platform** (decide → act safely → measure → explain). Phases (dependency-ordered):

- **I — Foundation:** auth + roles (operator/senior), an append-only `actions_log`, an `entities` table (ID-keyed, not name-keyed), a conversion-tracking-health analyzer, Anthropic-first LLM routing, and filing the Google Ads dev-token + OAuth consent.
- **II — Operator surface:** a recommendation lifecycle (`new → assigned → approved|rejected|snoozed|escalated → applied → verified|failed`), a work queue, per-client playbooks enforced at generation time, teachable rationales, freshness rules.
- **III — Action loop:** Google Ads Editor bulk-sheet export, outcome snapshots, upload-based verification.
- **IV — API ingestion + guarded writes:** daily ID-keyed pulls, a Layer-2 `metrics_daily` fact table, OAuth connect flow, a negatives-first write path with hard caps.
- **V — Prove it:** metrics from `actions_log` + outcome snapshots.

**§8 — Module 2 (Budget Intelligence)** is the DRM productization documented in §12, running on the Phase-II recommendation lifecycle.

---

## 19. Repository map

```
backend/
  main.py                     FastAPI app: endpoints, background jobs, bundle cache, static mount
  budget_intel_routes.py      Budget Intelligence API router
  requirements.txt            deps (each annotated with why)
engine/
  ingest/
    parser.py                 report detection, date/impression-share normalization, streaming parse
    store.py                  SQLAlchemy schema (clients, uploads, raw_rows, term_relevance, qs_history), init_db, get_engine
    load.py                   replace_report / replace_report_bq, QS freeze, load_folder
    service.py                client CRUD, MCC preview/commit, inventory
  clientconfig.py             config schema, defaults, merged(), sanitize()
  bundle/
    assemble.py               build_bundle + ~17 section builders + weighted metrics + KPI/comparison + granularity + parallelism
  analyze/
    analyzers.py              8 deterministic analyzers → findings/recommendations
  llm/
    relevance.py              search-term relevance (DeepSeek/Anthropic/heuristic), cached
  budget/
    parse.py                  budget-file (.csv/.xlsx) parsing
  budget_intel/
    model.py, curves.py, allocate.py, service.py, tables.py, bq_mirror.py   Module 2 math + data + mirror
  warehouse/
    bq.py                     BigQuery schema/provisioning/write helpers + the active()/enabled() switches
    analytics.py              RouterEngine read routing (BigQuery vs Postgres)
    migrate.py                one-time Postgres→BigQuery ETL
    parity.py                 tolerant PG-vs-BQ parity gate
    teardown.py               post-cutover Postgres decommission (dry-run default, backup + count-safety)
frontend/
  index.html                  SPA shell, boot, auth gate, CSS, toast helpers
  app.js                      views map, setView, formatting, demo-mode renderers, Overview/Trends/QS/etc.
  dashviews.js                computed-client renderers + sidebar rebuild
  profile.js                  client chrome, in-place refresh, filter bar, date picker, comparison
  admin.js                    Clients / Upload (single + MCC) / Inventory / Business Context
  totals.js                   auto sticky Total row engine
  budgetintel.html/.js        standalone Budget Intelligence page
docs/
  budget-intel/               README, FEATURE_SPEC, MODEL_SPEC + golden fixtures
  DATA_BUNDLE_SCHEMA.md, PHASE0_SETUP.md
tests/
  test_budget_intel_golden.py, test_budget_intel_service.py
ROADMAP_V2.md                 phased plan (analyst console → operator platform)
Procfile, railway.json        deployment
```

---

*This document reflects the codebase as of the Budget Intelligence merge and the BigQuery cutover. When you change a formula, threshold, schema column, or endpoint, update the corresponding section here so it stays the single source of truth.*
