#!/usr/bin/env python3
"""V2 chained projection (engine/budget_intel/model, PR bi-v2-chained-projection).

The chained model scales every goal rung off the LEAD curve, so revenue/profit inherit
diminishing returns and a valued goal has a genuine interior optimum (below the curve's
saturation point) — unlike the legacy cars=spend÷cost_per_car chain, whose optimum is
saturation. Covers: interior optimum, per-goal caps differing by value, volume goals,
and that legacy mode is unchanged. Pure functions; no I/O.
"""
import math

import pytest

from engine.budget_intel.model import (Cell, MasterCurves, project, goal_cap,
                                        spend_saturation, mround)


def synth_curves():
    """A lead curve that saturates (~t=70) with a steadily rising CPL — so spend keeps
    climbing while extra leads dry up, which is what creates an interior profit optimum."""
    leads = [mround(1000 / (1 + math.exp(-0.15 * (t - 40)))) for t in range(1, 101)]
    cpl = [round(1.0 + 0.05 * t, 4) for t in range(1, 101)]     # 1.05 → 6.00, monotone
    return MasterCurves.from_tables(leads, cpl)


def synth_cell(**goal_units):
    """Cell anchored at is_current=40 with main_conv = leads(40) and cpa = cpl(40), so the
    projected leads/cpl reproduce the master curve exactly (clean, checkable arithmetic)."""
    c = synth_curves()
    return Cell(brand="B", region="R", category="C",
                main_conv=c.leads_at(40), cpa=c.cpl_at(40), is_current=40,
                goal_units=dict(goal_units))


def test_chained_has_interior_optimum_below_saturation():
    curves = synth_curves()
    # transactions = 20% of main_conv; each worth $50 at 50% margin -> $5 of profit per lead.
    cell = synth_cell(transactions=0.2 * synth_curves().leads_at(40))
    cfg = {"transactions": {"value_per_unit": 50.0, "margin_pct": 0.5}}
    s = project(cell, curves, mode="chained", goal_config=cfg)

    t_sat, _ = spend_saturation(s)
    t_opt, max_profit, cap = goal_cap(s, "transactions")
    assert 1 < t_opt < t_sat                              # strictly interior, below saturation
    assert max_profit == max(s.goal_profit["transactions"])
    assert s.goal_profit["transactions"][t_opt - 1] > s.goal_profit["transactions"][t_sat - 1]
    assert s.goal_profit["transactions"][t_opt - 1] > s.goal_profit["transactions"][0]
    assert cap == s.spend[t_opt - 1]
    # units chain off leads by the observed ratio (0.2)
    assert s.units["transactions"][t_opt - 1] == mround(s.leads[t_opt - 1] * 0.2)
    # main_conv is a rung too (ratio 1 -> units == leads)
    assert s.units["main_conv"] == s.leads


def test_two_goals_with_different_values_produce_different_caps():
    curves = synth_curves()
    cell = synth_cell(transactions=0.2 * synth_curves().leads_at(40))
    lo = project(cell, curves, mode="chained", goal_config={"transactions": {"value_per_unit": 30.0, "margin_pct": 0.5}})
    hi = project(cell, curves, mode="chained", goal_config={"transactions": {"value_per_unit": 90.0, "margin_pct": 0.5}})
    _, _, cap_lo = goal_cap(lo, "transactions")
    _, _, cap_hi = goal_cap(hi, "transactions")
    assert cap_hi > cap_lo                                # a more valuable goal buys further up the curve


def test_volume_goal_without_value_caps_at_saturation():
    curves = synth_curves()
    cell = synth_cell(transactions=0.2 * synth_curves().leads_at(40))
    s = project(cell, curves, mode="chained", goal_config={"transactions": {"value_per_unit": None}})
    assert "transactions" not in s.goal_profit               # no profit curve
    t_opt, profit, cap = goal_cap(s, "transactions")
    t_sat, sat = spend_saturation(s)
    assert profit is None and cap == sat and t_opt == t_sat


def test_legacy_mode_is_the_default_and_unchanged():
    curves = synth_curves()
    cell = Cell(brand="B", region="R", category="C", main_conv=500, cpa=3.0,
                is_current=40, cost_per_car=120.0, rev_per_car=800.0, gp_pct=0.4)
    default = project(cell, curves)                          # no mode arg
    legacy = project(cell, curves, mode="legacy")
    assert default.cars == legacy.cars and default.adroi == legacy.adroi
    assert default.cars and default.adroi                    # legacy chain populated
    assert not default.units and not default.goal_profit     # no goal surfaces in legacy
    # spot-check the legacy chain: cars = round(spend / cost_per_car)
    assert default.cars[49] == mround(default.spend[49] / 120.0)
