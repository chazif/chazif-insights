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
        for i in range(1, 100):
            if cpl[i] <= cpl[i - 1]:
                for j in range(i, 100):
                    cpl[j] = cpl[i - 1]
                    leads[j] = leads[i - 1]
                break
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

    @property
    def key(self):
        return (self.brand, self.region, self.category)


@dataclass
class Surfaces:
    """Six projection surfaces for one cell, indexed t = 1..100 (MODEL_SPEC §3)."""
    leads: list = field(default_factory=list)
    cpl: list = field(default_factory=list)
    spend: list = field(default_factory=list)
    cars: list = field(default_factory=list)
    revenue: list = field(default_factory=list)
    adroi: list = field(default_factory=list)

    def at(self, t):
        i = t - 1
        return dict(t=t, leads=self.leads[i], cpl=self.cpl[i], spend=self.spend[i],
                    cars=self.cars[i], revenue=self.revenue[i], adroi=self.adroi[i])


def project(cell: Cell, curves: MasterCurves) -> Surfaces:
    """MODEL_SPEC §3. Ratio-scales the master tables to the cell's actuals."""
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
        cars = mround(spend / cell.cost_per_car) if cell.cost_per_car else 0
        revenue = cars * cell.rev_per_car
        adroi = revenue * cell.gp_pct - spend
        s.leads.append(leads); s.cpl.append(cpl); s.spend.append(spend)
        s.cars.append(cars); s.revenue.append(revenue); s.adroi.append(adroi)
    return s


def max_roi_point(s: Surfaces):
    """(is_at_max_roi, max_adroi, spend_cap) — first t achieving the ROI maximum,
    matching the workbook's MAX + exact XLOOKUP (MODEL_SPEC §3)."""
    best = max(s.adroi)
    t = s.adroi.index(best) + 1
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
