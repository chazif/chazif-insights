#!/usr/bin/env python3
"""Decision-system API (Actions lifecycle + Ledger) — self-contained APIRouter.

Mounted from backend/main.py with a single include_router line. Reads merge the
live recommendation stream with stored lifecycle; writes append to an immutable
ledger. See docs/DECISION_SYSTEM_DESIGN.md.
"""
import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from engine.ingest.store import get_engine
from engine.warehouse.analytics import read_engine
from engine.decisions import tables as dec_tables
from engine.decisions import service as dec

router = APIRouter(prefix="/api/clients/{client_id}", tags=["decisions"])

_engine = None

# main.py injects its bundle-cache clearer here after include_router, so a
# lifecycle change invalidates the status baked into cached bundles (Brief).
invalidate_bundle_cache = lambda: None   # noqa: E731


def engine():
    global _engine
    if _engine is None:
        pg = get_engine()
        dec_tables.init_db(pg)            # DDL always against the real PG engine
        _engine = read_engine(pg)
    return _engine


class Transition(BaseModel):
    to: str                              # accepted | snoozed | dismissed | done | reopened
    note: Optional[str] = None
    owner: Optional[str] = None
    snooze_until: Optional[datetime.date] = None
    actor: Optional[str] = "web"


class Assign(BaseModel):
    owner: Optional[str] = None
    note: Optional[str] = None
    actor: Optional[str] = "web"


@router.get("/actions")
def list_actions(client_id: str, status: str = Query("open")):
    return {"actions": dec.list_actions(engine(), client_id, status=status)}


@router.post("/actions/{action_key}/transition")
def transition(client_id: str, action_key: str, body: Transition):
    try:
        action = dec.apply_transition(
            engine(), client_id, action_key, body.to, note=body.note,
            owner=body.owner, snooze_until=body.snooze_until, actor=body.actor or "web")
    except ValueError as e:
        raise HTTPException(409 if "illegal" in str(e) else 400, str(e))
    invalidate_bundle_cache()
    return action


@router.patch("/actions/{action_key}")
def patch_action(client_id: str, action_key: str, body: Assign):
    action = dec.assign(engine(), client_id, action_key, owner=body.owner,
                        note=body.note, actor=body.actor or "web")
    invalidate_bundle_cache()
    return action


@router.get("/ledger")
def ledger(client_id: str, date_from: Optional[str] = Query(None, alias="from"),
           date_to: Optional[str] = Query(None, alias="to")):
    def bound(s, end=False):
        if not s:
            return None
        try:
            d = datetime.date.fromisoformat(s[:10])
        except ValueError:
            raise HTTPException(400, f"bad date '{s}'")
        return datetime.datetime.combine(d, datetime.time.max if end else datetime.time.min)
    return dec.get_ledger(engine(), client_id, dfrom=bound(date_from), dto=bound(date_to, end=True))
