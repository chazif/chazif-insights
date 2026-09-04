#!/usr/bin/env python3
"""Data layer: SQLAlchemy Core, dialect-agnostic.
DATABASE_URL (Railway Postgres) if set, else a local SQLite file for dev.

Raw landing model (Layer 1):
  uploads   — snapshot ledger: one row per (client, report_type) load
  raw_rows  — every report row, tagged with client + upload, typed core metrics
              for fast aggregation + a JSON `row` for full fidelity across the
              differing columns that simple vs complex accounts produce.
The normalized dimensional model (Layer 2) is built on top of this in Phase 2.
"""
import os
from pathlib import Path
from sqlalchemy import (create_engine, MetaData, Table, Column, Integer, BigInteger,
                        String, Float, Date, DateTime, JSON, ForeignKey, Index, inspect, text)

from ..warehouse import bq

REPO = Path(__file__).resolve().parents[2]
metadata = MetaData()

clients = Table(
    "clients", metadata,
    Column("client_id", String(64), primary_key=True),   # slug, e.g. "chiarelli"
    Column("name", String(256), nullable=False),          # display name
    Column("google_customer_id", String(32)),             # Google Ads CID (digits), the MCC-export join key
    Column("mcc_id", String(64)),                         # parent manager account (for owner rollups)
    Column("created_at", DateTime),
    Column("config", JSON),                               # business context + complexity profile (Phase 3)
)

uploads = Table(
    "uploads", metadata,
    Column("upload_id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("report_type", String(48), nullable=False),
    Column("source_file", String(256)),
    Column("window_raw", String(128)),
    Column("window_start", Date),
    Column("window_end", Date),
    Column("row_count", Integer),
    Column("uploaded_at", DateTime),
    Index("ix_uploads_client_report", "client_id", "report_type"),
)

raw_rows = Table(
    "raw_rows", metadata,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("upload_id", Integer, ForeignKey("uploads.upload_id"), nullable=False),
    Column("report_type", String(48), nullable=False),
    Column("row_index", Integer),
    Column("campaign", String(512)),
    Column("ad_group", String(512)),
    Column("entity", String(1024)),   # the report's primary entity value
    Column("date", String(32)),       # raw Month/Day cell as exported, else null
    Column("date_norm", Date),        # normalized calendar date (day precision; month -> 1st), for range filters
    Column("clicks", Float),
    Column("impressions", Float),
    Column("cost", Float),
    Column("conversions", Float),
    Column("conv_value", Float),
    Column("impr_share", Float),      # Search impression share as a fraction (buckets: <10%->.05, >90%->.95)
    Column("eligible_impr", Float),   # impressions / impr_share — the weight for correct weighted IS
    Column("row", JSON),              # full slugged record (all columns)
    Index("ix_raw_client_report", "client_id", "report_type"),
    Index("ix_raw_client_report_entity", "client_id", "report_type", "entity"),
    Index("ix_raw_client_report_date", "client_id", "report_type", "date_norm"),
)


term_relevance = Table(
    "term_relevance", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("term", String(1024), primary_key=True),
    Column("relevant", String(8)),      # "yes" / "no" (portable across dialects)
    Column("category", String(64)),
    Column("reason", String(512)),
    Column("source", String(16)),       # "llm" | "heuristic"
    Column("classified_at", DateTime),
)

# Client physical locations (store/office addresses) shown as pins on the Map tab.
# Geocoded once on save (address -> lat/lng); config-like, so it stays in Postgres.
client_locations = Table(
    "client_locations", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False, index=True),
    Column("name", String(256)),
    Column("address", String(512)),
    Column("lat", Float),
    Column("lng", Float),
    Column("created_at", DateTime),
)

# Global geocode cache for the map's city bubbles: place name -> coordinates. Not
# client-scoped (a city's location is universal) and never re-fetched — `ok=0` records a
# resolved-as-unfindable place so we don't hammer Nominatim on every view.
geo_cache = Table(
    "geo_cache", metadata,
    Column("place", String(512), primary_key=True),   # normalized place string
    Column("lat", Float),
    Column("lng", Float),
    Column("ok", Integer),                             # 1 = resolved, 0 = tried & unfindable
    Column("created_at", DateTime),
)


# Quality Score is point-in-time and non-additive: Google only returns the CURRENT
# value, so we build our own append-only, frozen-in-time history. One row per
# (keyword, as-of-date); the composite PK enforces the freeze (never overwrite a
# measured value). Components are stored as 1/2/3 (Below/Average/Above) + raw label.
qs_history = Table(
    "qs_history", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("kw_key", String(1024), primary_key=True),     # serialized keyword identity
    Column("as_of_date", Date, primary_key=True),          # the day this QS was measured
    Column("search_keyword", String(512)),
    Column("match_type", String(64)),
    Column("campaign", String(512)),
    Column("ad_group", String(512)),
    Column("quality_score", Float),                        # 1-10
    Column("exp_ctr", Integer),                            # 1/2/3
    Column("ad_relevance", Integer),                       # 1/2/3
    Column("landing_page_exp", Integer),                   # 1/2/3
    Column("exp_ctr_label", String(32)),                   # raw "Above average" etc.
    Column("ad_relevance_label", String(32)),
    Column("landing_page_exp_label", String(32)),
    Index("ix_qs_client_date", "client_id", "as_of_date"),
)


def get_engine(url=None, echo=False):
    url = url or os.environ.get("DATABASE_URL")
    if url:
        # normalize to the psycopg (v3) driver SQLAlchemy expects
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+psycopg://", 1)
        elif url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    else:
        data_dir = REPO / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        url = f"sqlite:///{(data_dir / 'dev.db').as_posix()}"
    return create_engine(url, echo=echo, future=True)


def init_db(engine):
    # Schema creation/migration always targets Postgres — unwrap the analytics read
    # router (which only routes SELECTs) to its underlying Postgres engine.
    engine = getattr(engine, "pg_engine", None) or engine
    # Once BigQuery is live, raw_rows / qs_history are owned by BigQuery — don't (re)create
    # them in Postgres, so a decommission (engine.warehouse.teardown) stays torn down across
    # restarts. clients / uploads / term_relevance always live in Postgres.
    if bq.active():
        metadata.create_all(engine, tables=[clients, uploads, term_relevance, client_locations, geo_cache])
    else:
        metadata.create_all(engine)
    # add-column-if-missing migrations for existing DBs (SQLite + Postgres both take this form)
    have = {c["name"] for c in inspect(engine).get_columns("clients")}
    for col in ("google_customer_id", "mcc_id"):
        if col not in have:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE clients ADD COLUMN {col} VARCHAR(64)"))
    # raw_rows column migrations only when the table is present (skipped post-decommission)
    if not inspect(engine).has_table("raw_rows"):
        return
    raw_have = {c["name"] for c in inspect(engine).get_columns("raw_rows")}
    if "date_norm" not in raw_have:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE raw_rows ADD COLUMN date_norm DATE"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_raw_client_report_date "
                              "ON raw_rows (client_id, report_type, date_norm)"))
    for col in ("impr_share", "eligible_impr"):
        if col not in raw_have:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE raw_rows ADD COLUMN {col} FLOAT"))
