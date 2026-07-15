#!/usr/bin/env python3
"""Assemble a client's DATA bundle from the raw warehouse (Phase 2, increment 1).

Produces the keys the core views (Overview, Monthly Trends) consume, computed from
real ingested data. The analyzers (density, n-gram waste, QS, three-bucket, PMax)
and the full view set land in later increments; this proves the raw -> bundle ->
dashboard seam for a real client.
"""
from sqlalchemy import text, select
from ..ingest.store import get_engine, clients

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

        # ---- a couple of real findings ----
        findings = []
        waste = c.execute(text(
            "SELECT COALESCE(SUM(cost),0) FROM raw_rows WHERE client_id=:c AND report_type='search_terms' "
            "AND cost>0 AND (conversions=0 OR conversions IS NULL)"), {"c": client_id}).scalar() or 0
        st_total = c.execute(text(
            "SELECT COALESCE(SUM(cost),0) FROM raw_rows WHERE client_id=:c AND report_type='search_terms'"),
            {"c": client_id}).scalar() or 0
        if waste:
            pct = (waste / st_total * 100) if st_total else 0
            findings.append({"topic": "Zero-conversion search-term waste",
                             "detail": f"${waste:,.0f} spent on search terms with no conversions "
                                       f"({pct:.0f}% of search-term spend) — candidates for negative keywords."})
        if total_trend:
            last = total_trend[-1]
            findings.append({"topic": f"Latest month ({meta_periods.get('current','')})",
                             "detail": f"${last['Spend']:,.0f} spend, {last['Main Conv']:.0f} conversions "
                                       f"at ${last['CPA']:,.2f} CPA."})

        # ---- complexity profile (forward-looking; not yet consumed by the frontend) ----
        n_brands = 1
        has_pmax = bool(c.execute(text(
            "SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements'"), {"c": client_id}).scalar())

    return {
        "meta": {
            "client_id": client_id,
            "name": _client_name(engine, client_id),
            "periods": meta_periods,
            "complexity": {"n_brands": n_brands, "has_pmax": has_pmax},
            "generated_from": "warehouse",
        },
        "total_trend": total_trend,
        "kpis": kpis,
        "findings": findings,
    }
