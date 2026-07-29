#!/usr/bin/env python3
"""Curve fitting: simulator points / observed history -> MasterCurves.

The simulator is a PRIOR, never the model (FEATURE_SPEC §B2). Fits are stored
versioned in bi_curve_fits; the read path resolves per-cell fit -> account fit.
scipy is required for fitting only — reading stored fits works without it.
"""
import datetime
import json
import math

from sqlalchemy import select, insert, update

from .model import MasterCurves
from .tables import curve_fits


def _r2(actual, predicted):
    n = len(actual)
    if n < 2:
        return None
    mean = sum(actual) / n
    ss_tot = sum((a - mean) ** 2 for a in actual)
    ss_res = sum((a - p) ** 2 for a, p in zip(actual, predicted))
    return 1.0 - ss_res / ss_tot if ss_tot > 0 else None


def normalize_points(points):
    """[{is_share, spend_week, leads_week, cpl?}] -> [(is_pct, leads, cpl)].
    is_share accepts fraction (0.15) or percent (15). cpl derived from
    spend/leads when absent."""
    out = []
    for p in points:
        s = float(p.get("is_share") or 0)
        is_pct = s * 100.0 if s <= 1.0 else s
        leads = float(p.get("leads_week") or 0)
        cpl = p.get("cpl")
        spend = p.get("spend_week")
        if cpl is None and spend and leads:
            cpl = float(spend) / leads
        if is_pct > 0 and leads > 0 and cpl:
            out.append((is_pct, leads, float(cpl)))
    return sorted(out)


def fit_master_curves(points):
    """Fit logistic (leads) + quadratic (CPL) to normalized simulator/observed
    points. Returns (params_dict, diagnostics_dict). Raises ValueError if there
    aren't enough points (need >= 4)."""
    import numpy as np
    from scipy.optimize import curve_fit

    pts = normalize_points(points)
    if len(pts) < 4:
        raise ValueError(f"need >= 4 usable points to fit, got {len(pts)}")
    x = np.array([p[0] for p in pts])
    y_leads = np.array([p[1] for p in pts])
    y_cpl = np.array([p[2] for p in pts])

    def logistic(t, L, k, x0):
        return L / (1.0 + np.exp(-k * (t - x0)))

    L0 = float(y_leads.max()) * 1.5
    (L, k, x0), _ = curve_fit(logistic, x, y_leads, p0=[L0, 0.1, float(x.mean())],
                              bounds=([1e-6, 1e-4, 0.0], [1e9, 5.0, 100.0]),
                              maxfev=20000)
    a, b, c = (float(v) for v in np.polyfit(x, y_cpl, 2))

    params = {"leads": {"L": float(L), "k": float(k), "x0": float(x0)},
              "cpl": {"a": a, "b": b, "c": c}}
    diagnostics = {
        "n_points": len(pts),
        "r2_leads": _r2(list(y_leads), [float(logistic(t, L, k, x0)) for t in x]),
        "r2_cpl": _r2(list(y_cpl), [a * t * t + b * t + c for t in x]),
    }
    return params, diagnostics


def curves_from_params(params):
    """Stored params JSON -> MasterCurves. Accepts either parametric
    ({"leads":{L,k,x0},"cpl":{a,b,c}}) or tabulated ({"tables":{leads,cpl}})."""
    if "tables" in params:
        return MasterCurves.from_tables(params["tables"]["leads"],
                                        params["tables"]["cpl"])
    lp, cp = params["leads"], params["cpl"]
    return MasterCurves.from_params(L=lp["L"], k=lp["k"], x0=lp["x0"],
                                    a=cp["a"], b=cp["b"], c=cp["c"])


def save_fit(engine, client_id, params, diagnostics, source,
             scope=(None, None, None)):
    """Persist a fit and make it the active one for its scope (old fits are
    kept, flagged inactive — the history is the calibration record)."""
    brand, region, category = scope
    now = datetime.datetime.now(datetime.timezone.utc)
    with engine.begin() as c:
        c.execute(update(curve_fits).where(
            (curve_fits.c.client_id == client_id)
            & (curve_fits.c.scope_brand.is_(brand) if brand is None
               else curve_fits.c.scope_brand == brand)
            & (curve_fits.c.scope_region.is_(region) if region is None
               else curve_fits.c.scope_region == region)
            & (curve_fits.c.scope_category.is_(category) if category is None
               else curve_fits.c.scope_category == category)
        ).values(active=False))
        c.execute(insert(curve_fits).values(
            client_id=client_id, scope_brand=brand, scope_region=region,
            scope_category=category, fitted_at=now, params=params,
            diagnostics=diagnostics, source=source, active=True))


def _row_params(row):
    p = row.params
    return json.loads(p) if isinstance(p, str) else p


def get_active_curves(engine, client_id, cell_key=None):
    """Resolve MasterCurves for a cell: per-cell fit -> account-level fit.
    Raises LookupError with an actionable message when no fit exists."""
    with engine.connect() as c:
        rows = c.execute(select(curve_fits).where(
            (curve_fits.c.client_id == client_id) & (curve_fits.c.active == True)  # noqa: E712
        )).all()
    if cell_key:
        brand, region, category = cell_key
        for r in rows:
            if (r.scope_brand, r.scope_region, r.scope_category) == (brand, region, category):
                return curves_from_params(_row_params(r))
    for r in rows:
        if r.scope_brand is None and r.scope_region is None and r.scope_category is None:
            return curves_from_params(_row_params(r))
    raise LookupError(
        f"no active curve fit for client '{client_id}' — add simulator points "
        "(POST simulator-snapshots) or save a manual fit first")
