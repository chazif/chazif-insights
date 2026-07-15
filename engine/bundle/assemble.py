#!/usr/bin/env python3
"""Assemble a client's DATA bundle from the raw warehouse (Phase 2, increment 1).

Produces the keys the core views (Overview, Monthly Trends) consume, computed from
real ingested data. The analyzers (density, n-gram waste, QS, three-bucket, PMax)
and the full view set land in later increments; this proves the raw -> bundle ->
dashboard seam for a real client.
"""
import calendar
from sqlalchemy import text, select, func
from ..ingest.store import get_engine, clients, uploads
from ..ingest.service import get_config
from ..analyze.analyzers import run_analyzers

FULL_MONTHS = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
SEV_ORDER = {"CRITICAL": 0, "IMPORTANT": 1, "OPPORTUNITY": 2, "PASS": 3}
SEV_PRIORITY = {"CRITICAL": "High", "IMPORTANT": "Medium", "OPPORTUNITY": "Low", "PASS": "Low"}
MOD_CATEGORY = {"D": "Data Density & Budget", "K": "Keywords & Negatives",
                "Q": "Quality Score", "P": "Performance Max"}
EFFORT_LABEL = {"S": "Low", "M": "Medium", "L": "High"}
DOLLAR_LABEL = {"HIGH": "High", "MEDIUM": "Medium", "LOW": "Low"}

MONTHS = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}
MABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _month_key(label):
    """'March 2026' -> (2026, 3, '2026-03', 'Mar 2026'); None if unparseable."""
    if not label:
        return None
    parts = str(label).strip().split()
    if len(parts) != 2:
        return None
    mo = MONTHS.get(parts[0].lower())
    try:
        yr = int(parts[1])
    except ValueError:
        return None
    if not mo:
        return None
    return (yr, mo, f"{yr}-{mo:02d}", f"{MABBR[mo-1]} {yr}")


def _client_name(engine, client_id):
    with engine.connect() as c:
        r = c.execute(select(clients.c.name).where(clients.c.client_id == client_id)).first()
        return r[0] if r else client_id


def _latest_complete_month(engine, client_id):
    """From the export window_end, return the latest fully-covered month as
    {year, month, ym, full, abbr}, or None. A window ending mid-month means that
    month is partial, so we step back one."""
    with engine.connect() as c:
        we = c.execute(select(func.max(uploads.c.window_end)).where(
            uploads.c.client_id == client_id)).scalar()
    if not we:
        return None
    y, m = we.year, we.month
    if we.day < calendar.monthrange(y, m)[1]:
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return {"year": y, "month": m, "ym": f"{y}-{m:02d}",
            "full": f"{FULL_MONTHS[m-1]} {y}", "abbr": f"{MABBR[m-1]} {y}"}


def _to_recommendations(findings):
    recs = []
    for f in sorted(findings, key=lambda x: SEV_ORDER.get(x["severity"], 9)):
        if f["severity"] == "PASS":
            continue
        recs.append({
            "Priority": SEV_PRIORITY.get(f["severity"], "Medium"),
            "Category": MOD_CATEGORY.get(f["module"], f["module"]),
            "Recommendation": f"{f['action']} {f['summary']}",
            "Rationale": f"{f['observation']} {f['impact']}",
            "Expected Impact": DOLLAR_LABEL.get(f["dollar"], f["dollar"]),
            "Effort": EFFORT_LABEL.get(f["effort"], f["effort"]),
        })
    return recs


def _to_overview_findings(findings):
    out = [{"topic": f["title"], "detail": f["magnitude"]}
           for f in sorted(findings, key=lambda x: SEV_ORDER.get(x["severity"], 9))
           if f["severity"] != "PASS"]
    return out[:6]


def build_bundle(client_id, engine=None):
    """Return the DATA bundle dict for a client, or None if there's no campaign data."""
    engine = engine or get_engine()
    with engine.connect() as c:
        has = c.execute(text("SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='campaign_performance'"),
                        {"c": client_id}).scalar()
        if not has:
            return None

        # ---- monthly aggregates -> total_trend ----
        rows = c.execute(text(
            "SELECT date, SUM(cost) cost, SUM(clicks) clicks, SUM(conversions) conv "
            "FROM raw_rows WHERE client_id=:c AND report_type='campaign_performance' "
            "AND date IS NOT NULL GROUP BY date"), {"c": client_id}).all()
        series = []
        for date, cost, clicks, conv in rows:
            mk = _month_key(date)
            if mk:
                series.append((mk, float(cost or 0), float(clicks or 0), float(conv or 0)))
        series.sort(key=lambda x: (x[0][0], x[0][1]))

        # keep only fully-covered months (drop the partial trailing export month)
        cm = _latest_complete_month(engine, client_id)
        if cm:
            series = [s for s in series if (s[0][0], s[0][1]) <= (cm["year"], cm["month"])]

        total_trend = [{
            "Month": mk[2],
            "Spend": round(cost, 2),
            "Clicks": round(clicks),
            "Main Conv": round(conv, 1),
            "CPA": round(cost / conv, 2) if conv else 0,
            "CVR": round(conv / clicks, 4) if clicks else 0,
        } for (mk, cost, clicks, conv) in series]

        # ---- YoY kpis: latest month vs same month prior year (fallback: vs previous month) ----
        kpis, meta_periods = [], {}
        if series:
            by_key = {mk[2]: (cost, clicks, conv) for (mk, cost, clicks, conv) in series}
            cur_mk = series[-1][0]
            prior_key = f"{cur_mk[0]-1}-{cur_mk[1]:02d}"
            if prior_key in by_key:
                prior_mk_label = f"{MABBR[cur_mk[1]-1]} {cur_mk[0]-1}"
            elif len(series) >= 2:
                pmk = series[-2][0]; prior_key = pmk[2]; prior_mk_label = pmk[3]
            else:
                prior_key = None; prior_mk_label = "—"
            cur_label = cur_mk[3]
            meta_periods = {"current": cur_label, "prior": prior_mk_label}

            cc, ccl, ccv = by_key[cur_mk[2]]
            pc, pcl, pcv = by_key.get(prior_key, (0, 0, 0)) if prior_key else (0, 0, 0)

            def chg(cur, prev):
                return round((cur - prev) / prev, 4) if prev else None
            def krow(metric, cur, prev):
                return {"Metric": metric, "Mar 2025": round(prev, 2), "Mar 2026": round(cur, 2), "Change": chg(cur, prev)}
            cur_cpa = cc / ccv if ccv else 0; prior_cpa = pc / pcv if pcv else 0
            cur_cvr = ccv / ccl if ccl else 0; prior_cvr = pcv / pcl if pcl else 0
            kpis = [
                krow("Total Spend", cc, pc),
                krow("Main Conversions", ccv, pcv),
                krow("CPA (Main Conv)", cur_cpa, prior_cpa),
                krow("CVR (Main Conv)", cur_cvr, prior_cvr),
            ]

        # ---- complexity profile ----
        n_brands = 1
        has_pmax = bool(c.execute(text(
            "SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements'"), {"c": client_id}).scalar())

    # ---- analyzers -> findings + recommendations (analyzers open their own connections) ----
    config = get_config(client_id, engine) or {}
    analyzer_findings = run_analyzers(engine, client_id, cm, config) if cm else []
    findings = _to_overview_findings(analyzer_findings)
    recommendations = _to_recommendations(analyzer_findings)

    return {
        "meta": {
            "client_id": client_id,
            "name": _client_name(engine, client_id),
            "periods": meta_periods,
            "complexity": {"n_brands": n_brands, "has_pmax": has_pmax},
            # Views this bundle populates. The frontend hides dashboard tabs not
            # listed here (workspace/admin tabs are always shown). Grows as later
            # increments populate more views.
            "views": ["overview", "trends", "recs"],
            "generated_from": "warehouse",
        },
        "total_trend": total_trend,
        "kpis": kpis,
        "findings": findings,
        "recommendations": recommendations,
    }
