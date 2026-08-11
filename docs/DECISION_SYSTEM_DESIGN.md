# Decision System — Design (Actions lifecycle + Ledger)

Status: **draft for review**. Target branch: `redesign`. Tables live in **Postgres** (transactional, mutable — never BigQuery). No `main`/production changes.

This unblocks three views at once: **Today · Actions** (the workqueue), **Prove · Ledger** (proof of impact over time), and richer state on **Today · Brief**.

---

## 1. The problem it solves

The analyzers already emit `recommendations` (and `findings`) on every bundle build — deterministic Python, no persistence. Today they are **stateless**: rebuild the bundle and you get the same list again, with no memory of "we already did that one" or "we decided not to."

The decision system adds a **persistent lifecycle** on top of the stateless recommendation stream:

- accept / snooze / dismiss / mark-done, with an owner and a note;
- hide handled items from Brief/Actions without losing them;
- an **append-only ledger** of every decision and its frozen evidence, so Prove can show *"on Jul 12 we flagged Campaign X at $2,279 over budget → accepted → done → the finding cleared by Aug."*

The whole thing keeps the non-negotiable: **deterministic Python owns the recommendations; the lifecycle only records human decisions about them.** The AI is not involved.

---

## 2. The crux: stable identity across rebuilds

A recommendation is recomputed each build, so a lifecycle row must attach to a **content-derived key that is stable as long as the underlying issue is "the same."**

### Solution: analyzer-declared `key`, hashed with the client

Add an optional `key` to the analyzer finding factory `F(...)` — a short, deterministic, human-meaningful scope string the analyzer author controls (identity lives where the semantics live, not guessed from output):

```python
# engine/analyze/analyzers.py — F() gains a key
F(module="D", sev="CRITICAL", title="Campaigns below the bidding floor",
  key="density:below-floor",              # NEW — stable scope for this issue
  ... )
```

Derive the action key deterministically:

```python
# engine/decisions/keys.py
import hashlib
def action_key(client_id: str, finding: dict) -> str:
    scope = finding.get("key") or f'{finding["module"]}:{finding["title"]}'  # fallback
    return hashlib.sha1(f"{client_id}\x1f{scope}".encode()).hexdigest()[:16]
```

- **Default (no `key` yet):** `sha1(client_id + module + title)`. Analyzers today emit one finding per (module, title) with a data table aggregating the affected entities, so module+title is already effectively unique — the explicit `key` is a hardening step we roll in per analyzer, not a prerequisite.
- **Identity is the *issue*, not the period.** Magnitude updates every period; the action stays open across builds. When a finding stops appearing, the action auto-resolves (§5) — which is exactly the before/after story Prove wants.

Every recommendation in the bundle gains an `action_key` field (see §7).

---

## 3. Data model (two Postgres tables)

Added to `engine/ingest/store.py` alongside `clients`/`uploads`, and to the `bq.active()` create-list (these are transactional — they **stay in Postgres** even after the BigQuery cutover, exactly like `clients`/`uploads`/`term_relevance`).

### `actions` — current lifecycle state, one row per (client, action_key)

Only written once a human interacts — an untouched recommendation has **no row** (state is the implicit `proposed`). Keeps the table small and keeps the analyzer the source of truth for what's live.

```python
actions = Table(
    "actions", metadata,
    Column("client_id", String(64), primary_key=True),
    Column("action_key", String(32), primary_key=True),
    Column("status", String(16), nullable=False),      # accepted|snoozed|dismissed|done|resolved
    Column("owner", String(128)),                       # assignee; free-text now, Clerk user id later
    Column("snooze_until", Date),                        # set when status=snoozed
    Column("dismiss_reason", String(512)),
    # denormalized recommendation snapshot — so the Ledger still reads even after the
    # live finding changes or disappears:
    Column("title", String(512)),
    Column("module", String(8)),
    Column("category", String(64)),
    Column("priority", String(16)),
    Column("last_evidence", JSON),                       # frozen magnitude/impact/data at last touch
    Column("first_seen_at", DateTime),                   # finding first surfaced
    Column("last_seen_at", DateTime),                    # finding most recently surfaced
    Column("still_detected", String(4)),                 # "yes"/"no" — is the finding live right now
    Column("created_at", DateTime),
    Column("updated_at", DateTime),
    Index("ix_actions_client_status", "client_id", "status"),
)
```

### `action_events` — append-only audit log (this **is** the Ledger)

```python
action_events = Table(
    "action_events", metadata,
    Column("event_id", Integer, primary_key=True, autoincrement=True),
    Column("client_id", String(64), nullable=False),
    Column("action_key", String(32), nullable=False),
    Column("ts", DateTime, nullable=False),
    Column("actor", String(128)),                        # who; "system" for auto transitions
    Column("kind", String(16), nullable=False),          # created|accepted|snoozed|dismissed|
                                                          # done|reopened|resolved|regressed|assigned|note
    Column("from_status", String(16)),
    Column("to_status", String(16)),
    Column("note", String(1024)),
    Column("evidence", JSON),                             # frozen snapshot at the moment of this event
    Index("ix_events_client_key", "client_id", "action_key"),
    Index("ix_events_client_ts", "client_id", "ts"),
)
```

Events are **immutable** — corrections are new events, never edits. This gives Prove a tamper-evident trail.

---

## 4. Lifecycle state machine

```
                 ┌─────────── proposed ───────────┐        (implicit: no row)
        accept ↓          snooze ↓        dismiss ↓   ↓ done ("already handled")
            accepted ────────► snoozed      dismissed      done
              │  │  └── done ──────┘            │             │
              │  └───── dismissed               │ reopen      │ reopen
              │                                 ▼             ▼
              └──────────────────────────────► proposed ◄─────┘
                                                                
   any non-resolved ──(finding gone)──► resolved   [system]
        resolved      ──(reappears)───► proposed    [system: "regressed"]
```

- **Open** (surfaced in Brief/Actions as needing attention): `proposed`, `accepted`, and `snoozed` whose `snooze_until` has passed.
- **Hidden by default** (visible under an "all/history" filter): `dismissed`, `done`, `snoozed` not yet due, `resolved`.
- `snoozed → due` is computed at read time (not a stored transition); `list_actions` surfaces it again.
- **Auto transitions** (`actor="system"`): `resolved` when a live finding disappears; `regressed` (→ proposed) when a resolved issue reappears.

Allowed transitions are a validation table in `engine/decisions/service.py`; illegal transitions → HTTP 409.

---

## 5. Reconciliation (`sync`) — where seen/auto-resolve happen

Bundle builds stay **read-only** (they only *join* stored status for display — §7). The write-side reconciliation runs inside `list_actions()` (called by the Actions and Ledger endpoints, i.e. when someone actually looks):

1. Compute the current recommendation set → set of live `action_key`s (pure, from the analyzers).
2. For each live key: upsert `first_seen_at`/`last_seen_at`, `still_detected="yes"`, refresh the denormalized snapshot + `last_evidence`. First appearance appends a `created` event.
3. For each stored non-resolved key **not** in the live set: set `still_detected="no"`, transition → `resolved`, append a `resolved` event freezing the last evidence.
4. For each stored `resolved` key that reappears: → `proposed` + `regressed` event.

Idempotent and cheap (bounded by the handful of findings per client). Lazy is fine: an accepted action stays accepted in the table until someone opens Actions, which flips gone ones to resolved.

---

## 6. API (new router `backend/decision_routes.py`, included like `budget_intel_router`)

All mutations call `_bundle_cache_clear()` (open-counts on Brief change). `actor`/`owner` are request-supplied strings until Clerk lands (§9).

| Method | Path | Body / query | Purpose |
|---|---|---|---|
| `GET` | `/api/clients/{cid}/actions` | `?status=open\|all\|dismissed\|done&owner=` | Reconcile (§5) + return merged list: live recommendations with their lifecycle status/owner/snooze, filtered. |
| `POST` | `/api/clients/{cid}/actions/{action_key}/transition` | `{to, note?, owner?, snooze_until?, actor?}` | Apply a state-machine transition. Writes `actions` (upsert) + appends `action_events` in one transaction. 409 on illegal transition. Returns the updated action. |
| `PATCH` | `/api/clients/{cid}/actions/{action_key}` | `{owner?, note?}` | Assign owner / add a note **without** a state change (appends `assigned`/`note` event). |
| `GET` | `/api/clients/{cid}/ledger` | `?from=&to=` | The `action_events` history (optionally date-bounded), each with frozen before/after evidence and current `still_detected`/`resolved` status. Powers Prove · Ledger. |

One transition endpoint (validated `to`) over granular verbs — simpler to extend and to authorize later. Pydantic bodies, `service`-layer functions, `HTTPException` for errors — matching the existing `main.py` style.

```python
class Transition(BaseModel):
    to: str                                   # accepted|snoozed|dismissed|done|reopened
    note: Optional[str] = None
    owner: Optional[str] = None
    snooze_until: Optional[date] = None
    actor: Optional[str] = "web"
```

---

## 7. Assembler + frontend integration

**Assembler** (`engine/bundle/assemble.py`):
- `_to_recommendations` / `_to_overview_findings` attach `action_key` (from §2) to each item.
- A read-only left-join of the `actions` table (per client) adds `status`, `owner`, `snooze_until` to each recommendation. This keeps the **bundle as the single read source**: existing consumers get lifecycle for free, and Brief can hide `dismissed`/`done`/`resolved` with no extra call. The join reads only (no writes → bundle stays cacheable; cache cleared on any transition).

**Frontend** (`redesign`, already-typed patterns):
- **Brief** (built): filter recommendation cards to open status; show a small `accepted/owner` chip when set. The card's existing "See data" already renders `evidence.data`.
- **Actions** (to build): full workqueue over `GET .../actions` — filter by status/owner/priority, sort, and a transition control per row (accept / snooze / dismiss / done) hitting the transition endpoint; optimistic update via a TanStack Query mutation + invalidate.
- **Ledger** (Prove, to build): timeline over `GET .../ledger` — each action's decision history with frozen before/after and a "still detected / resolved" badge.

---

## 8. Rollout

1. `engine/decisions/` new module: `keys.py`, `service.py` (`list_actions`, `apply_transition`, `assign`, `get_ledger`, `sync`).
2. Add `actions` + `action_events` to `store.py` + the `bq.active()` create-list. New tables → `metadata.create_all` handles them; no data migration.
3. `backend/decision_routes.py` router, `app.include_router(...)` in `main.py`.
4. Assembler: `action_key` + status join.
5. Add `key=` to analyzers incrementally (fallback covers the rest from day one).
6. Frontend: Brief filter (small), then Actions view, then Ledger view.

Backwards compatible: with zero `actions` rows, every recommendation reads as `proposed` and the app behaves exactly as today.

---

## 9. Auth, tenancy, open decisions

- **No auth yet.** `owner`/`actor` are free-text; anyone with the URL can transition. Acceptable on the private redesign env; when **Clerk** lands, map `actor`→user id and gate transitions by client access. Lifecycle state is **per-client, not per-user** (a team acting on one account) — which is also why baking status into the client-keyed bundle cache is safe.
- **Decisions for you:**
  1. Snooze — fixed presets (7/14/30d) or free date? (proposing presets + custom.)
  2. Should `dismiss` require a reason? (proposing optional but encouraged.)
  3. Ledger scope — per-client only, or a cross-client "owner's ledger" for the agency view? (proposing per-client now, cross-client later.)
  4. Auto-`resolved` — surface a one-time "✅ cleared" toast/entry in Brief, or silent to Ledger only? (proposing a Brief "recently resolved" strip.)

---

## 10. What this explicitly is **not**

- Not AI decisioning — recommendations remain deterministic analyzer output.
- Not a task manager — no subtasks/comments beyond a note; owner + status only.
- Not per-user state — team-shared per client until auth exists.
```
