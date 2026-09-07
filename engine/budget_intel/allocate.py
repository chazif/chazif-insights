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
                    expected_is_for_spend, scores, goal_score, goal_cap,
                    spend_saturation, GOAL_TO_SCORE)

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


def greedy_marginal(surfaces_by_key, goal, caps, floors, budget, step=None):
    """Allocate `budget` by repeatedly buying the best-rate step ALONG EACH
    CELL'S OWN CURVE GRID (the spend points at IS 1..100) — fixed-dollar steps
    don't work here because consecutive grid points can be far apart in spend.

    Each candidate step moves a cell from its committed grid point to a higher
    one; rate = Δmetric / Δspend. Best rate wins, repeat until the budget or
    the positive-rate candidates run out. Caps/floors respected throughout.
    goal metric: car_count -> cars, gp/max_roi -> adroi, revenue -> revenue,
    main_conv -> leads."""
    metric_name = {"car_count": "cars", "gp": "adroi", "max_roi": "adroi",
                   "revenue": "revenue", "main_conv": "leads"}[goal]
    alloc = {k: floors[k] for k in surfaces_by_key}
    committed_t = {k: 0 for k in surfaces_by_key}      # 0 = below the curve grid
    remaining = budget - sum(alloc.values())

    def metric_at(s, t):
        return getattr(s, metric_name)[t - 1] if t >= 1 else 0.0

    def best_step(key):
        """Best (rate, extra_spend, t) move for this cell, or None."""
        s = surfaces_by_key[key]
        now_t, cur = committed_t[key], alloc[key]
        base = metric_at(s, now_t)
        best = None
        for t in range(now_t + 1, 101):
            spend_t = s.spend[t - 1]
            if spend_t > caps[key] + EPS:
                break
            extra = spend_t - cur
            if extra <= EPS or extra > remaining + EPS:
                continue
            gain = metric_at(s, t) - base
            if gain <= 0:
                continue
            rate = gain / extra
            if best is None or rate > best[0]:
                best = (rate, extra, t)
        return best

    while remaining > EPS:
        best_key, best = None, None
        for key in surfaces_by_key:
            cand = best_step(key)
            if cand and (best is None or cand[0] > best[0]):
                best_key, best = key, cand
        if best_key is None:
            break
        _, extra, t = best
        alloc[best_key] += extra
        committed_t[best_key] = t
        remaining -= extra
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
    # golden fixture run predates this guard). Note the floor side means "never
    # cut a cell more than X% in one week", so the guarded total can deviate
    # from the requested budget (up or down) — that is intended: safety caps
    # outrank exact budget attainment. The UI surfaces the guarded total.
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


def _greedy_marginal_curves(spend_by_key, metric_by_key, caps, floors, budget):
    """Metric-agnostic greedy allocator (V2): each cell has a spend[] grid and a metric[] to
    maximize; buy the best marginal metric/spend step up each cell's own curve within
    [floor, cap] until the budget or the positive-rate steps run out. Same algorithm as
    greedy_marginal, decoupled from the fixed legacy surface-attribute names."""
    alloc = {k: floors[k] for k in spend_by_key}
    committed_t = {k: 0 for k in spend_by_key}
    remaining = budget - sum(alloc.values())

    def metric_at(k, t):
        return metric_by_key[k][t - 1] if t >= 1 else 0.0

    def best_step(key):
        spend, base = spend_by_key[key], metric_at(key, committed_t[key])
        cur, best = alloc[key], None
        for t in range(committed_t[key] + 1, 101):
            spend_t = spend[t - 1]
            if spend_t > caps[key] + EPS:
                break
            extra = spend_t - cur
            if extra <= EPS or extra > remaining + EPS:
                continue
            gain = metric_at(key, t) - base
            if gain <= 0:
                continue
            rate = gain / extra
            if best is None or rate > best[0]:
                best = (rate, extra, t)
        return best

    while remaining > EPS:
        best_key, best = None, None
        for key in spend_by_key:
            cand = best_step(key)
            if cand and (best is None or cand[0] > best[0]):
                best_key, best = key, cand
        if best_key is None:
            break
        _, extra, t = best
        alloc[best_key] += extra
        committed_t[best_key] = t
        remaining -= extra
    return alloc


def run_allocation_v2(cells, curves: MasterCurves, goal, budget, goal_config,
                      run_params=None, curve_source=None):
    """V2 chained allocation for ONE goal (V2_SPEC §§3–4). Projects chained, caps each cell at
    the goal's profit-max (goal_cap; = saturation for a volume goal with no value), scores with
    the parameterized shape, and allocates the budget by best marginal goal-units. Emits result
    rows tagged with `goal`, `spend_saturation`, and `data_source`. Legacy run_allocation is
    untouched. `goal_config`: {goal_key: {value_per_unit, margin_pct}}."""
    rp = run_params or {}
    cfg = goal_config or {}
    value_weight = (cfg.get(goal) or {}).get("value_per_unit") or 1.0
    surfaces, caps, sats, floors, score_by_key, cell_by_key, metric = {}, {}, {}, {}, {}, {}, {}

    for cell in cells:
        key = cell.key
        cell_by_key[key] = cell
        s = project(cell, curves, mode="chained", goal_config=cfg)
        surfaces[key] = s
        _, _, cap = goal_cap(s, goal)
        caps[key] = cap
        sats[key] = spend_saturation(s)[1]
        floors[key] = float(rp.get("floors", {}).get(key, 0.0))
        score_by_key[key] = goal_score(cell, goal, value_weight=value_weight,
                                       p=rp.get("score_p", 2),
                                       headroom_cap=rp.get("headroom_cap", 0.75))
        metric[key] = s.units.get(goal) or [0.0] * 100

    spend_by_key = {k: surfaces[k].spend for k in surfaces}
    final = _greedy_marginal_curves(spend_by_key, metric, caps, floors, budget)

    max_change = rp.get("max_change_pct")                  # held-back accounting lands in PR3
    if max_change is not None:
        for key, cell in cell_by_key.items():
            if cell.cost > 0:
                lo, hi = cell.cost * (1 - max_change), cell.cost * (1 + max_change)
                final[key] = min(max(final[key], lo), hi)

    valued = (cfg.get(goal) or {}).get("value_per_unit") is not None
    data_source = f"{goal} · {curve_source}" if curve_source else goal
    results = []
    for key, spend in final.items():
        cell, s = cell_by_key[key], surfaces[key]
        t = expected_is_for_spend(s, spend)
        i = t - 1
        results.append(dict(
            goal=goal, brand=cell.brand, region=cell.region, category=cell.category,
            opp_score=score_by_key[key], data_source=data_source,
            spend_saturation=round(sats[key], 4),
            lw_spend=cell.cost, rec_spend=spend,
            spend_cap=caps[key], spend_floor=floors[key],
            expected_is=t, lw_is=cell.is_share * 100,
            expected_cpa=s.cpl[i], lw_cpa=cell.cpa,
            tcpa_current=cell.tcpa, tcpa_recommended=s.cpl[i],
            expected_conv=s.leads[i], lw_conv=cell.main_conv,
            # reuse the cars/revenue/adroi columns for this goal's units/revenue/profit
            expected_cars=(s.units.get(goal) or [0])[i], lw_cars=(cell.goal_units or {}).get(goal, cell.main_conv),
            expected_revenue=(s.goal_revenue.get(goal) or [0.0] * 100)[i] if valued else 0.0,
            expected_adroi=(s.goal_profit.get(goal) or [0.0] * 100)[i] if valued else 0.0,
        ))
    return results
