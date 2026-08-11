#!/usr/bin/env python3
"""Account-relative grading: weighted median, ratio bands, cohort grader with its
guardrails (volume gate, zero-conversion floor, small-cohort + static fallback,
manual benchmark override)."""
import pytest

from engine.grading import (median, wmedian, grade_by_ratio, cohort_grader, GRADE_BANDS, SCORE_BANDS)


def test_median_and_wmedian():
    assert median([]) is None and wmedian([]) is None
    assert median([0.02, 0.05, 0.12]) == 0.05                    # plain: each counts once
    assert median([0.04, 0.06]) == 0.05                          # even count -> average of middle two
    assert wmedian([(0.05, 0)]) is None                          # zero weight ignored -> empty
    assert wmedian([(0.02, 1), (0.10, 100), (0.12, 1)]) == 0.10  # heavy weight pulls it up


def test_grade_by_ratio_bands():
    a = 0.05
    assert grade_by_ratio(0.08, a, GRADE_BANDS).startswith("A")   # 1.6x
    assert grade_by_ratio(0.06, a, GRADE_BANDS).startswith("B")   # 1.2x
    assert grade_by_ratio(0.05, a, GRADE_BANDS).startswith("C")   # 1.0x
    assert grade_by_ratio(0.03, a, GRADE_BANDS).startswith("D")   # 0.6x
    assert grade_by_ratio(0.01, a, GRADE_BANDS).startswith("F")   # 0.2x
    assert grade_by_ratio(0.10, 0, GRADE_BANDS) is None           # no anchor
    assert grade_by_ratio(0.10, a, SCORE_BANDS) == "Excellent"    # 2x on the score scale


# a "row" = (cvr, clicks, conv)
def _rows(*triples):
    return [{"cvr": c, "clicks": cl, "conv": cv} for (c, cl, cv) in triples]


STATIC = lambda r: "STATIC"   # sentinel so we can see when the fallback fires


def _grader(rows, weight_on=True, **kw):
    extra = {"weight": (lambda r: r["clicks"])} if weight_on else {}
    return cohort_grader(rows, rate=lambda r: r["cvr"], in_scope=lambda r: r["clicks"] >= 5,
                         static_fn=STATIC, bands=GRADE_BANDS, **extra, **kw)


def test_simple_median_avoids_big_entity_inflation():
    # one dominant low-rate entity + four higher-rate small ones.
    rows = _rows((0.01, 10000, 100), (0.04, 100, 4), (0.05, 100, 5), (0.05, 100, 5), (0.06, 100, 6))
    wg, _ = _grader(rows, weight_on=True)                 # weighted: anchor dragged to ~0.01
    sg, smeta = _grader(rows, weight_on=False)            # simple: median of the five rates
    assert smeta["anchor"] == 0.05
    assert wg(rows[1])[0] == "A"                          # 0.04 vs a tiny weighted anchor -> A (inflated)
    assert sg(rows[1])[0] in ("C", "D")                  # 0.04 vs 0.05 median -> around/below norm


def test_relative_spread_on_low_cvr_account():
    # every page is "below" a generic 20% bar, but relative grading spreads them.
    rows = _rows((0.16, 100, 16), (0.08, 100, 8), (0.05, 100, 5), (0.04, 100, 4), (0.02, 100, 2))
    grade_of, meta = _grader(rows)
    assert meta["mode"] == "relative"
    labels = [grade_of(r)[0] for r in rows]            # first letter of each grade
    assert "A" in labels and "F" in labels             # real spread, not all one grade
    assert meta["anchor"] > 0 and meta["c_lo"] < meta["anchor"] < meta["c_hi"]


def test_volume_gate_and_zero_conv_floor():
    rows = _rows((0.5, 3, 1),        # below click gate -> STATIC (its Low-Volume label)
                 (0.0, 50, 0),       # 0 conv on 50 clicks -> floor F
                 (0.06, 100, 6), (0.05, 100, 5), (0.04, 100, 4), (0.05, 100, 5))
    grade_of, _ = _grader(rows, zero_conv=lambda r: r["conv"] == 0 and r["clicks"] >= 20)
    assert grade_of(rows[0]) == "STATIC"
    assert grade_of(rows[1]).startswith("F")


def test_small_cohort_falls_back_to_static():
    grade_of, meta = _grader(_rows((0.10, 100, 10), (0.05, 100, 5)))   # only 2 gradeable
    assert meta["mode"] == "static" and meta.get("reason") == "small_cohort"
    assert grade_of({"cvr": 0.1, "clicks": 100, "conv": 10}) == "STATIC"


def test_static_mode_forces_static():
    grade_of, meta = _grader(_rows(*[(0.05, 100, 5)] * 6), mode="static")
    assert meta["mode"] == "static"
    assert grade_of({"cvr": 0.9, "clicks": 100, "conv": 90}) == "STATIC"


def test_manual_benchmark_overrides_median():
    rows = _rows(*[(0.10, 100, 10)] * 6)               # account median would be 0.10
    grade_of, meta = _grader(rows, benchmark=0.20)     # but the manual benchmark is 20%
    assert meta["mode"] == "benchmark" and meta["anchor"] == 0.20
    assert grade_of(rows[0]).startswith("D")           # 0.10 / 0.20 = 0.5x -> D
