#!/usr/bin/env python3
"""One-shot: move bi_allocation_results / bi_predictions to the V2 primary key WITHOUT
losing a row (M0-A1).

V2 added `goal` to both tables' primary key (one allocation / prediction set per goal
per run). Neither SQLite nor Postgres can ALTER a primary key in place, and init_db used
to DROP and recreate the tables when it found the old key — on production that deletes
every finalized allocation and reconciled prediction. This script replaces that drop.
For each table still on the pre-V2 key, in ONE transaction:

  1. create <table>__v2 with the V2 schema (engine/budget_intel/tables.py)
  2. copy every row, stamping `goal` with what the app's read paths look up for that
     run (service.get_run / override_run / reconcile, bundle.assemble): a non-empty
     goal already on the row, else the run's chosen_goal, else the run's own goal,
     else 'main_conv'
  3. verify the copied row count and distinct old keys match the original
  4. rename <table> -> <table>__pre_v2 (kept as a BACKUP) and <table>__v2 -> <table>

Any failure rolls the whole table back; nothing is dropped. Idempotent: a table already
on the V2 key (or absent) is skipped. Drop the __pre_v2 backups by hand once the
migrated data has been checked.

    python scripts/migrate_bi_v2.py                            # DRY RUN on DATABASE_URL
    python scripts/migrate_bi_v2.py --commit                   # migrate
    python scripts/migrate_bi_v2.py --url postgresql://... --commit

Exit codes: 0 ok (or nothing to do), 1 refused or verification failed.
"""
import argparse
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from sqlalchemy import MetaData, inspect, text  # noqa: E402

from engine.ingest.store import get_engine  # noqa: E402
from engine.budget_intel import tables as bi  # noqa: E402

TARGETS = (bi.allocation_results, bi.predictions)
RUNS = bi.allocation_runs.name
FALLBACK_GOAL = "main_conv"
OLD_KEY = ("run_id", "brand", "region", "category")


def _pk_cols(insp, name):
    return insp.get_pk_constraint(name).get("constrained_columns") or []


def needs_migration(insp, name):
    return insp.has_table(name) and "goal" not in _pk_cols(insp, name)


def goal_expr(old_cols, run_cols):
    """SQL expression for the goal stamped on each copied row (o = old row, r = its run)."""
    parts = []
    if "goal" in old_cols:            # a non-PK goal column an earlier ALTER added (default '')
        parts.append("NULLIF(o.goal, '')")
    if "chosen_goal" in run_cols:
        parts.append("NULLIF(r.chosen_goal, '')")
    if "goal" in run_cols:
        parts.append("NULLIF(r.goal, '')")
    parts.append(f"'{FALLBACK_GOAL}'")
    return "COALESCE(" + ", ".join(parts) + ")"


def migrate_table(engine, tbl, commit):
    """Migrate one table. Returns True when done / nothing to do, False when refused."""
    q = engine.dialect.identifier_preparer.quote
    insp = inspect(engine)
    name = tbl.name
    if not insp.has_table(name):
        print(f"{name}: absent, nothing to do")
        return True
    if not needs_migration(insp, name):
        print(f"{name}: already on the V2 key {_pk_cols(insp, name)}, nothing to do")
        return True
    backup, tmp = f"{name}__pre_v2", f"{name}__v2"
    for t in (backup, tmp):
        if insp.has_table(t):
            print(f"{name}: REFUSED: {t} already exists (a previous run?). Inspect it first.")
            return False

    old_cols = [c["name"] for c in insp.get_columns(name)]
    new_cols = [c.name for c in tbl.columns]
    lost = [c for c in old_cols if c not in new_cols]
    if lost:
        print(f"{name}: REFUSED: columns {lost} have no place in the V2 table; they would be lost.")
        return False
    run_cols = {c["name"] for c in insp.get_columns(RUNS)} if insp.has_table(RUNS) else set()
    copy_cols = [c for c in old_cols if c != "goal"]
    goal = goal_expr(old_cols, run_cols)
    join = f"LEFT JOIN {q(RUNS)} r ON r.id = o.run_id" if run_cols else ""
    src = f"FROM {q(name)} o {join}"

    with engine.connect() as c:
        n_old = c.scalar(text(f"SELECT COUNT(*) FROM {q(name)}"))
        dist = c.execute(text(f"SELECT {goal} AS g, COUNT(*) {src} GROUP BY 1 ORDER BY 1")).all()
    print(f"{name}: pre-V2 key {_pk_cols(insp, name)}, {n_old} row(s); goal to stamp: "
          + (", ".join(f"{g}={n}" for g, n in dist) or "(no rows)"))
    if not commit:
        print(f"{name}: DRY RUN, nothing written (re-run with --commit)")
        return True

    key = ", ".join(q(k) for k in OLD_KEY)
    cols_sql = ", ".join(q(c) for c in copy_cols)
    select_sql = f"SELECT {', '.join('o.' + q(c) for c in copy_cols)}, {goal} {src}"
    with engine.begin() as c:
        tbl.to_metadata(MetaData(), name=tmp).create(c)
        c.execute(text(f"INSERT INTO {q(tmp)} ({cols_sql}, {q('goal')}) {select_sql}"))
        n_new = c.scalar(text(f"SELECT COUNT(*) FROM {q(tmp)}"))
        n_keys = c.scalar(text(f"SELECT COUNT(*) FROM (SELECT DISTINCT {key} FROM {q(tmp)}) k"))
        if n_new != n_old or n_keys != n_old:
            raise RuntimeError(f"{name}: verification failed ({n_old} rows before, {n_new} copied, "
                               f"{n_keys} distinct keys); rolled back, nothing changed")
        old_pk = inspect(c).get_pk_constraint(name).get("name")
        tmp_pk = inspect(c).get_pk_constraint(tmp).get("name")
        c.execute(text(f"ALTER TABLE {q(name)} RENAME TO {q(backup)}"))
        c.execute(text(f"ALTER TABLE {q(tmp)} RENAME TO {q(name)}"))
        if engine.dialect.name == "postgresql":
            # PK constraint (and its index) names follow the table: keep them conventional.
            if old_pk and old_pk != f"{backup}_pkey":
                c.execute(text(f"ALTER TABLE {q(backup)} RENAME CONSTRAINT {q(old_pk)} TO {q(backup + '_pkey')}"))
            if tmp_pk and tmp_pk != f"{name}_pkey":
                c.execute(text(f"ALTER TABLE {q(name)} RENAME CONSTRAINT {q(tmp_pk)} TO {q(name + '_pkey')}"))
    pk = _pk_cols(inspect(engine), name)
    print(f"{name}: MIGRATED: {n_new} row(s) copied, key now {pk}; original kept as {backup}")
    return "goal" in pk


def main(argv=None):
    p = argparse.ArgumentParser(description="Migrate Budget Intelligence tables to the V2 key without data loss.")
    p.add_argument("--url", help="database URL (default: DATABASE_URL, else the local SQLite dev DB)")
    p.add_argument("--commit", action="store_true", help="write the migration (default: dry run)")
    a = p.parse_args(argv)
    if not a.url and not os.environ.get("DATABASE_URL"):
        print("note: no --url and no DATABASE_URL, so this targets the local SQLite dev database")
    engine = get_engine(a.url) if a.url else get_engine()
    print(f"database: {engine.url.render_as_string(hide_password=True)}")
    try:
        results = [migrate_table(engine, t, a.commit) for t in TARGETS]
    except RuntimeError as e:
        print(f"ERROR: {e}")
        return 1
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
