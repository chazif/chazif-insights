#!/usr/bin/env python3
"""Budget Intelligence math core — pure functions, no I/O.

Authoritative spec: docs/budget-intel/MODEL_SPEC.md (formulas reverse-engineered
from the production workbook, cell provenance cited there). The golden test
reproduces the workbook exactly, so rounding here deliberately mirrors Excel:
MROUND(x, 1) = round-half-away-from-zero to the nearest integer.

Master curves are TABLES (leads and CPL at IS 1..100). The production workbook
ran on pasted literal tables (Ratios!A11:B110); parametric fits (logistic +
quadratic) GENERATE tables via MasterCurves.from_params, applying the same
monotone cap the production tables carry: once CPL stops rising, both curves
hold flat (beyond that point the extrapolation isn't trusted).
"""
import math
from dataclasses import dataclass, field

IS_RANGE = range(1, 101)   # impression-share axis, integer percent


def mround(x):
    """Excel MROUND(x, 1): nearest integer, ties away from zero."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return 0
    return math.floor(x + 0.5) if x >= 0 else -math.floor(-x + 0.5)


@dataclass(frozen=True)
class MasterCurves:
    """Account-level master response tables, index t-1 for IS t in 1..100."""
    leads: tuple   # 100 ints (workbook rounds the leads master)
    cpl: tuple     # 100 floats

    def leads_at(self, t):
        return self.leads[t - 1]

    def cpl_at(self, t):
        return self.cpl[t - 1]

    @classmethod
    def from_tables(cls, leads, cpl):
        assert len(leads) == 100 and len(cpl) == 100
        return cls(leads=tuple(leads), cpl=tuple(cpl))

    @classmethod
    def from_params(cls, L, k, x0, a, b, c, cpl_round=2):
        """Generate tables from a logistic (leads) + quadratic (CPL) fit.
        Monotone cap: from the first t where CPL (rounded to `cpl_round` dp,
        matching production behavior) stops rising, hold both curves flat."""
        leads, cpl = [], []
        for t in IS_RANGE:
            leads.append(mround(L / (1.0 + math.exp(-k * (t - x0)))))
            cpl.append(round(a * t * t + b * t + c, cpl_round))
        # Monotone cap (production behavior): once CPL peaks and would decline,
        # freeze BOTH curves at the peak — upward extrapolation past the CPL
        # peak isn't trusted (a concave quadratic would otherwise project
        # cheaper leads at higher IS). CPL still rising at IS=100 (convex fits,
        # e.g. scale efficiencies at low IS) never triggers this; a global peak
        # at t=1 is left unfrozen rather than freezing the whole curve.
        peak = max(range(100), key=lambda i: cpl[i])   # first index of the max
        if 0 < peak < 99:
            for j in range(peak + 1, 100):
                cpl[j] = cpl[peak]
                leads[j] = leads[peak]
        return cls(leads=tuple(leads), cpl=tuple(cpl))


@dataclass
class Cell:
    """One Brand × Region × Category actuals row (MODEL_SPEC §1)."""
    brand: str
    region: str
    category: str
    impr: float = 0.0
    clicks: float = 0.0
    cost: float = 0.0
    main_conv: float = 0.0
    cpa: float = 0.0
    tcpa: float = 0.0
    is_share: float = 0.0          # fraction 0..1
    is_lost_budget: float = 0.0
    is_lost_rank: float = 0.0
    rev_per_car: float = 0.0
    gp_per_car: float = 0.0
    gp_pct: float = 0.0
    cost_per_car: float = 0.0
    car_count: float = 0.0
    is_current: int = 0            # rounded integer percent (curve index)
    # V2 goal ladder: observed units per rung over the reference period, keyed by
    # goal_key (e.g. {"all_conv": 500, "transactions": 120, ...}). main_conv is the
    # curve rung (ratio 1) and lives in `main_conv`; this holds the other rungs.
    goal_units: dict = field(default_factory=dict)

    @property
    def key(self):
        return (self.brand, self.region, self.category)


@dataclass
class Surfaces:
    """Projection surfaces for one cell, indexed t = 1..100 (MODEL_SPEC §3).

    leads/cpl/spend are always populated. Legacy mode fills cars/revenue/adroi (the
    constant cost-per-car chain). Chained (V2) mode fills the per-goal dicts instead:
    `units[goal_key]`, `goal_revenue[goal_key]`, `goal_profit[goal_key]` — each a
    100-length list; a volume goal (no value) has units only."""
    leads: list = field(default_factory=list)
    cpl: list = field(default_factory=list)
    spend: list = field(default_factory=list)
    cars: list = field(default_factory=list)
    revenue: list = field(default_factory=list)
    adroi: list = field(default_factory=list)
    units: dict = field(default_factory=dict)          # goal_key -> [units at t=1..100]
    goal_revenue: dict = field(default_factory=dict)   # goal_key -> [revenue at t]
    goal_profit: dict = field(default_factory=dict)    # goal_key -> [profit at t] (valued rungs)

    def at(self, t):
        i = t - 1
        return dict(t=t, leads=self.leads[i], cpl=self.cpl[i], spend=self.spend[i],
                    cars=self.cars[i], revenue=self.revenue[i], adroi=self.adroi[i])


def project(cell: Cell, curves: MasterCurves, mode="legacy", goal_config=None) -> Surfaces:
    """MODEL_SPEC §3. Ratio-scales the master tables to the cell's actuals.

    mode="legacy" (default — golden parity): business cars/revenue/adroi from the
    constant cost-per-car chain (`cars = spend ÷ cost_per_car`), which is linear in
    spend so its optimum is the curve's saturation point.

    mode="chained" (V2): every goal rung is scaled off the LEAD curve by its observed
    ratio, so revenue/profit inherit the lead curve's diminishing returns and each
    valued rung has a genuine interior optimum. `goal_config` maps goal_key ->
    {value_per_unit, margin_pct}; a rung without a value is volume-maximizing.

    leads/cpl/spend are computed the same way in both modes."""
    s = Surfaces()
    ok = 1 <= cell.is_current <= 100
    base_leads = curves.leads_at(cell.is_current) if ok else 0
    base_cpl = curves.cpl_at(cell.is_current) if ok else 0.0
    for t in IS_RANGE:
        if not base_leads or not base_cpl:
            leads, cpl = 0, 0.0
        else:
            leads = mround(cell.main_conv * curves.leads_at(t) / base_leads)
            cpl = cell.cpa * curves.cpl_at(t) / base_cpl
        spend = cpl * leads
        s.leads.append(leads); s.cpl.append(cpl); s.spend.append(spend)
        if mode == "legacy":
            cars = mround(spend / cell.cost_per_car) if cell.cost_per_car else 0
            revenue = cars * cell.rev_per_car
            adroi = revenue * cell.gp_pct - spend
            s.cars.append(cars); s.revenue.append(revenue); s.adroi.append(adroi)
    if mode == "chained":
        _project_goals(cell, s, goal_config or {})
    return s


def goal_ratios(cell: Cell):
    """Observed per-cell ratio of each rung to main_conv (main_conv itself = 1),
    held constant along the curve (MODEL_SPEC / V2 §2 stated assumption)."""
    ratios = {"main_conv": 1.0}
    if cell.main_conv:
        for g, u in (cell.goal_units or {}).items():
            ratios[g] = u / cell.main_conv
    return ratios


def _project_goals(cell: Cell, s: Surfaces, goal_config):
    """Chain each rung off the lead curve (V2 §3): units[g](t) = mround(leads(t)·ratio[g]);
    revenue/profit follow when the rung carries a value, else it is volume-only."""
    for g, ratio in goal_ratios(cell).items():
        units = [mround(lead * ratio) for lead in s.leads]
        s.units[g] = units
        cfg = goal_config.get(g) or {}
        vpu = cfg.get("value_per_unit")
        if vpu is None:
            continue                                   # volume goal — no profit optimum
        margin = cfg.get("margin_pct")
        margin = 1.0 if margin is None else margin
        rev = [u * vpu for u in units]
        s.goal_revenue[g] = rev
        s.goal_profit[g] = [rev[i] * margin - s.spend[i] for i in range(len(units))]


def max_roi_point(s: Surfaces):
    """(is_at_max_roi, max_adroi, spend_cap) — first t achieving the ROI maximum,
    matching the workbook's MAX + exact XLOOKUP (MODEL_SPEC §3)."""
    best = max(s.adroi)
    t = s.adroi.index(best) + 1
    return t, best, s.spend[t - 1]


def spend_saturation(s: Surfaces):
    """Curve freeze point (goal-independent): (t, spend) where projected spend stops
    rising — extra impression share buys nothing more. Spend is non-decreasing then
    flat, so this is the max and the first t that reaches it; t=100 when it never
    freezes. This is the 'ceiling' number surfaced alongside each goal's optimum."""
    if not s.spend:
        return 0, 0.0
    sat = max(s.spend)
    return s.spend.index(sat) + 1, sat


def goal_cap(s: Surfaces, goal_key):
    """Profit-max for one goal: (t, max_profit, spend_cap) at argmax profit[goal_key].
    A volume goal (no profit curve — no value on the rung) caps at spend_saturation,
    returned as (t_sat, None, spend_sat)."""
    profit = s.goal_profit.get(goal_key)
    if not profit:
        t, sat = spend_saturation(s)
        return t, None, sat
    best = max(profit)
    t = profit.index(best) + 1
    return t, best, s.spend[t - 1]


def expected_is_for_spend(s: Surfaces, spend_target):
    """Smallest t whose spend >= target (XLOOKUP match_mode 1). Clamps to 100."""
    for t in IS_RANGE:
        if s.spend[t - 1] >= spend_target - 1e-9:
            return t
    return 100


# ---- opportunity scores (MODEL_SPEC §4) -----------------------------------

def _headroom(is_share, cap):
    return max(cap - is_share, 0.01)


def scores(cell: Cell, config=None):
    """All four goal-specific variants, the CONSISTENT formula (the workbook's
    region-first rows carry a legacy *0.25 — see MODEL_SPEC §4; handled by
    callers via score overrides, never here). Zero-guarded."""
    cfg = config or {}
    if not cell.impr or not cell.cost or not cell.is_share:
        return dict(main_conv=0.0, car_count=0.0, gp=0.0, revenue=0.0)
    mc, cars = cell.main_conv, cell.car_count
    eligible_headroom = (cell.impr / cell.is_share) * (1 - cell.is_share)
    return dict(
        main_conv=(mc / cell.cost) * (mc / cell.impr) * eligible_headroom
                  * cfg.get("w_main_conv", 1.0),
        car_count=(cars / cell.impr) * (cars / cell.cost) ** 2
                  * _headroom(cell.is_share, cfg.get("cap_car_count", 0.75))
                  * cfg.get("w_car_count", 1e8),
        gp=(cars / cell.impr) * (cars / cell.cost) ** 2 * cell.gp_per_car ** 2
           * _headroom(cell.is_share, cfg.get("cap_gp", 0.55))
           * cfg.get("w_gp", 1e3),
        revenue=(cars / cell.impr) * (cars / cell.cost) * cell.rev_per_car
                * _headroom(cell.is_share, cfg.get("cap_revenue", 0.55))
                * cfg.get("w_revenue", 1e4),
    )


GOAL_TO_SCORE = {
    "main_conv": "main_conv",
    "car_count": "car_count",
    "gp": "gp",
    "revenue": "revenue",
}
