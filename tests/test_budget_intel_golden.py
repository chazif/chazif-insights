#!/usr/bin/env python3
"""Golden test: the budget_intel engine must reproduce the production workbook
(DRM V5.2, Mavis, week of 2026-02-22) from docs/budget-intel/fixtures/.

Fixture column positions are documented in docs/budget-intel/MODEL_SPEC.md.
Run: python -m pytest tests/test_budget_intel_golden.py -q
"""
import csv
import json
import math
from pathlib import Path

import pytest

from engine.budget_intel.model import Cell, MasterCurves, project, max_roi_point, scores
from engine.budget_intel.allocate import legacy_waterfall, greedy_marginal, run_allocation

FIX = Path(__file__).resolve().parents[1] / "docs" / "budget-intel" / "fixtures"

# leaf-cell sheet rows (1-indexed, matching the workbook; CSV rows align)
LEAF_ROWS = list(range(3, 9)) + list(range(10, 16)) + list(range(17, 22)) + list(range(23, 28))

# workbook formula drift: each region's first row carries *0.25 on all four score
# variants (see fixtures/curve_params.json "score_quirk")
QUIRK_ROWS = {3, 10, 17, 23}
QUIRK_FACTOR = 0.25


def _grid(name):
    with open(FIX / name, encoding="utf-8") as f:
        return list(csv.reader(f))


def _num(v, default=0.0):
    if v is None or str(v).strip() == "":
        return default
    return float(v)


@pytest.fixture(scope="module")
def params():
    """The production master tables (pasted literals the workbook ran on)."""
    p = json.loads((FIX / "curve_params.json").read_text())
    return MasterCurves.from_tables(p["master_tables"]["leads"],
                                    p["master_tables"]["cpl"])


@pytest.fixture(scope="module")
def cells():
    """actuals.csv -> {sheet_row: Cell} for the 22 leaf cells (MODEL_SPEC §1)."""
    grid = _grid("actuals.csv")
    out = {}
    for r in LEAF_ROWS:
        row = grid[r - 1]
        out[r] = Cell(
            brand=row[0], region=row[1], category=row[2],
            impr=_num(row[3]), clicks=_num(row[4]), cost=_num(row[5]),
            main_conv=_num(row[8]), cpa=_num(row[9]), tcpa=_num(row[10]),
            is_share=_num(row[11]), is_lost_budget=_num(row[12]),
            is_lost_rank=_num(row[13]),
            rev_per_car=_num(row[16]), gp_per_car=_num(row[17]),
            gp_pct=_num(row[18]), cost_per_car=_num(row[19]),
            car_count=_num(row[20]), is_current=int(_num(row[24])),
        )
    return out


# fixture 0-indexed column of t=1 minus 1, per surface (MODEL_SPEC §3 block map)
PROJ_OFFSETS = {"leads": 3, "cpl": 106, "spend": 208, "cars": 311,
                "revenue": 414, "adroi": 516}


def test_projection_surfaces(cells, params):
    grid = _grid("projections_expected.csv")
    checked = 0
    for r, cell in cells.items():
        s = project(cell, params)
        row = grid[r - 1]
        for surf, off in PROJ_OFFSETS.items():
            ours = getattr(s, surf)
            for t in range(1, 101):
                exp = _num(row[off + t], default=math.nan)
                if math.isnan(exp):
                    continue
                got = ours[t - 1]
                assert got == pytest.approx(exp, rel=1e-9, abs=1e-6), (
                    f"row {r} {cell.key} {surf}[t={t}]: ours={got} workbook={exp}")
                checked += 1
    assert checked > 10000  # sanity: we actually compared the surfaces


def test_opportunity_scores(cells):
    """Validates the four score formulas row-by-row against the workbook, using
    each Opportunity Scores row's OWN input columns. (The workbook has a data
    bug: rows 11-12's inputs are shifted one row vs Actuals — see
    fixtures/curve_params.json "score_quirk". Computing from row-local inputs
    validates the formula port independent of that bug.)"""
    grid = _grid("opportunity_scores.csv")
    col = {"main_conv": 16, "car_count": 17, "gp": 18, "revenue": 19}  # Q,R,S,T 0-idx
    for r in LEAF_ROWS:
        row = grid[r - 1]
        local = Cell(brand=row[0], region=row[1], category=row[2],
                     impr=_num(row[3]), cost=_num(row[5]), main_conv=_num(row[8]),
                     is_share=_num(row[11]), car_count=_num(row[26]),
                     rev_per_car=_num(row[22]), gp_per_car=_num(row[23]))
        ours = scores(local)
        factor = QUIRK_FACTOR if r in QUIRK_ROWS else 1.0
        for variant, c in col.items():
            exp = _num(row[c], default=math.nan)
            if math.isnan(exp):
                continue
            assert ours[variant] * factor == pytest.approx(exp, rel=1e-9, abs=1e-9), (
                f"row {r} score[{variant}]")


def test_max_roi_caps(cells, params):
    grid = _grid("budget_allocation.csv")
    for r, cell in cells.items():
        s = project(cell, params)
        t, best, cap = max_roi_point(s)
        row = grid[r - 1]
        assert best == pytest.approx(_num(row[4]), rel=1e-9, abs=1e-6), f"row {r} max_adroi"
        assert t == int(_num(row[5])), f"row {r} is_at_max_roi"
        assert cap == pytest.approx(_num(row[6]), rel=1e-9, abs=1e-6), f"row {r} spend_cap"


def test_legacy_waterfall_allocation(cells, params):
    """Reproduce the five-pass waterfall and the final AF column. The fixture run
    used the *revenue* score variant (workbook Recommendation!D3 == Opp T3)."""
    grid = _grid("budget_allocation.csv")
    caps, floors, score_by_key, key_by_row = {}, {}, {}, {}
    for r, cell in cells.items():
        s = project(cell, params)
        _, _, cap = max_roi_point(s)
        caps[cell.key] = cap
        floors[cell.key] = 0.0
        # feed the allocator the exact score vector the workbook consumed
        # (col I) — score-formula correctness is covered by test_opportunity_scores
        score_by_key[cell.key] = _num(grid[r - 1][8])
        key_by_row[r] = cell.key

    final = legacy_waterfall(score_by_key, caps, floors, budget=48000.0)
    total = 0.0
    for r, key in key_by_row.items():
        exp_final = _num(grid[r - 1][31])   # col AF
        assert final[key] == pytest.approx(exp_final, rel=1e-9, abs=1e-4), (
            f"row {r} {key}: ours={final[key]} workbook AF={exp_final}")
        total += final[key]
    # the fixture run allocates the full budget across leaves (workbook r30: 48000)
    assert total == pytest.approx(48000.0, abs=1.0)


def test_recommendation_table(cells, params):
    """End-to-end run_allocation vs the workbook Recommendation sheet."""
    grid = _grid("recommendation_goal_carcount.csv")
    ba = _grid("budget_allocation.csv")
    overrides = {cells[r].key: _num(ba[r - 1][8]) for r in LEAF_ROWS}
    results = run_allocation(list(cells.values()), params, goal="revenue",
                             budget=48000.0, mode="legacy_waterfall",
                             run_params={"max_change_pct": None,
                                         "score_overrides": overrides})
    by_key = {(x["brand"], x["region"], x["category"]): x for x in results}
    row_of_key = {cells[r].key: r for r in LEAF_ROWS}
    rows_checked = 0
    for row in grid[2:]:
        if len(row) < 18 or row[2] in ("", "TOTAL") or row[0] == "":
            continue
        key = (row[0], row[1], row[2])
        got = by_key[key]
        # opp_score = the allocator's input (BA col I). NOT the Recommendation
        # sheet's display column D: the workbook's BA!I5/I12 are broken refs
        # (point at D6/D13), so display and allocator input disagree on 2 rows.
        assert got["opp_score"] == pytest.approx(
            _num(ba[row_of_key[key] - 1][8]), rel=1e-9), key
        assert got["rec_spend"] == pytest.approx(_num(row[4]), rel=1e-9, abs=1e-4), key
        assert got["lw_spend"] == pytest.approx(_num(row[5]), rel=1e-9), key
        assert got["expected_is"] == pytest.approx(_num(row[7]), abs=1e-9), key
        assert got["expected_cpa"] == pytest.approx(_num(row[10]), rel=1e-9, abs=1e-6), key
        assert got["tcpa_current"] == pytest.approx(_num(row[13]), rel=1e-9), key
        # col O: tCPA adjustment = expected CPA - current tCPA
        adj = got["tcpa_recommended"] - got["tcpa_current"]
        assert adj == pytest.approx(_num(row[14]), rel=1e-9, abs=1e-6), key
        assert got["expected_cars"] == pytest.approx(_num(row[15]), abs=1e-9), key
        rows_checked += 1
    assert rows_checked == 22


def test_parametric_generator_matches_production_tables(params):
    """MasterCurves.from_params (logistic + 2dp quadratic + peak-freeze) must
    regenerate the production literal tables. Known artifact: the table's t=1
    CPL cell was pasted unrounded (1.66615 vs 1.67) — tolerance covers it."""
    p = json.loads((FIX / "curve_params.json").read_text())
    gen = MasterCurves.from_params(
        L=p["leads_curve"]["L"], k=p["leads_curve"]["k"], x0=p["leads_curve"]["x0"],
        a=p["cpl_curve"]["a"], b=p["cpl_curve"]["b"], c=p["cpl_curve"]["c"])
    for t in range(1, 101):
        assert gen.leads_at(t) == params.leads_at(t), f"leads t={t}"
        tol = 5e-3 if t == 1 else 1e-9
        assert gen.cpl_at(t) == pytest.approx(params.cpl_at(t), abs=tol), f"cpl t={t}"


def test_greedy_invariants(cells, params):
    """greedy_marginal: budget respected, caps/floors respected, monotone in budget."""
    surfaces = {c.key: project(c, params) for c in cells.values()}
    caps = {k: max_roi_point(s)[2] for k, s in surfaces.items()}
    floors = {k: 0.0 for k in surfaces}
    for budget in (10000.0, 30000.0, 48000.0):
        alloc = greedy_marginal(surfaces, "car_count", caps, floors, budget)
        assert sum(alloc.values()) <= budget + 1e-6
        for k, v in alloc.items():
            assert floors[k] - 1e-9 <= v <= caps[k] + 1e-6
    a1 = greedy_marginal(surfaces, "car_count", caps, floors, 20000.0)
    a2 = greedy_marginal(surfaces, "car_count", caps, floors, 40000.0)
    assert sum(a2.values()) >= sum(a1.values()) - 1e-6
