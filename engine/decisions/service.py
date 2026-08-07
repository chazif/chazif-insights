#!/usr/bin/env python3
"""Decision-system service: reconcile the live recommendation stream against the
stored lifecycle, apply state-machine transitions, and read the ledger.

Reads go through the bundle (recommendations already carry `action_key`); this
module owns the *writes* and the reconciliation. No LLM. See
docs/DECISION_SYSTEM_DESIGN.md §4–§6.
"""
import datetime

from sqlalchemy import select, insert, update
from sqlalchemy.exc import SQLAlchemyError

from .tables import actions, action_events, now

# ---- state machine ---------------------------------------------------------
# `to` verb -> the from-states it is legal from. `proposed` is the implicit
# state of any recommendation with no stored row.
ALLOWED_FROM = {
    "accepted": {"proposed", "snoozed", "dismissed", "done", "resolved"},
    "snoozed": {"proposed", "accepted"},
    "dismissed": {"proposed", "accepted", "snoozed"},
    "done": {"proposed", "accepted", "snoozed"},
    "reopened": {"dismissed", "done", "snoozed", "resolved"},
}
_TO_STATUS = {"reopened": "proposed"}   # every other verb stores its own name
OPEN = {"proposed", "accepted"}         # surfaced in Brief/Actions as needing attention


# ---- small coercions -------------------------------------------------------
def _as_date(v):
    if v is None or isinstance(v, datetime.date) and not isinstance(v, datetime.datetime):
        return v.date() if isinstance(v, datetime.datetime) else v
    if isinstance(v, datetime.datetime):
        return v.date()
    s = str(v)[:10]
    try:
        return datetime.date(int(s[:4]), int(s[5:7]), int(s[8:10]))
    except (ValueError, IndexError):
        return None


def _iso(dt):
    return dt.isoformat() if dt is not None else None


def _effective(status, snooze_until, today):
    """Snoozed-but-due reads as `proposed` (surfaces again) without a stored write."""
    if status == "snoozed":
        su = _as_date(snooze_until)
        if su and su <= today:
            return "proposed"
    return status


# ---- recommendation denormalization ---------------------------------------
def _rec_fields(rec):
    """The recommendation fields we snapshot onto an action row / event."""
    ev = rec.get("evidence") or {}
    return {
        "title": rec.get("Recommendation"),
        "category": rec.get("Category"),
        "priority": rec.get("Priority"),
        "module": ev.get("module"),
        "last_evidence": ev,
    }


def current_recs(engine, client_id):
    """The live recommendation set for a client, each carrying `action_key`.
    Lazily imports build_bundle to avoid an import cycle (assemble imports this
    module's read-only status join)."""
    from ..bundle.assemble import build_bundle
    b = build_bundle(client_id, engine)
    return (b or {}).get("recommendations") or []


def _load_rows(conn, client_id):
    rows = conn.execute(select(actions).where(actions.c.client_id == client_id)).mappings().all()
    return {r["action_key"]: dict(r) for r in rows}


def _event(conn, client_id, key, kind, from_status, to_status, actor, note=None, evidence=None):
    conn.execute(insert(action_events).values(
        client_id=client_id, action_key=key, ts=now(), actor=actor or "system",
        kind=kind, from_status=from_status, to_status=to_status, note=note, evidence=evidence))


# ---- reconciliation (§5) ---------------------------------------------------
def sync(engine, client_id, recs):
    """Reconcile stored action rows against the live recommendation set. Operates
    only on EXISTING rows (untouched proposals never get a row): refresh
    last_seen/evidence for live keys, auto-`resolved` for keys that vanished, and
    `regressed` -> proposed for resolved keys that reappeared. Idempotent."""
    live = {r["action_key"]: r for r in recs if r.get("action_key")}
    ts = now()
    with engine.begin() as conn:
        rows = _load_rows(conn, client_id)
        for key, row in rows.items():
            rec = live.get(key)
            if rec is not None:
                f = _rec_fields(rec)
                if row["status"] == "resolved":                      # reappeared
                    conn.execute(update(actions).where(
                        (actions.c.client_id == client_id) & (actions.c.action_key == key)).values(
                        status="proposed", still_detected="yes", last_seen_at=ts, updated_at=ts,
                        last_evidence=f["last_evidence"], title=f["title"], priority=f["priority"]))
                    _event(conn, client_id, key, "regressed", "resolved", "proposed", "system")
                else:                                                # still live -> refresh
                    conn.execute(update(actions).where(
                        (actions.c.client_id == client_id) & (actions.c.action_key == key)).values(
                        still_detected="yes", last_seen_at=ts, updated_at=ts,
                        last_evidence=f["last_evidence"], title=f["title"], priority=f["priority"]))
            elif row["status"] != "resolved":                        # vanished -> resolve
                conn.execute(update(actions).where(
                    (actions.c.client_id == client_id) & (actions.c.action_key == key)).values(
                    status="resolved", still_detected="no", updated_at=ts))
                _event(conn, client_id, key, "resolved", row["status"], "resolved", "system",
                       evidence=row.get("last_evidence"))


# ---- merge (live recs + stored lifecycle) ----------------------------------
def _merge(rec, row, today):
    """One frontend-facing action item from a live rec and/or a stored row."""
    if rec is not None:
        ev = rec.get("evidence") or {}
        base = {
            "action_key": rec["action_key"],
            "title": rec.get("Recommendation"),
            "priority": rec.get("Priority"),
            "category": rec.get("Category"),
            "rationale": rec.get("Rationale"),
            "expected_impact": rec.get("Expected Impact"),
            "effort": rec.get("Effort"),
            "evidence": ev,
            "live": True,
        }
    else:
        base = {
            "action_key": row["action_key"],
            "title": row.get("title"),
            "priority": row.get("priority"),
            "category": row.get("category"),
            "rationale": None,
            "expected_impact": None,
            "effort": None,
            "evidence": row.get("last_evidence") or {},
            "live": False,
        }
    if row is not None:
        base.update({
            "status": _effective(row["status"], row["snooze_until"], today),
            "raw_status": row["status"],
            "owner": row.get("owner"),
            "snooze_until": _iso(_as_date(row.get("snooze_until"))),
            "dismiss_reason": row.get("dismiss_reason"),
            "still_detected": row.get("still_detected") == "yes",
            "first_seen_at": _iso(row.get("first_seen_at")),
            "last_seen_at": _iso(row.get("last_seen_at")),
            "updated_at": _iso(row.get("updated_at")),
        })
    else:
        base.update({
            "status": "proposed", "raw_status": "proposed", "owner": None,
            "snooze_until": None, "dismiss_reason": None, "still_detected": True,
            "first_seen_at": None, "last_seen_at": None, "updated_at": None,
        })
    return base


_PRIO_ORDER = {"High": 0, "Medium": 1, "Low": 2}


def list_actions(engine, client_id, status="open"):
    """Reconcile, then return the merged action list filtered by `status`
    (open | all | proposed | accepted | snoozed | dismissed | done | resolved)."""
    recs = current_recs(engine, client_id)
    sync(engine, client_id, recs)
    today = datetime.date.today()
    with engine.connect() as conn:
        rows = _load_rows(conn, client_id)
    live_keys = set()
    items = []
    for rec in recs:
        k = rec.get("action_key")
        if not k:
            continue
        live_keys.add(k)
        items.append(_merge(rec, rows.get(k), today))
    for key, row in rows.items():                       # history-only (resolved / off-list)
        if key not in live_keys:
            items.append(_merge(None, row, today))

    if status == "open":
        items = [a for a in items if a["live"] and a["status"] in OPEN]
    elif status != "all":
        items = [a for a in items if a["status"] == status]

    items.sort(key=lambda a: (0 if a["status"] in OPEN else 1,
                              _PRIO_ORDER.get(a["priority"], 3),
                              a["title"] or ""))
    return items


def _find_rec(engine, client_id, key):
    for r in current_recs(engine, client_id):
        if r.get("action_key") == key:
            return r
    return None


def apply_transition(engine, client_id, key, to, note=None, owner=None,
                     snooze_until=None, actor="web"):
    """Apply a state-machine transition; upsert the action row and append an event
    in one transaction. Raises ValueError('unknown'|'illegal') for the route to map."""
    if to not in ALLOWED_FROM:
        raise ValueError(f"unknown transition '{to}'")
    to_status = _TO_STATUS.get(to, to)
    ts = now()
    today = datetime.date.today()
    rec = _find_rec(engine, client_id, key)             # for denormalization / evidence
    f = _rec_fields(rec) if rec else {}
    with engine.begin() as conn:
        row = _load_rows(conn, client_id).get(key)
        from_status = _effective(row["status"], row["snooze_until"], today) if row else "proposed"
        if from_status not in ALLOWED_FROM[to]:
            raise ValueError(f"illegal transition {from_status} -> {to}")
        vals = {
            "status": to_status,
            "snooze_until": _as_date(snooze_until) if to == "snoozed" else None,
            "dismiss_reason": note if to == "dismissed" else (row.get("dismiss_reason") if row else None),
            "updated_at": ts,
        }
        if owner is not None:
            vals["owner"] = owner
        if rec is not None:                              # refresh snapshot from the live finding
            vals.update({"title": f.get("title"), "category": f.get("category"),
                         "priority": f.get("priority"), "module": f.get("module"),
                         "last_evidence": f.get("last_evidence"),
                         "last_seen_at": ts, "still_detected": "yes"})
        if row is None:
            base = {"client_id": client_id, "action_key": key, "created_at": ts,
                    "first_seen_at": ts, "owner": owner,
                    "still_detected": "yes" if rec is not None else "no",
                    "title": f.get("title"), "category": f.get("category"),
                    "priority": f.get("priority"), "module": f.get("module"),
                    "last_evidence": f.get("last_evidence")}
            base.update(vals)                            # transition values win on overlap
            conn.execute(insert(actions).values(**base))
        else:
            conn.execute(update(actions).where(
                (actions.c.client_id == client_id) & (actions.c.action_key == key)).values(**vals))
        _event(conn, client_id, key, to, from_status, to_status, actor, note=note,
               evidence=f.get("last_evidence"))
    return _merge(rec, _current_row(engine, client_id, key), today)


def assign(engine, client_id, key, owner=None, note=None, actor="web"):
    """Set owner / add a note WITHOUT a state change."""
    ts = now()
    today = datetime.date.today()
    rec = _find_rec(engine, client_id, key)
    f = _rec_fields(rec) if rec else {}
    with engine.begin() as conn:
        row = _load_rows(conn, client_id).get(key)
        if row is None:
            conn.execute(insert(actions).values(
                client_id=client_id, action_key=key, status="proposed", created_at=ts,
                first_seen_at=ts, updated_at=ts, owner=owner,
                still_detected="yes" if rec is not None else "no",
                title=f.get("title"), category=f.get("category"),
                priority=f.get("priority"), module=f.get("module"),
                last_evidence=f.get("last_evidence")))
        else:
            vals = {"updated_at": ts}
            if owner is not None:
                vals["owner"] = owner
            conn.execute(update(actions).where(
                (actions.c.client_id == client_id) & (actions.c.action_key == key)).values(**vals))
        kind = "assigned" if owner is not None else "note"
        _event(conn, client_id, key, kind, None, None, actor, note=note)
    return _merge(rec, _current_row(engine, client_id, key), today)


def _current_row(engine, client_id, key):
    with engine.connect() as conn:
        r = conn.execute(select(actions).where(
            (actions.c.client_id == client_id) & (actions.c.action_key == key)).limit(1)).mappings().first()
    return dict(r) if r else None


# ---- ledger (§6) -----------------------------------------------------------
def get_ledger(engine, client_id, dfrom=None, dto=None):
    """Append-only event history (optionally date-bounded) plus a per-action
    summary with current status. Powers Prove · Ledger."""
    w = (action_events.c.client_id == client_id)
    if dfrom:
        w = w & (action_events.c.ts >= dfrom)
    if dto:
        w = w & (action_events.c.ts <= dto)
    with engine.connect() as conn:
        evs = conn.execute(select(action_events).where(w).order_by(
            action_events.c.ts.desc())).mappings().all()
        rows = _load_rows(conn, client_id)
    today = datetime.date.today()
    events = [{
        "event_id": e["event_id"], "action_key": e["action_key"], "ts": _iso(e["ts"]),
        "actor": e["actor"], "kind": e["kind"], "from_status": e["from_status"],
        "to_status": e["to_status"], "note": e["note"], "evidence": e["evidence"],
        "title": (rows.get(e["action_key"]) or {}).get("title"),
    } for e in evs]
    summary = [{
        "action_key": k, "title": r.get("title"), "category": r.get("category"),
        "priority": r.get("priority"),
        "status": _effective(r["status"], r["snooze_until"], today),
        "owner": r.get("owner"), "still_detected": r.get("still_detected") == "yes",
        "first_seen_at": _iso(r.get("first_seen_at")), "updated_at": _iso(r.get("updated_at")),
    } for k, r in rows.items()]
    summary.sort(key=lambda a: a["updated_at"] or "", reverse=True)
    return {"events": events, "actions": summary}


# ---- read-only status join (used by the bundle assembler) ------------------
def load_action_status(engine, client_id):
    """{action_key: {status(effective), owner, snooze_until}} for the client.
    Defensive: returns {} if the table doesn't exist yet (a Brief load before the
    decision router ever ran its DDL), so bundle builds never crash on it."""
    today = datetime.date.today()
    try:
        with engine.connect() as conn:
            rows = conn.execute(select(actions).where(
                actions.c.client_id == client_id)).mappings().all()
    except SQLAlchemyError:
        return {}
    return {r["action_key"]: {
        "status": _effective(r["status"], r["snooze_until"], today),
        "owner": r["owner"],
        "snooze_until": _iso(_as_date(r["snooze_until"])),
    } for r in rows}
