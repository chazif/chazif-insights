#!/usr/bin/env python3
"""Budget Intelligence data layer (Module 2).

Self-contained MetaData so this module can evolve without touching
engine/ingest/store.py. Same dialect posture as the rest of the app:
SQLite locally, Postgres via DATABASE_URL. See docs/budget-intel/FEATURE_SPEC.md.
"""
import datetime
from sqlalchemy import (MetaData, Table, Column, Integer, String, Float, Date,
                        DateTime, JSON, Boolean, Index)

metadata = MetaData()

campaign_mappings = Table(
    "bi_campaign_mappings", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("campaign", String(512), primary_key=True),
    Column("brand", String(64)),
    Column("region", String(64)),
    Column("category", String(64)),
    Column("engine", String(16)),      # G / B / ...
    Column("camp_type", String(32)),   # PMX / SEARCH / ...
    # central mapping engine metadata (engine/mapping.py): who set this row and
    # how sure the auto-mapper was. Legacy NULLs read as user/approved/1.0.
    Column("source", String(16)),      # auto | user | file
    Column("confidence", Float),       # 0..1 (auto-mapper score; 1 for human rows)
    Column("status", String(16)),      # pending | approved
    Column("updated_at", DateTime),
)

business_metrics = Table(
    "bi_business_metrics", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("brand", String(64), primary_key=True),
    Column("region", String(64), primary_key=True),
    Column("category", String(64), primary_key=True),
    Column("period_start", Date, primary_key=True),
    Column("revenue_per_conv", Float),     # revenue per business conversion ("car")
    Column("gp_pct", Float),               # gross-profit % of revenue (fraction)
    Column("car_count", Float),            # optional: attributed business conversions
    Column("source", String(16)),          # config | upload
    Column("updated_at", DateTime),
)

curve_fits = Table(
    "bi_curve_fits", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("scope_brand", String(64)),     # all three null -> account-level fit
    Column("scope_region", String(64)),
    Column("scope_category", String(64)),
    Column("fitted_at", DateTime),
    Column("params", JSON),                # {"leads":{"L","k","x0"},"cpl":{"a","b","c"}}
    Column("diagnostics", JSON),           # {"r2_leads","r2_cpl","window_start","window_end","n_points"}
    Column("source", String(16)),          # simulator | observed | blend | manual
    Column("active", Boolean, default=True),
    Index("ix_bi_curves_client", "client_id", "active"),
)

simulator_snapshots = Table(
    "bi_simulator_snapshots", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("campaign", String(512)),       # null = account-level points
    Column("taken_at", DateTime),
    Column("source", String(16)),          # manual | api
    Column("points", JSON),                # [{"is_share","spend_week","leads_week","cpl"}]
    Index("ix_bi_sim_client", "client_id"),
)

allocation_runs = Table(
    "bi_allocation_runs", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("run_at", DateTime),
    Column("created_by", String(128)),
    Column("goal", String(16)),            # main_conv | car_count | gp | revenue | max_roi
    Column("budget", Float),
    Column("mode", String(24)),            # legacy_waterfall | greedy_marginal
    Column("params", JSON),                # overrides: floors, caps, change limits, score config
    Column("status", String(16)),          # draft | final
    Column("notes", String(512)),
    Index("ix_bi_runs_client", "client_id"),
)

allocation_results = Table(
    "bi_allocation_results", metadata,
    Column("run_id", Integer, primary_key=True),
    Column("brand", String(64), primary_key=True),
    Column("region", String(64), primary_key=True),
    Column("category", String(64), primary_key=True),
    Column("opp_score", Float),
    Column("lw_spend", Float), Column("rec_spend", Float),
    Column("spend_cap", Float), Column("spend_floor", Float),
    Column("expected_is", Float), Column("lw_is", Float),
    Column("expected_cpa", Float), Column("lw_cpa", Float),
    Column("tcpa_current", Float), Column("tcpa_recommended", Float),
    Column("expected_conv", Float), Column("lw_conv", Float),
    Column("expected_cars", Float), Column("lw_cars", Float),
    Column("expected_revenue", Float), Column("expected_adroi", Float),
)

# calibration: predictions stamped at finalize, actuals filled by later ingests
predictions = Table(
    "bi_predictions", metadata,
    Column("run_id", Integer, primary_key=True),
    Column("brand", String(64), primary_key=True),
    Column("region", String(64), primary_key=True),
    Column("category", String(64), primary_key=True),
    Column("predicted", JSON),             # {"is","cpa","cars","spend"}
    Column("actual", JSON),                # filled when the next period arrives
    Column("measured_at", DateTime),
)


def init_db(engine):
    metadata.create_all(engine)


def now():
    return datetime.datetime.now(datetime.timezone.utc)
