#!/usr/bin/env python3
"""Budget allocation + recommendation assembly (MODEL_SPEC §§5–6).

Two allocator modes:
  legacy_waterfall — exact port of the workbook's five-pass proportional
                     waterfall (golden-tested against the fixture run).
  greedy_marginal  — allocate in small steps to the cell with the best marginal
                     goal-metric on its curve; same caps/floors. Default for new
                     work; invariant-tested, not golden-tested.
"""
from .model import (Cell, MasterCurves, project, max_roi_point,
                    expected_is_for_spend, scores, GOAL_TO_SCORE)

EPS = 1e-9


def _proportional_pass(pool, score_by_key, alloc, caps, floors):
    """One waterfall pass: distribute `pool` proportionally to scores among the
    given cells, clamping each grant into [floor, headroom-to-cap]."""
    total_score = sum(score_by_key.values())
    if pool <= EPS or total_score <= EPS:
        return
    for key, sc in score_by_key.items():
        share = pool * sc / total_score
        headroom = caps[key] - alloc[key]
        give = min(share, headroom)
        give = max(give, min(floors[key] - alloc[key], headroom))  # floor clamp (0 in practice)
        alloc[key] += max(give, 0.0)


def legacy_waterfall(cells_scores, caps, floors, budget, passes=5):
    """cells_scores: {key: score}. Returns {key: final_spend} (MODEL_SPEC §5)."""
    alloc = {k: 0.0 for k in cells_scores}
    for _ in range(passes):
        remaining = budget - sum(alloc.values())
        if remaining <= EPS:
            break
        eligible = {k: s for k, s in cells_scores.items()
                    if s > EPS and alloc[k] < caps[k] - EPS}
        if not eligible:
            break
        _proportional_pass(remaining, eligible, alloc, caps, floors)
    # final clamp (workbook col AF)
    return {k: min(max(alloc[k], floors[k]), caps[k]) for k in alloc}


def greedy_marginal(surfaces_by_key, goal, caps, floors, budget, step=100.0):
    """Allocate `budget` in `step` increments to the best marginal goal-metric.
    goal metric per mode: car_count -> cars, gp/max_roi -> adroi,
    revenue -> revenue, main_conv -> leads."""
    metric = {"car_count": "cars", "gp": "adroi", "max_roi": "adroi",
              "revenue": "revenue", "main_conv": "leads"}[goal]
    alloc = {k: floors[k] for k in surfaces_by_key}
    remaining = budget - sum(alloc.values())

    def marginal(key):
        s = surfaces_by_key[key]
        cur_spend = alloc[key]
        if cur_spend >= caps[key] - EPS:
            return None
        t_now = expected_is_for_spend(s, cur_spend)
        nxt_spend = min(cur_spend + step, caps[key])
        t_nxt = expected_is_for_spend(s, nxt_spend)
        gain = getattr(s, metric)[t_nxt - 1] - getattr(s, metric)[t_now - 1]
        spent = nxt_spend - cur_spend
        return (gain / spent if spent > EPS else 0.0, nxt_spend - cur_spend)

    while remaining > EPS:
        best_key, best_rate, best_amt = None, -1e18, 0.0
        for key in surfaces_by_key:
            m = marginal(key)
            if m and m[0] > best_rate and m[1] <= remaining + EPS:
                best_key, (best_rate, best_amt) = key, m
        if best_key is None or best_rate <= 0:
            break
        alloc[best_key] += best_amt
        remaining -= best_amt
    return alloc


def run_allocation(cells, curves: MasterCurves, goal, budget, mode="greedy_marginal",
                   run_params=None):
    """End-to-end: cells (list[Cell]) -> per-cell result rows (MODEL_SPEC §6).

    goal: main_conv | car_count | gp | revenue  (score variant + greedy metric)
          max_roi  -> ignore budget; every cell gets its profit-max spend.
    run_params: {"floors": {key: $}, "score_config": {...},
                 "score_overrides": {key: score},   # e.g. the workbook 0.25 quirk
                 "max_change_pct": 0.30 or None, "passes": 5}
    """
    rp = run_params or {}
    surfaces, caps, floors, score_by_key, cell_by_key = {}, {}, {}, {}, {}
    score_variant = GOAL_TO_SCORE.get(goal, "revenue")

    for cell in cells:
        key = cell.key
        cell_by_key[key] = cell
        s = project(cell, curves)
        surfaces[key] = s
        _, _, cap = max_roi_point(s)
        caps[key] = cap
        floors[key] = float(rp.get("floors", {}).get(key, 0.0))
        score_by_key[key] = scores(cell, rp.get("score_config"))[score_variant]
    for key, val in (rp.get("score_overrides") or {}).items():
        if key in score_by_key:
            score_by_key[key] = val

    if goal == "max_roi":
        final = dict(caps)
    elif mode == "legacy_waterfall":
        final = legacy_waterfall(score_by_key, caps, floors, budget,
                                 passes=rp.get("passes", 5))
    else:
        final = greedy_marginal(surfaces, goal, caps, floors, budget,
                                step=rp.get("step", 100.0))

    # playbook guard: cap week-over-week change per cell (None disables — the
    # golden fixture run predates this guard)
    max_change = rp.get("max_change_pct")
    if max_change is not None:
        for key, cell in cell_by_key.items():
            lo = cell.cost * (1 - max_change)
            hi = cell.cost * (1 + max_change)
            if cell.cost > 0:
                final[key] = min(max(final[key], lo), hi)

    results = []
    for key, spend in final.items():
        cell, s = cell_by_key[key], surfaces[key]
        t = expected_is_for_spend(s, spend)
        point = s.at(t)
        results.append(dict(
            brand=cell.brand, region=cell.region, category=cell.category,
            opp_score=score_by_key[key],
            lw_spend=cell.cost, rec_spend=spend,
            spend_cap=caps[key], spend_floor=floors[key],
            expected_is=t, lw_is=cell.is_share * 100,
            expected_cpa=point["cpl"], lw_cpa=cell.cpa,
            tcpa_current=cell.tcpa,
            tcpa_recommended=point["cpl"],           # tCPA adjustment = expected CPA − current tCPA
            expected_conv=point["leads"], lw_conv=cell.main_conv,
            expected_cars=point["cars"], lw_cars=cell.car_count,
            expected_revenue=point["revenue"], expected_adroi=point["adroi"],
        ))
    return results
