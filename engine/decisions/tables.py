#!/usr/bin/env python3
"""Decision-system data layer (Actions lifecycle + Ledger).

Self-contained MetaData so this module evolves without touching
engine/ingest/store.py. Two tables — both TRANSACTIONAL and mutable, so they
stay in Postgres even after the BigQuery cutover (like clients/uploads):

  actions        — current lifecycle state, one row per (client, action_key).
                   A row exists only once a human has interacted; an untouched
                   recommendation is the implicit `proposed` with no row.
  action_events  — append-only, immutable audit log. This IS the Ledger.

See docs/DECISION_SYSTEM_DESIGN.md.
"""
import datetime
from sqlalchemy import (MetaData, Table, Column, Integer, String, Date,
                        DateTime, JSON, Index)

metadata = MetaData()

actions = Table(
    "actions", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("action_key", String(32), primary_key=True),
    Column("status", String(16), nullable=False),      # accepted|snoozed|dismissed|done|resolved|proposed
    Column("owner", String(128)),                       # assignee; free-text now, Clerk user id later
    Column("snooze_until", Date),                        # set when status=snoozed
    Column("dismiss_reason", String(512)),
    # denormalized recommendation snapshot — so the Ledger still reads after the
    # live finding changes or disappears:
    Column("title", String(512)),
    Column("module", String(64)),
    Column("category", String(64)),
    Column("priority", String(16)),
    Column("last_evidence", JSON),                       # frozen magnitude/impact/data at last touch
    Column("first_seen_at", DateTime),
    Column("last_seen_at", DateTime),
    Column("still_detected", String(4)),                 # "yes"/"no" — is the finding live right now
    Column("created_at", DateTime),
    Column("updated_at", DateTime),
    Index("ix_actions_client_status", "client_id", "status"),
)

action_events = Table(
    "action_events", metadata,
    Column("event_id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("action_key", String(32), nullable=False),
    Column("ts", DateTime, nullable=False),
    Column("actor", String(128)),                        # who; "system" for auto transitions
    Column("kind", String(16), nullable=False),          # created|accepted|snoozed|dismissed|done|
                                                          # reopened|resolved|regressed|assigned|note
    Column("from_status", String(16)),
    Column("to_status", String(16)),
    Column("note", String(1024)),
    Column("evidence", JSON),                             # frozen snapshot at the moment of this event
    Index("ix_events_client_key", "client_id", "action_key"),
    Index("ix_events_client_ts", "client_id", "ts"),
)


def init_db(engine):
    metadata.create_all(engine)


def now():
    return datetime.datetime.now(datetime.timezone.utc)
