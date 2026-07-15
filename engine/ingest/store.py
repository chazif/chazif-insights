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
                        String, Float, Date, DateTime, JSON, ForeignKey, Index)

REPO = Path(__file__).resolve().parents[2]
metadata = MetaData()

clients = Table(
    "clients", metadata,
    Column("client_id", String(64), primary_key=True),   # slug, e.g. "chiarelli"
    Column("name", String(256), nullable=False),          # display name
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
    Column("date", String(32)),       # Month/Day when the report is segmented, else null
    Column("clicks", Float),
    Column("impressions", Float),
    Column("cost", Float),
    Column("conversions", Float),
    Column("conv_value", Float),
    Column("row", JSON),              # full slugged record (all columns)
    Index("ix_raw_client_report", "client_id", "report_type"),
    Index("ix_raw_client_report_entity", "client_id", "report_type", "entity"),
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
    metadata.create_all(engine)
