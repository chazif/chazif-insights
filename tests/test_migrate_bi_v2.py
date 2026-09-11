#!/usr/bin/env python3
"""M0-A1: bi_allocation_results / bi_predictions reach the V2 key WITHOUT losing rows.

Builds the exact PRE-V2 schema production (main) has, seeds it, and checks
scripts/migrate_bi_v2.py plus the init_db guard that replaced the old drop-and-recreate.
Throwaway SQLite; no network.
"""
import datetime
import importlib.util
from pathlib import Path

import pytest
from sqlalchemy import (MetaData, Table, Column, Integer, String, Float, DateTime, JSON,
                        create_engine, inspect, insert, text)

from engine.budget_intel import tables as bi_tables
from engine.budget_intel import service as bi

_SPEC = importlib.util.spec_from_file_location(
    "migrate_bi_v2", Path(__file__).resolve().parents[1] / "scripts" / "migrate_bi_v2.py")
mig = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mig)

RESULT_METRICS = ["opp_score", "lw_spend", "rec_spend", "spend_cap", "spend_floor",
                  "expected_is", "lw_is", "expected_cpa", "lw_cpa", "tcpa_current",
                  "tcpa_recommended", "expected_conv", "lw_conv", "expected_cars", "lw_cars",
                  "expected_revenue", "expected_adroi"]
KEY = ("run_id", "brand", "region", "category")
TABLES = ("bi_allocation_results", "bi_predictions")


def _old_schema(md, with_chosen_goal, results_goal_col):
    """bi_allocation_runs / bi_allocation_results / bi_predictions as defined on main."""
    runs = [Column("id", Integer, primary_key=True, autoincrement=True),
            Column("client_id", String(64), nullable=False), Column("run_at", DateTime),
            Column("created_by", String(128)), Column("goal", String(16)),
            Column("budget", Float), Column("mode", String(24)), Column("params", JSON),
            Column("status", String(16)), Column("notes", String(512))]
    if with_chosen_goal:
        runs.append(Column("chosen_goal", String(32)))
    Table("bi_allocation_runs", md, *runs)
    res = [Column(k, Integer if k == "run_id" else String(64), primary_key=True) for k in KEY]
    res += [Column(m, Float) for m in RESULT_METRICS]
    if results_goal_col:                       # as if the V2 ALTER had already run
        res.append(Column("goal", String(32), server_default=""))
    Table("bi_allocation_results", md, *res)
    Table("bi_predictions", md,
          *[Column(k, Integer if k == "run_id" else String(64), primary_key=True) for k in KEY],
          Column("predicted", JSON), Column("actual", JSON), Column("measured_at", DateTime))


def _make_old_db(tmp_path, with_chosen_goal=False, results_goal_col=False):
    url = f"sqlite:///{(tmp_path / 'old.db').as_posix()}"
    eng = create_engine(url, future=True)
    md = MetaData()
    _old_schema(md, with_chosen_goal, results_goal_col)
    md.create_all(eng)
    runs, res, preds = (md.tables[n] for n in ("bi_allocation_runs",) + TABLES)
    now = datetime.datetime(2026, 9, 1)
    with eng.begin() as c:
        run_rows = [dict(id=1, client_id="acme", run_at=now, goal="gp", status="final", params={}),
                    dict(id=2, client_id="acme", run_at=now, goal="main_conv", status="final", params={}),
                    dict(id=3, client_id="acme", run_at=now, goal=None, status="draft", params={})]
        if with_chosen_goal:
            for r in run_rows:
                r["chosen_goal"] = None
            run_rows[1]["chosen_goal"] = "revenue"
        c.execute(insert(runs), run_rows)
        cells = [(1, "ACME", "EAST", "tires"), (1, "ACME", "WEST", "tires"),
                 (2, "ACME", "EAST", "tires"), (3, "ACME", "EAST", "oil"),
                 (99, "ORPHAN", "NONE", "x")]                    # a result whose run is gone
        for i, (rid, b, rg, cat) in enumerate(cells):
            c.execute(insert(res), [dict(run_id=rid, brand=b, region=rg, category=cat,
                                         **{m: float(i * 100 + j) for j, m in enumerate(RESULT_METRICS)})])
        c.execute(insert(preds), [
            dict(run_id=1, brand="ACME", region="EAST", category="tires",
                 predicted={"is": 30.0, "cpa": 20.0}, actual={"is": 29.0, "cpa": 21.0}, measured_at=now),
            dict(run_id=1, brand="ACME", region="WEST", category="tires",
                 predicted={"is": 25.0, "cpa": 22.0}, actual=None, measured_at=None)])
    return url, eng


def _cols(eng, table):
    return [c["name"] for c in inspect(eng).get_columns(table)]


def _rows(eng, table, cols=None):
    """Every row of `table` over `cols` (default: all columns), order-independent."""
    cols = cols or _cols(eng, table)
    with eng.connect() as c:
        rows = c.execute(text(f"SELECT {', '.join(cols)} FROM {table}")).all()
    return sorted((tuple(r) for r in rows), key=repr)


def _goals(eng, table):
    with eng.connect() as c:
        return {tuple(r[:4]): r[4] for r in c.execute(text(
            f"SELECT run_id, brand, region, category, goal FROM {table}"))}


def _tables(eng):
    return set(inspect(eng).get_table_names())


# ── dry run ──────────────────────────────────────────────────────────────────────

def test_dry_run_changes_nothing(tmp_path):
    url, eng = _make_old_db(tmp_path)
    before = {t: _rows(eng, t) for t in TABLES}
    assert mig.main(["--url", url]) == 0
    assert {t: _rows(eng, t) for t in TABLES} == before
    assert "goal" not in inspect(eng).get_pk_constraint("bi_allocation_results")["constrained_columns"]
    assert not {t for t in _tables(eng) if t.endswith(("__v2", "__pre_v2"))}


# ── the migration itself ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("with_chosen_goal", [False, True],
                         ids=["main-today-no-chosen_goal", "chosen_goal-present"])
def test_commit_keeps_every_row_and_moves_goal_into_the_key(tmp_path, with_chosen_goal):
    url, eng = _make_old_db(tmp_path, with_chosen_goal=with_chosen_goal)
    old_cols = {t: _cols(eng, t) for t in TABLES}
    before = {t: _rows(eng, t, old_cols[t]) for t in TABLES}

    assert mig.main(["--url", url, "--commit"]) == 0

    insp = inspect(eng)
    for t in TABLES:
        assert insp.get_pk_constraint(t)["constrained_columns"] == ["run_id", "goal", "brand", "region", "category"]
        assert _rows(eng, t, old_cols[t]) == before[t], f"{t}: a row or a value changed"
        assert _rows(eng, f"{t}__pre_v2", old_cols[t]) == before[t], f"{t}: backup differs from the original"
    goals = _goals(eng, "bi_allocation_results")
    assert goals[(1, "ACME", "EAST", "tires")] == "gp"                       # the run's own goal
    assert goals[(1, "ACME", "WEST", "tires")] == "gp"
    assert goals[(2, "ACME", "EAST", "tires")] == ("revenue" if with_chosen_goal else "main_conv")
    assert goals[(3, "ACME", "EAST", "oil")] == "main_conv"                  # the run has no goal
    assert goals[(99, "ORPHAN", "NONE", "x")] == "main_conv"                 # the run is gone
    assert set(_goals(eng, "bi_predictions").values()) == {"gp"}


def test_rerun_is_a_noop(tmp_path):
    url, eng = _make_old_db(tmp_path)
    assert mig.main(["--url", url, "--commit"]) == 0
    tables, rows = _tables(eng), {t: _rows(eng, t) for t in TABLES}
    assert mig.main(["--url", url, "--commit"]) == 0
    assert _tables(eng) == tables and {t: _rows(eng, t) for t in TABLES} == rows


def test_blank_goal_left_by_an_earlier_alter_is_not_kept(tmp_path):
    url, eng = _make_old_db(tmp_path, results_goal_col=True)
    with eng.begin() as c:
        c.execute(text("UPDATE bi_allocation_results SET goal = ''"))
    assert mig.main(["--url", url, "--commit"]) == 0
    assert _goals(eng, "bi_allocation_results")[(1, "ACME", "EAST", "tires")] == "gp"


def test_refuses_when_a_backup_already_exists(tmp_path):
    url, eng = _make_old_db(tmp_path)
    with eng.begin() as c:
        c.execute(text("CREATE TABLE bi_allocation_results__pre_v2 (x INTEGER)"))
    before = _rows(eng, "bi_allocation_results")
    assert mig.main(["--url", url, "--commit"]) == 1
    assert _rows(eng, "bi_allocation_results") == before


# ── init_db no longer drops ──────────────────────────────────────────────────────

def test_init_db_refuses_instead_of_dropping(tmp_path):
    _, eng = _make_old_db(tmp_path)
    before = {t: _rows(eng, t) for t in TABLES}
    with pytest.raises(RuntimeError, match="migrate_bi_v2"):
        bi_tables.init_db(eng)
    assert {t: _rows(eng, t) for t in TABLES} == before, "init_db destroyed or altered rows"


def test_app_reads_a_legacy_run_after_migration(tmp_path):
    url, eng = _make_old_db(tmp_path)
    assert mig.main(["--url", url, "--commit"]) == 0
    bi_tables.init_db(eng)                     # now passes, and adds the V2 columns
    run = bi.get_run(eng, "acme", 1)
    assert run["chosen_goal"] is None and run["goal"] == "gp"
    assert len(run["results"]) == 2 and {r["goal"] for r in run["results"]} == {"gp"}
    # override_run needs an EXACT goal match (chosen_goal or goal); a '' stamp would raise here.
    bi.override_run(eng, "acme", 1, ("ACME", "EAST", "tires"), 1234.0, "M0-A1 check", "tester")
    cell = next(r for r in bi.get_run(eng, "acme", 1)["scenarios"]["gp"]
                if (r["brand"], r["region"], r["category"]) == ("ACME", "EAST", "tires"))
    assert cell["rec_spend"] == 1234.0


def test_fresh_database_is_untouched(tmp_path):
    url = f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}"
    eng = create_engine(url, future=True)
    bi_tables.init_db(eng)
    tables = _tables(eng)
    assert mig.main(["--url", url, "--commit"]) == 0
    assert _tables(eng) == tables
