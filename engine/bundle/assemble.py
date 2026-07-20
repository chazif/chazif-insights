#!/usr/bin/env python3
"""Assemble a client's DATA bundle from the raw warehouse (Phase 2, increment 1).

Produces the keys the core views (Overview, Monthly Trends) consume, computed from
real ingested data. The analyzers (density, n-gram waste, QS, three-bucket, PMax)
and the full view set land in later increments; this proves the raw -> bundle ->
dashboard seam for a real client.
"""
import calendar
import re
from collections import defaultdict
from sqlalchemy import text, select, func
from ..ingest.store import get_engine, clients, uploads
from ..ingest.service import get_config
from ..ingest.parser import GEO_SLUGS
from ..analyze.analyzers import run_analyzers, _asdict, _num

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


def _ym_bound(s):
    """'2026-06' or '2026-06-15' -> (2026, 6); None if empty/unparseable."""
    m = re.match(r"(\d{4})-(\d{2})", str(s or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


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
            # the data the recommendation is based on (shown by the "See data" button)
            "evidence": {
                "severity": f["severity"],
                "module": MOD_CATEGORY.get(f["module"], f["module"]),
                "observation": f["observation"],
                "magnitude": f["magnitude"],
                "impact": f["impact"],
                "timing": f["timing"],
                "data": f.get("data"),
            },
        })
    return recs


def _prior_month(cm):
    pm, py = cm["month"] - 1, cm["year"]
    if pm == 0:
        pm, py = 12, py - 1
    return {"full": f"{FULL_MONTHS[pm-1]} {py}", "abbr": f"{MABBR[pm-1]} {py}"}


def _yoy_prior(cm):
    """Same month, prior year — the YoY comparison period."""
    py = cm["year"] - 1
    return {"year": py, "month": cm["month"],
            "full": f"{FULL_MONTHS[cm['month']-1]} {py}", "abbr": f"{MABBR[cm['month']-1]} {py}"}


def _campaigns(engine, client_id, cm):
    """Per-campaign snapshot for the latest complete month + month-over-month deltas."""
    prior = _prior_month(cm)

    def month_map(label):
        out = {}
        with engine.connect() as c:
            for camp, clicks, cost, conv, row in c.execute(text(
                "SELECT campaign, clicks, cost, conversions, row FROM raw_rows "
                "WHERE client_id=:c AND report_type='campaign_performance' AND date=:d"),
                {"c": client_id, "d": label}):
                out[camp] = {"clicks": _num(clicks), "cost": _num(cost), "conv": _num(conv),
                             "type": _asdict(row).get("campaign_type", "")}
        return out

    cur, pri = month_map(cm["full"]), month_map(prior["full"])
    total_cost = sum(v["cost"] for v in cur.values())
    rows = []
    for camp, d in sorted(cur.items(), key=lambda kv: -kv[1]["cost"]):
        pconv = pri.get(camp, {}).get("conv")
        dconv = ((d["conv"] - pconv) / pconv) if pconv else None
        rows.append({
            "campaign": (camp or "").split("|")[-1].strip() or camp,
            "type": d["type"], "clicks": round(d["clicks"]), "cost": round(d["cost"], 2),
            "conv": round(d["conv"], 1),
            "cpa": round(d["cost"] / d["conv"], 2) if d["conv"] else 0,
            "cvr": round(d["conv"] / d["clicks"], 4) if d["clicks"] else 0,
            "share": round(d["cost"] / total_cost, 4) if total_cost else 0,
            "prior_conv": round(pconv, 1) if pconv is not None else None,
            "d_conv": round(dconv, 4) if dconv is not None else None,
        })
    return {"month": cm["abbr"], "prior_month": prior["abbr"], "rows": rows,
            "totals": {"clicks": round(sum(v["clicks"] for v in cur.values())),
                       "cost": round(total_cost, 2),
                       "conv": round(sum(v["conv"] for v in cur.values()), 1)}}


def _geo(engine, client_id):
    """Performance by geographic location (whatever grain the export carries — State
    for most single-market accounts). Cost derived from Cost/conv since the Geographic
    export has no Cost column. Returns None if no geo data."""
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, impressions, conversions, conv_value, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='geographic'"), {"c": client_id}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0.0])  # clicks, impr, conv, conv_value, cost
    for ent, clicks, impr, conv, cval, row in rows:
        loc = ent or "(not set)"
        d = agg[loc]
        cv = _num(conv)
        d[0] += _num(clicks); d[1] += _num(impr); d[2] += cv; d[3] += _num(cval)
        cpc = _num(_asdict(row).get("cost_conv"))     # Cost / conv.
        d[4] += cpc * cv if cpc else 0.0
    out = []
    for loc, (cl, im, cv, cval, cost) in sorted(agg.items(), key=lambda kv: -kv[1][4] or -kv[1][0]):
        out.append({"location": loc, "clicks": round(cl), "impr": round(im),
                    "conv": round(cv, 1), "conv_value": round(cval, 2), "cost": round(cost, 2),
                    "cpa": round(cost / cv, 2) if cv else 0,
                    "cvr": round(cv / cl, 4) if cl else 0,
                    "ctr": round(cl / im, 4) if im else 0})
    tot = [sum(x) for x in zip(*[[r["clicks"], r["impr"], r["conv"], r["conv_value"], r["cost"]] for r in out])]
    return {"dimension": "State", "rows": out[:60],
            "totals": {"clicks": round(tot[0]), "impr": round(tot[1]), "conv": round(tot[2], 1),
                       "conv_value": round(tot[3], 2), "cost": round(tot[4], 2)}}


def _budget(engine, client_id, cm, config):
    """Monthly spend vs a configured monthly budget. Intra-month (daily) pacing needs
    day-segmented exports; this reports monthly adherence and latest-month variance."""
    budget = (config.get("thresholds") or {}).get("monthly_budget")
    budget = float(budget) if budget else None
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT date, SUM(cost) FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance' AND date IS NOT NULL GROUP BY date"),
            {"c": client_id}).all()
    series = []
    for date, cost in rows:
        mk = _month_key(date)
        if mk:
            series.append((mk, _num(cost)))
    series.sort(key=lambda x: (x[0][0], x[0][1]))
    series = [s for s in series if (s[0][0], s[0][1]) <= (cm["year"], cm["month"])]
    months = [{
        "month": mk[3], "spend": round(cost, 2),
        "budget": round(budget, 2) if budget else None,
        "variance": round(cost - budget, 2) if budget else None,
        "pct": round(cost / budget, 4) if budget else None,
    } for (mk, cost) in series[-12:]]
    latest = months[-1] if months else None
    status = None
    if latest and budget:
        p = latest["pct"]
        status = "over" if p > 1.05 else "under" if p < 0.9 else "on-track"
    return {"monthly_budget": round(budget, 2) if budget else None,
            "months": months, "latest": latest, "status": status}


QS_BUCKETS = [("Poor (1-3)", 1, 3, "#dc2626"), ("Below Average (4-5)", 4, 5, "#f59e0b"),
              ("Average (6-7)", 6, 7, "#9CA3AF"), ("Strong (8-10)", 8, 10, "#2F7D4F")]

QS_RATINGS = ["Above average", "Average", "Below average"]
QS_COMPONENTS = [("exp_ctr", "Expected Click-Through Rate", "Expected CTR"),
                 ("ad_relevance", "Ad Relevance", "Ad Relevance"),
                 ("landing_page_exp", "Landing Page Experience", "LP Experience")]


def _norm_rating(v):
    s = (v or "").strip().lower()
    if "above" in s:
        return "Above average"
    if "below" in s:
        return "Below average"
    if "average" in s:
        return "Average"
    return None


def _quality_score(engine, client_id, cm=None, config=None):
    """Non-brand Quality Score overview from the Search Keyword + QS report: per-QS
    (1-10) keyword/spend/click/conv rollups with CPC/CTR/CVR/CPA, four QS buckets, a
    weak→strong CPC-differential savings estimate, and portfolio totals."""
    config = config or {}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, impressions, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_keyword_qs'"), {"c": client_id}).all()
    if not rows:
        return None
    per = {i: {"keywords": 0, "cost": 0.0, "clicks": 0.0, "impr": 0.0, "conv": 0.0} for i in range(1, 11)}
    for cost, clicks, impr, conv, row in rows:
        d = _asdict(row)
        try:
            q = int(float(d.get("quality_score")))
        except (TypeError, ValueError):
            continue
        if not (1 <= q <= 10):
            continue
        kw = (d.get("search_keyword", "") or "").lower()
        camp = (d.get("campaign", "") or "").lower()
        if brand_terms and (any(b in kw for b in brand_terms) or any(b in camp for b in brand_terms)):
            continue                               # non-brand portfolio only
        p = per[q]
        p["keywords"] += 1; p["cost"] += _num(cost); p["clicks"] += _num(clicks)
        p["impr"] += _num(impr); p["conv"] += _num(conv)

    total_kw = sum(p["keywords"] for p in per.values())
    if not total_kw:
        return None
    total_cost = sum(p["cost"] for p in per.values())
    total_clicks = sum(p["clicks"] for p in per.values())
    total_impr = sum(p["impr"] for p in per.values())
    total_conv = sum(p["conv"] for p in per.values())

    def rates(cost, clicks, impr, conv):
        return {"cpc": round(cost / clicks, 2) if clicks else 0,
                "ctr": round(clicks / impr, 4) if impr else 0,
                "conv_rate": round(conv / clicks, 4) if clicks else 0,
                "cpa": round(cost / conv, 2) if conv else 0}

    def block(lo, hi):
        cost = sum(per[i]["cost"] for i in range(lo, hi + 1))
        clicks = sum(per[i]["clicks"] for i in range(lo, hi + 1))
        impr = sum(per[i]["impr"] for i in range(lo, hi + 1))
        conv = sum(per[i]["conv"] for i in range(lo, hi + 1))
        kws = sum(per[i]["keywords"] for i in range(lo, hi + 1))
        return {"keywords": kws, "kw_share": round(kws / total_kw, 4),
                "cost": round(cost, 2), "spend_share": round(cost / total_cost, 4) if total_cost else 0,
                "clicks": round(clicks), "conv": round(conv, 1), **rates(cost, clicks, impr, conv)}

    per_qs = [dict(qs=i, **block(i, i)) for i in range(1, 11)]
    buckets = [{"label": lbl, "lo": lo, "hi": hi, "color": col, **block(lo, hi)} for (lbl, lo, hi, col) in QS_BUCKETS]

    avg_qs = round(sum(i * per[i]["keywords"] for i in range(1, 11)) / total_kw, 1)
    weak_kw = sum(per[i]["keywords"] for i in range(1, 6))
    strong_kw = sum(per[i]["keywords"] for i in range(7, 11))
    weak_cost = sum(per[i]["cost"] for i in range(1, 6))
    weak_clicks = sum(per[i]["clicks"] for i in range(1, 6))
    cpc_weak = weak_cost / weak_clicks if weak_clicks else 0
    cpc_q7 = per[7]["cost"] / per[7]["clicks"] if per[7]["clicks"] else 0
    savings = round(weak_clicks * max(0.0, cpc_weak - cpc_q7), 2)

    return {
        "month": cm["abbr"] if cm else "",
        "non_brand": bool(brand_terms),
        "avg_qs": avg_qs, "total_keywords": total_kw,
        "pct_weak": round(weak_kw / total_kw, 4), "pct_strong": round(strong_kw / total_kw, 4),
        "savings": {"amount": savings, "cpc_weak": round(cpc_weak, 2), "cpc_qs7": round(cpc_q7, 2)},
        "per_qs": per_qs, "buckets": buckets,
        "totals": {"keywords": total_kw, "cost": round(total_cost, 2), "clicks": round(total_clicks),
                   "conv": round(total_conv, 1), **rates(total_cost, total_clicks, total_impr, total_conv)},
    }


def _qs_breakdown(engine, client_id, cm, config):
    """QS Breakdown: per-component (eCTR / Ad Relevance / LP Experience) rating rollups,
    the 27-way eCTR×LP×AdRel combination grid (avg CPC / spend / avg QS per cell), a
    weak→QS7 savings estimate by brand, and the top QS≤6 optimization keywords. Non-brand."""
    config = config or {}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    brand_label = (config.get("brand_terms") or [None])[0] or _client_name(engine, client_id)
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}

    def categorize(kw):
        n = kw.lower()
        for cat, kws in catkw.items():
            if cat.lower() in n or any(w in n for w in kws):
                return cat[:1].upper() + cat[1:]
        return None

    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, impressions, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_keyword_qs'"), {"c": client_id}).all()
    if not rows:
        return None

    # optional keyword -> dominant region, from a region-segmented keyword export
    kw_region = {}
    with engine.connect() as c:
        geo = c.execute(text("SELECT row, cost FROM raw_rows WHERE client_id=:c "
                             "AND report_type='keyword_geo'"), {"c": client_id}).all()
    if geo:
        tmp = defaultdict(lambda: defaultdict(float))
        for grow, gcost in geo:
            d = _asdict(grow); kw = (d.get("search_keyword") or "").lower(); rg = _region_value(d)
            if kw and rg:
                tmp[kw][rg] += _num(gcost)
        kw_region = {kw: max(rr.items(), key=lambda kv: kv[1])[0] for kw, rr in tmp.items()}

    comp_agg = {ck: {r: [0, 0.0, 0.0, 0.0, 0.0] for r in QS_RATINGS} for ck, _, _ in QS_COMPONENTS}
    grid = defaultdict(lambda: [0.0, 0.0, 0, 0.0])   # (ectr,lp,adrel) -> cost, clicks, kws, qs_sum
    tot = [0, 0.0, 0.0, 0.0, 0.0]                     # kws, cost, clicks, impr, conv
    weak = [0, 0.0, 0.0]                              # kws, cost, clicks at QS<=5
    q7 = [0.0, 0.0]                                   # cost, clicks at QS7
    below = {ck: 0 for ck, _, _ in QS_COMPONENTS}     # below-average count among weak keywords
    kept = []

    for cost, clicks, impr, conv, row in rows:
        d = _asdict(row)
        try:
            q = int(float(d.get("quality_score")))
        except (TypeError, ValueError):
            q = None
        kw = d.get("search_keyword", "") or ""
        kwl = kw.lower(); camp = (d.get("campaign", "") or "").lower()
        if brand_terms and (any(b in kwl for b in brand_terms) or any(b in camp for b in brand_terms)):
            continue
        cost = _num(cost); clicks = _num(clicks); impr = _num(impr); conv = _num(conv)
        ectr = _norm_rating(d.get("exp_ctr")); adrel = _norm_rating(d.get("ad_relevance"))
        lpexp = _norm_rating(d.get("landing_page_exp"))
        tot[0] += 1; tot[1] += cost; tot[2] += clicks; tot[3] += impr; tot[4] += conv
        for ck, _, _ in QS_COMPONENTS:
            rr = _norm_rating(d.get(ck))
            if rr:
                a = comp_agg[ck][rr]; a[0] += 1; a[1] += cost; a[2] += clicks; a[3] += impr; a[4] += conv
        if ectr and lpexp and adrel and q:
            g = grid[(ectr, lpexp, adrel)]; g[0] += cost; g[1] += clicks; g[2] += 1; g[3] += q
        if q is not None and q <= 5:
            weak[0] += 1; weak[1] += cost; weak[2] += clicks
            for ck, _, _ in QS_COMPONENTS:
                if _norm_rating(d.get(ck)) == "Below average":
                    below[ck] += 1
        if q == 7:
            q7[0] += cost; q7[1] += clicks
        if q is not None and q <= 6:
            kept.append({"keyword": kw, "brand": brand_label, "region": kw_region.get(kwl, "—"),
                         "category": categorize(kw) or "—", "qs": q, "spend": cost, "clicks": clicks,
                         "cpc": round(cost / clicks, 2) if clicks else 0,
                         "ectr": ectr or "—", "ad_rel": adrel or "—", "lp_exp": lpexp or "—", "conv": conv})
    if not tot[0]:
        return None
    total_cost, total_clicks = tot[1], tot[2]
    avg_cpc = total_cost / total_clicks if total_clicks else 0

    def rates(kws, cost, clicks, impr, conv, denom):
        return {"keywords": kws, "kw_share": round(kws / denom, 4) if denom else 0, "spend": round(cost, 2),
                "cpc": round(cost / clicks, 2) if clicks else 0, "ctr": round(clicks / impr, 4) if impr else 0,
                "conv_rate": round(conv / clicks, 4) if clicks else 0, "cpa": round(cost / conv, 2) if conv else 0,
                "conv": round(conv, 1),
                "cpc_vs_avg": round(((cost / clicks) - avg_cpc) / avg_cpc, 4) if clicks and avg_cpc else None}
    components = []
    for i, (ck, lbl, _) in enumerate(QS_COMPONENTS, 1):
        denom = sum(comp_agg[ck][r][0] for r in QS_RATINGS)   # % of KWs sums to 100% within a component
        components.append({"key": ck, "label": lbl, "num": i,
                           "ratings": [dict(rating=r, **rates(*comp_agg[ck][r], denom)) for r in QS_RATINGS]})

    ectr_spend = {r: 0.0 for r in QS_RATINGS}
    for (ectr, _lp, _ad), (cost, _cl, _k, _q) in grid.items():
        ectr_spend[ectr] += cost
    grid_cells = []
    for ectr in QS_RATINGS:
        for lpexp in QS_RATINGS:
            for adrel in QS_RATINGS:
                g = grid.get((ectr, lpexp, adrel))
                if g and g[2]:
                    grid_cells.append({"ectr": ectr, "lp_exp": lpexp, "ad_rel": adrel,
                                       "cpc": round(g[0] / g[1], 2) if g[1] else 0, "spend": round(g[0], 2),
                                       "qs": round(g[3] / g[2], 1), "keywords": g[2]})
                else:
                    grid_cells.append({"ectr": ectr, "lp_exp": lpexp, "ad_rel": adrel,
                                       "cpc": 0, "spend": 0, "qs": 0, "keywords": 0})

    cpc_cur = weak[1] / weak[2] if weak[2] else 0
    cpc_tgt = q7[0] / q7[1] if q7[1] else 0
    savings = round(weak[2] * max(0.0, cpc_cur - cpc_tgt), 2)
    gap = None
    if weak[0] and any(below.values()):
        gk = max(below, key=below.get)
        short = {c[0]: c[2] for c in QS_COMPONENTS}[gk]
        gap = f"{short} ({round(below[gk] / weak[0] * 100)}% below avg)"
    savings_rows = [{"brand": brand_label, "kws_weak": weak[0], "spend_weak": round(weak[1], 2),
                     "cpc_current": round(cpc_cur, 2), "cpc_target": round(cpc_tgt, 2), "savings": savings,
                     "pct_brand_spend": round(savings / total_cost, 4) if total_cost else 0, "primary_gap": gap or "—"}]

    kept.sort(key=lambda r: -r["spend"])
    opt_rows = [dict(r, spend=round(r["spend"], 2), clicks=round(r["clicks"]), conv=round(r["conv"], 1))
                for r in kept[:100]]
    cats = sorted({r["category"] for r in kept if r["category"] != "—"})
    regs = sorted({r["region"] for r in kept if r["region"] != "—"})
    return {
        "month": cm["abbr"] if cm else "", "non_brand": bool(brand_terms), "avg_cpc": round(avg_cpc, 2),
        "components": components, "grid": grid_cells,
        "grid_meta": {"ectr_spend_share": {r: round(ectr_spend[r] / total_cost, 4) if total_cost else 0 for r in QS_RATINGS}},
        "savings_by_brand": savings_rows,
        "opt_keywords": {"total": len(kept), "shown": len(opt_rows), "categories": cats,
                         "regions": regs, "has_region": bool(regs), "rows": opt_rows},
    }


def _region_category(engine, client_id, config):
    """Region & Category — for each Brand×Region×Category slice, avg CPC split by the
    keyword's component rating (Below / Average / Above) per QS component, with the
    Below−Above CPC spread. Joins the region-segmented keyword export (region + spend)
    to search_keyword_qs (component ratings). None if the segmented export is absent."""
    with engine.connect() as c:
        geo = c.execute(text("SELECT clicks, cost, row FROM raw_rows WHERE client_id=:c "
                             "AND report_type='keyword_geo'"), {"c": client_id}).all()
    if not geo:
        return None
    with engine.connect() as c:
        kqs = c.execute(text("SELECT row FROM raw_rows WHERE client_id=:c "
                             "AND report_type='search_keyword_qs'"), {"c": client_id}).all()
    kw_ratings = {}
    for (row,) in kqs:
        d = _asdict(row); kw = (d.get("search_keyword") or "").lower()
        if kw:
            kw_ratings[kw] = {ck: _norm_rating(d.get(ck)) for ck, _, _ in QS_COMPONENTS}
    if not kw_ratings:
        return None

    config = config or {}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    brand_label = (config.get("brand_terms") or [None])[0] or _client_name(engine, client_id)
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}

    def categorize(kw):
        n = kw.lower()
        for cat, kws in catkw.items():
            if cat.lower() in n or any(w in n for w in kws):
                return cat[:1].upper() + cat[1:]
        return "Uncategorized"

    slices = {}
    for clicks, cost, row in geo:
        d = _asdict(row); kw = d.get("search_keyword"); region = _region_value(d)
        if not kw or not region:
            continue
        kwl = kw.lower()
        if brand_terms and any(b in kwl for b in brand_terms):
            continue                                  # non-brand only
        cost = _num(cost); clicks = _num(clicks)
        key = (brand_label, region, categorize(kw))
        s = slices.get(key)
        if s is None:
            s = slices[key] = {"total": 0.0, "comp": {ck: {r: [0.0, 0.0] for r in QS_RATINGS}
                                                      for ck, _, _ in QS_COMPONENTS}}
        s["total"] += cost
        rr = kw_ratings.get(kwl)
        if rr:
            for ck, _, _ in QS_COMPONENTS:
                rating = rr.get(ck)
                if rating:
                    b = s["comp"][ck][rating]; b[0] += cost; b[1] += clicks
    if not slices:
        return None

    def cpc(b):
        return round(b[0] / b[1], 2) if b[1] else None
    components = []
    for ck, label, _ in QS_COMPONENTS:
        rows = []
        for (brand, region, cat), s in slices.items():
            bk = s["comp"][ck]
            below, avg, above = bk["Below average"], bk["Average"], bk["Above average"]
            bcpc, acpc, abcpc = cpc(below), cpc(avg), cpc(above)
            spread = round(bcpc - abcpc, 2) if (bcpc is not None and abcpc is not None) else None
            rows.append({"brand": brand, "region": region, "category": cat,
                         "total_spend": round(s["total"], 2),
                         "below_cpc": bcpc, "below_clicks": round(below[1]),
                         "avg_cpc": acpc, "avg_clicks": round(avg[1]),
                         "above_cpc": abcpc, "above_clicks": round(above[1]), "spread": spread})
        rows.sort(key=lambda r: -r["total_spend"])
        components.append({"key": ck, "label": label, "total": len(rows), "rows": rows[:100]})
    cats = sorted({r["category"] for comp in components for r in comp["rows"] if r["category"] != "Uncategorized"})
    regs = sorted({r["region"] for comp in components for r in comp["rows"]})
    return {"components": components, "categories": cats, "regions": regs}


def _search_terms(engine, client_id, config):
    """Top zero-conversion (waste) and top converting terms, with LLM/heuristic
    relevance on the top waste terms to separate confirmed-irrelevant waste (negate)
    from relevant-but-not-converting terms (fix quality, don't negate)."""
    from ..llm.relevance import get_or_classify
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_terms'"), {"c": client_id}).all()
    if not rows:
        return None
    waste, conv = [], []
    for term, clicks, cost, conversions, row in rows:
        cost = _num(cost); clicks = _num(clicks); cv = _num(conversions)
        mt = _asdict(row).get("search_terms_match_type", "")
        if cost > 0 and cv <= 0:
            waste.append((term, mt, clicks, cost))
        elif cv > 0:
            conv.append((term, clicks, cost, cv))
    waste.sort(key=lambda x: -x[3]); conv.sort(key=lambda x: -x[3])

    context = {"product_categories": config.get("product_categories", []),
               "brand_terms": config.get("brand_terms", []),
               "competitors_conquest": config.get("competitors_conquest", [])}
    classified = get_or_classify(engine, client_id, [t for (t, m, cl, co) in waste[:40]], context)
    irrelevant = round(sum(co for (t, m, cl, co) in waste[:40] if t in classified and not classified[t]["relevant"]), 2)
    relevant = round(sum(co for (t, m, cl, co) in waste[:40] if t in classified and classified[t]["relevant"]), 2)
    src = next((v["source"] for v in classified.values()), "none")

    def wrow(t, m, cl, co):
        r = classified.get(t)
        return {"term": t, "match": m, "clicks": round(cl), "cost": round(co, 2),
                "relevant": r["relevant"] if r else None, "category": r["category"] if r else None}
    return {
        "total_terms": len(rows),
        "waste_total": round(sum(x[3] for x in waste), 2),
        "relevance": {"classified": len(classified), "source": src,
                      "irrelevant_waste": irrelevant, "relevant_waste": relevant},
        "top_waste": [wrow(t, m, cl, co) for (t, m, cl, co) in waste[:20]],
        "top_converting": [{"term": t, "clicks": round(cl), "cost": round(co, 2), "conv": round(cv, 1),
                            "cpa": round(co / cv, 2) if cv else 0} for (t, cl, co, cv) in conv[:20]],
    }


ST_GRADES = ["A — Top Performer", "B — Good", "C — Average", "D — Below Average",
             "F — Poor / No Conversions", "Low Volume"]

# Ad Copy grades ads by CTR on separate branded / non-branded scales.
AD_TH_NB = [(0.10, "A — Top Performer"), (0.06, "B — Good"), (0.04, "C — Average"), (0.02, "D — Below Average")]
AD_TH_BR = [(0.30, "A — Top Performer"), (0.20, "B — Good"), (0.10, "C — Average"), (0.05, "D — Below Average")]
AD_THRESH_TEXT = {
    "nonbranded": "CTR thresholds (Non-Branded): A ≥ 10%, B 6–10%, C 4–6%, D 2–4%, F < 2% with ≥ 100 impressions. Low Volume = < 100 impressions.",
    "branded": "CTR thresholds (Branded): A ≥ 30%, B 20–30%, C 10–20%, D 5–10%, F < 5% with ≥ 100 impressions. Low Volume = < 100 impressions.",
}


def _grade_ad(ctr, impr, branded):
    if impr < 100:
        return "Low Volume"
    for mn, g in (AD_TH_BR if branded else AD_TH_NB):
        if ctr >= mn:
            return g
    return "F — Poor / No Conversions"


def _grade_lp(cvr, impr, clicks):
    """Landing-page grade from the ad's CVR (ad-level conversion as an LP proxy)."""
    if impr < 100 or clicks < 5:
        return "Low Volume"
    if cvr >= 0.40:
        return "A — Top Performer"
    if cvr >= 0.25:
        return "B — Good"
    if cvr >= 0.15:
        return "C — Average"
    if cvr >= 0.05:
        return "D — Below Average"
    return "F — Poor / No Conversions"
ST_GRADE_METHOD = [
    ("A — Top Performer", "≥ 40%", "Converts exceptionally well. Protect and scale."),
    ("B — Good", "25–40%", "Solid performer — worth investing in."),
    ("C — Average", "15–25%", "Performing at an acceptable level."),
    ("D — Below Average", "5–15%", "Converting but below expectations — review keyword, ad, and LP alignment."),
    ("F — Poor / No Conversions", "< 5% (w/ 5+ clicks)", "Traffic is not converting — investigate match quality, ad relevance, and landing page."),
    ("Low Volume", "< 5 clicks", "Insufficient data to grade reliably."),
]


def _grade_term(t):
    """Grade a non-brand search term by conversion rate (reference thresholds)."""
    if t["clicks"] < 5:
        return "Low Volume"
    cvr = t["conv"] / t["clicks"] if t["clicks"] else 0
    if cvr >= 0.40:
        return "A — Top Performer"
    if cvr >= 0.25:
        return "B — Good"
    if cvr >= 0.15:
        return "C — Average"
    if cvr >= 0.05:
        return "D — Below Average"
    return "F — Poor / No Conversions"


def _keyword_section(engine, client_id):
    """Keyword Deep Dive (top keywords) + QS component breakdown (eCTR / Ad relevance /
    LP experience) with a modeled CPC-penalty savings estimate."""
    from collections import Counter
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_keyword_qs'"), {"c": client_id}).all()
    if not rows:
        return None
    kws = []
    comp = {"exp_ctr": Counter(), "ad_relevance": Counter(), "landing_page_exp": Counter()}
    comp_sp = {"exp_ctr": Counter(), "ad_relevance": Counter(), "landing_page_exp": Counter()}
    below_ctr = 0.0
    for cost, clicks, conv, row in rows:
        d = _asdict(row); cost = _num(cost); clicks = _num(clicks); cv = _num(conv)
        kws.append({"keyword": d.get("search_keyword", ""), "match": d.get("search_keyword_match_type", ""),
                    "qs": d.get("quality_score"), "clicks": clicks, "cost": cost, "conv": cv})
        for key in comp:
            val = (d.get(key) or "").strip() or "—"
            comp[key][val] += 1; comp_sp[key][val] += cost
        if (d.get("exp_ctr") or "").lower() == "below average":
            below_ctr += cost

    dd = sorted(kws, key=lambda x: -x["cost"])[:40]
    deep_dive = [{"keyword": k["keyword"], "match": k["match"], "qs": k["qs"],
                  "clicks": round(k["clicks"]), "cost": round(k["cost"], 2), "conv": round(k["conv"], 1),
                  "cpa": round(k["cost"] / k["conv"], 2) if k["conv"] else 0} for k in dd]

    def comp_rows(key):
        order = ["Above average", "Average", "Below average", "—"]
        return [{"rating": r, "keywords": comp[key][r], "cost": round(comp_sp[key][r], 2)}
                for r in order if r in comp[key]]
    return {
        "deep_dive": deep_dive,
        "components": {"Expected CTR": comp_rows("exp_ctr"),
                       "Ad relevance": comp_rows("ad_relevance"),
                       "Landing page exp.": comp_rows("landing_page_exp")},
        "below_ctr_spend": round(below_ctr, 2),
        "savings_estimate": round(below_ctr * 0.33, 2),
    }


def _region_value(d):
    """First populated geographic column in a row (a keyword-geo export may name it
    state_matched / region / metro / city depending on how it was segmented)."""
    for k in GEO_SLUGS:
        v = d.get(k)
        if v:
            return v
    return None


def _keyword_regions(engine, client_id, config):
    """Keyword × region pivot for the Keyword Deep Dive heatmap, from a keyword report
    segmented by geography (report_type 'keyword_geo'). None if that segmented export
    hasn't been uploaded — the view then falls back to the flat keyword table."""
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='keyword_geo'"), {"c": client_id}).all()
    if not rows:
        return None
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    catkw = {cat: [w for w in re.findall(r"[a-z]+", cat.lower()) if len(w) >= 4]
             for cat in (config.get("product_categories") or [])}
    brand_label = (config.get("brand_terms") or [None])[0] or _client_name(engine, client_id)

    def categorize(kw):
        n = kw.lower()
        for cat, kws in catkw.items():
            if cat.lower() in n or any(w in n for w in kws):
                return cat[:1].upper() + cat[1:]
        return None

    kw_map = {}                                    # keyword -> record
    region_tot = defaultdict(lambda: [0.0, 0.0])   # region -> spend, conv
    for cost, clicks, conv, row in rows:
        d = _asdict(row)
        kw = d.get("search_keyword")
        region = _region_value(d)
        if not kw or not region:
            continue
        cost = _num(cost); cv = _num(conv)
        rec = kw_map.get(kw)
        if rec is None:
            rec = kw_map[kw] = {"match": d.get("search_keyword_match_type", ""),
                                "branded": bool(brand_terms and any(bt in kw.lower() for bt in brand_terms)),
                                "category": categorize(kw), "overall": [0.0, 0.0], "cells": {}}
        rec["overall"][0] += cost; rec["overall"][1] += cv
        cell = rec["cells"].setdefault(region, [0.0, 0.0])
        cell[0] += cost; cell[1] += cv
        region_tot[region][0] += cost; region_tot[region][1] += cv
    if not kw_map:
        return None

    regions_sorted = sorted(region_tot.items(), key=lambda kv: -kv[1][0])[:25]
    region_names = [r for r, _ in regions_sorted]
    regions = [{"name": r, "spend": round(v[0], 2), "conv": round(v[1], 1)} for r, v in regions_sorted]

    def top_keep(items):                           # top 100 by spend ∪ top 100 by conv
        keep = {}
        for k, v in sorted(items, key=lambda kv: -kv[1]["overall"][0])[:100]:
            keep[k] = v
        for k, v in sorted(items, key=lambda kv: -kv[1]["overall"][1])[:100]:
            keep[k] = v
        return keep
    keep = {}
    keep.update(top_keep([(k, v) for k, v in kw_map.items() if v["branded"]]))
    keep.update(top_keep([(k, v) for k, v in kw_map.items() if not v["branded"]]))

    keywords = []
    for kw, rec in keep.items():
        cells = {r: {"spend": round(rec["cells"][r][0], 2), "conv": round(rec["cells"][r][1], 1)}
                 for r in region_names if r in rec["cells"]}
        keywords.append({"keyword": kw, "match": rec["match"], "category": rec["category"],
                         "brand": brand_label, "branded": rec["branded"],
                         "overall": {"spend": round(rec["overall"][0], 2), "conv": round(rec["overall"][1], 1)},
                         "cells": cells})

    def tot(pred):
        items = [rec for rec in kw_map.values() if pred(rec)]
        return {"keywords": len(items),
                "spend": round(sum(r["overall"][0] for r in items), 2),
                "conv": round(sum(r["overall"][1] for r in items), 1)}
    return {"brand": brand_label, "regions": regions, "keywords": keywords,
            "totals": {"branded": tot(lambda r: r["branded"]),
                       "nonbranded": tot(lambda r: not r["branded"]),
                       "regions": len(region_tot)}}


def _ads_section(engine, client_id, config=None):
    """RSA inventory + CTR-graded ad performance (Ad Copy) and ad → landing-page pairing."""
    from collections import Counter
    config = config or {}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    brand_label = (config.get("brand_terms") or [None])[0] or _client_name(engine, client_id)
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}

    def categorize(txt):
        n = (txt or "").lower()
        for c, kws in catkw.items():
            if c.lower() in n or any(w in n for w in kws):
                return c[:1].upper() + c[1:]
        return "Uncategorized"

    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT clicks, impressions, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='ads_performance'"), {"c": client_id}).all()
    if not rows:
        return None
    ads = []
    for clicks, impr, cost, conv, row in rows:
        d = _asdict(row)
        hn = sum(1 for i in range(1, 16) if (d.get(f"headline_{i}") or "").strip())
        dn = sum(1 for i in range(1, 6) if (d.get(f"description_{i}") or "").strip())
        clicks, impr, cost, cv = _num(clicks), _num(impr), _num(cost), _num(conv)
        if impr <= 0 and cost <= 0:
            continue
        camp = d.get("campaign", ""); ag = d.get("ad_group", "")
        headline = " | ".join([d.get(f"headline_{i}") for i in range(1, 4) if (d.get(f"headline_{i}") or "").strip()]) \
            or d.get("headline") or d.get("long_headline") or ""
        branded = bool(brand_terms and any(b in (camp + " " + ag).lower() for b in brand_terms))
        ctr = clicks / impr if impr else 0
        ads.append({"campaign": camp, "ad_group": ag, "type": d.get("ad_type", ""),
                    "final_url": d.get("ad_final_url") or d.get("final_url") or "",
                    "headlines": hn, "descriptions": dn, "headline": headline,
                    "brand": brand_label, "branded": branded, "region": "—",
                    "category": categorize(ag + " " + headline),
                    "clicks": round(clicks), "impr": round(impr), "cost": round(cost, 2), "conv": round(cv, 1),
                    "ctr": round(ctr, 4), "cpc": round(cost / clicks, 2) if clicks else 0,
                    "cvr": round(cv / clicks, 4) if clicks else 0,
                    "grade": _grade_ad(ctr, impr, branded),
                    "lp_grade": _grade_lp(cv / clicks if clicks else 0, impr, clicks)})
    if not ads:
        return None
    ads.sort(key=lambda x: -x["cost"])

    def group_data(subset):
        gc, gi, gcl, gs, gcv = Counter(), Counter(), Counter(), Counter(), Counter()
        for a in subset:
            g = a["grade"]; gc[g] += 1; gi[g] += a["impr"]; gcl[g] += a["clicks"]; gs[g] += a["cost"]; gcv[g] += a["conv"]
        tot = sum(a["cost"] for a in subset)
        grades = [{"grade": g, "ads": gc[g], "impr": round(gi[g]), "clicks": round(gcl[g]),
                   "ctr": round(gcl[g] / gi[g], 4) if gi[g] else 0, "spend": round(gs[g], 2),
                   "spend_share": round(gs[g] / tot, 4) if tot else 0, "conv": round(gcv[g], 0),
                   "cvr": round(gcv[g] / gcl[g], 4) if gcl[g] else 0} for g in ST_GRADES if g in gc]
        detail = [{"brand": a["brand"], "category": a["category"], "region": a["region"], "ad_group": a["ad_group"],
                   "headline": a["headline"], "grade": a["grade"], "ctr_grade": a["grade"], "lp_grade": a["lp_grade"],
                   "ctr": a["ctr"], "impr": a["impr"], "clicks": a["clicks"], "cpc": a["cpc"], "spend": a["cost"],
                   "conv": a["conv"], "cvr": a["cvr"]} for a in subset[:100]]

        # pairing grid: Ad-CTR grade (rows) × LP-CVR grade (cols)
        pg = {r: {c: [0, 0.0] for c in ST_GRADES} for r in ST_GRADES}
        for a in subset:
            cell = pg[a["grade"]][a["lp_grade"]]; cell[0] += 1; cell[1] += a["cost"]
        n = len(subset)
        grid_rows = [{"ctr_grade": r,
                      "cols": [{"cvr_grade": c, "ads": pg[r][c][0], "spend": round(pg[r][c][1], 2),
                                "pct": round(pg[r][c][0] / n, 4) if n else 0} for c in ST_GRADES],
                      "total_ads": sum(pg[r][c][0] for c in ST_GRADES),
                      "total_spend": round(sum(pg[r][c][1] for c in ST_GRADES), 2)} for r in ST_GRADES]
        col_totals = [{"cvr_grade": c, "ads": sum(pg[r][c][0] for r in ST_GRADES),
                       "spend": round(sum(pg[r][c][1] for r in ST_GRADES), 2)} for c in ST_GRADES]

        strong = lambda g: g[0] in ("A", "B")
        weak = lambda g: g[0] in ("D", "F")
        low = lambda g: g.startswith("Low")
        stats = {
            "total": n,
            "aligned": sum(1 for a in subset if strong(a["grade"]) and strong(a["lp_grade"])),
            "fix_lp": sum(1 for a in subset if strong(a["grade"]) and weak(a["lp_grade"])),
            "fix_ad": sum(1 for a in subset if weak(a["grade"]) and strong(a["lp_grade"])),
            "low_vol": sum(1 for a in subset if low(a["grade"]) or low(a["lp_grade"])),
        }
        stats["aligned_pct"] = round(stats["aligned"] / n, 4) if n else 0
        return {"count": len(subset), "grades": grades, "rows": detail,
                "categories": sorted({a["category"] for a in subset if a["category"] != "Uncategorized"}),
                "regions": sorted({a["region"] for a in subset if a["region"] != "—"}),
                "grade_labels": [g["grade"] for g in grades], "has_region": False,
                "pairing": {"grades": ST_GRADES, "rows": grid_rows, "col_totals": col_totals,
                            "grand_ads": n, "grand_spend": round(sum(a["cost"] for a in subset), 2)},
                "stats": stats}

    nb = [a for a in ads if not a["branded"]]
    br = [a for a in ads if a["branded"]]
    return {"count": len(ads), "ads": ads[:100],
            "ad_copy": {"thresholds": AD_THRESH_TEXT,
                        "nonbranded": group_data(nb) if nb else None,
                        "branded": group_data(br) if br else None}}


def _lp_categories(lps, product_categories):
    """Category grid derived from the LP URL (matched to configured product categories),
    since the LP export has no category column. None if nothing categorizes."""
    if not product_categories:
        return None
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4] for c in product_categories}
    grid = defaultdict(lambda: [0.0, 0.0, 0])
    for r in lps:
        url = (r["url"] or "").lower()
        matched = None
        for c, kws in catkw.items():
            if c.lower() in url or any(kw in url for kw in kws):
                matched = c
                break
        g = grid[matched or "Other / uncategorized"]
        g[0] += r["clicks"]; g[1] += r["cost"]; g[2] += 1
    out = [{"category": c, "landing_pages": g[2], "clicks": round(g[0]), "cost": round(g[1], 2)}
           for c, g in sorted(grid.items(), key=lambda kv: -kv[1][1])]
    return out if any(not c["category"].startswith("Other") for c in out) else None


def _nb_category_of(name, catkw, brand_terms):
    """Bucket a campaign into a non-brand category from its name, mirroring how the
    reference groups by campaign structure. Returns None for brand campaigns (excluded)."""
    n = (name or "").lower()
    if "brand defense" in n or "| brand" in n or (brand_terms and any(bt in n for bt in brand_terms)):
        return None  # brand campaign -> not "non-brand"
    for cat, kws in catkw.items():                 # product category named in the campaign
        if cat.lower() in n or any(w in n for w in kws):
            return cat[:1].upper() + cat[1:]
    if "pmax" in n or "performance max" in n:
        return "PMax"
    if "conquest" in n or "competitor" in n:
        return "Conquest"
    if "non-brand" in n or "nonbrand" in n or "non brand" in n:
        return "Non-Brand Search"
    return "Other Non-Brand"


def _nb_categories(engine, client_id, cm, config):
    """YoY non-brand spend/conversions by category, bucketed from campaign structure
    (the date-segmented source), latest complete month vs same month prior year — with a
    prior-calendar-month fallback when the account has under a year of history, matching
    the KPI logic. Brand campaigns are excluded. None if there is no non-brand data."""
    if not cm:
        return None
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]

    def month_agg(full_label):
        agg = defaultdict(lambda: [0.0, 0.0])  # spend, conv
        with engine.connect() as c:
            for camp, cost, conv in c.execute(text(
                "SELECT campaign, cost, conversions FROM raw_rows WHERE client_id=:c "
                "AND report_type='campaign_performance' AND date=:d"),
                {"c": client_id, "d": full_label}):
                cat = _nb_category_of(camp, catkw, brand_terms)
                if cat is None:
                    continue
                a = agg[cat]; a[0] += _num(cost); a[1] += _num(conv)
        return agg

    prior = _yoy_prior(cm)
    cur_agg, pri_agg = month_agg(cm["full"]), month_agg(prior["full"])
    if not cur_agg and not pri_agg:
        return None
    if not pri_agg:                                # < 1yr of history -> compare prior month
        prior = _prior_month(cm)
        pri_agg = month_agg(prior["full"])

    def chg(cur, prev):
        return round((cur - prev) / prev, 4) if prev else None

    def make(cat, cs, ccv, ps, pcv):
        ccpa = cs / ccv if ccv else 0
        pcpa = ps / pcv if pcv else 0
        return {"category": cat,
                "spend_prior": round(ps, 2), "spend_cur": round(cs, 2), "spend_chg": chg(cs, ps),
                "conv_prior": round(pcv, 1), "conv_cur": round(ccv, 1), "conv_chg": chg(ccv, pcv),
                "cpa_prior": round(pcpa, 2), "cpa_cur": round(ccpa, 2), "cpa_chg": chg(ccpa, pcpa)}

    rows = [make(cat, *cur_agg.get(cat, [0.0, 0.0]), *pri_agg.get(cat, [0.0, 0.0]))
            for cat in sorted(set(cur_agg) | set(pri_agg),
                              key=lambda k: -cur_agg.get(k, [0.0])[0])]
    tcs = sum(r["spend_cur"] for r in rows); tps = sum(r["spend_prior"] for r in rows)
    tcc = sum(r["conv_cur"] for r in rows); tpc = sum(r["conv_prior"] for r in rows)
    totals = make("Non-Brand Total", tcs, tcc, tps, tpc)
    return {"prior_label": prior["abbr"], "cur_label": cm["abbr"], "rows": rows, "totals": totals}


def _region_of(name):
    """Region token parsed from a geo-segmented campaign name, e.g.
    'Search | Non-Brand | Tier A - NYC Metro Core' -> 'NYC Metro Core'. Short tokens
    (nyc, la) are upper-cased. None when the campaign carries no region."""
    m = re.search(r"tier\s+\S+\s*[-–:|]\s*(.+)$", (name or "").lower())
    if not m:
        return None
    raw = m.group(1).strip(" -–|")
    label = " ".join(w.upper() if len(w) <= 3 else w.capitalize() for w in raw.split())
    return label or None


def _regions(engine, client_id, cm, config):
    """YoY non-brand spend/conversions by region, parsed from geo-segmented campaign
    names (mirrors the reference 'Non-Brand campaigns · YoY by region'). Returns per
    (region, category) cells so the frontend can filter by category; None if no
    region-segmented campaigns exist."""
    if not cm:
        return None
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]

    def month_cells(full_label):
        agg = defaultdict(lambda: [0.0, 0.0])  # (region, category) -> spend, conv
        with engine.connect() as c:
            for camp, cost, conv in c.execute(text(
                "SELECT campaign, cost, conversions FROM raw_rows WHERE client_id=:c "
                "AND report_type='campaign_performance' AND date=:d"),
                {"c": client_id, "d": full_label}):
                cat = _nb_category_of(camp, catkw, brand_terms)
                if cat is None:                 # brand campaign
                    continue
                region = _region_of(camp)
                if region is None:              # not region-segmented
                    continue
                a = agg[(region, cat)]; a[0] += _num(cost); a[1] += _num(conv)
        return agg

    prior = _yoy_prior(cm)
    cur_agg, pri_agg = month_cells(cm["full"]), month_cells(prior["full"])
    if not cur_agg and not pri_agg:
        return None
    if not pri_agg:
        prior = _prior_month(cm)
        pri_agg = month_cells(prior["full"])

    cats, cells = set(), []
    for key in sorted(set(cur_agg) | set(pri_agg)):
        region, cat = key
        cs, ccv = cur_agg.get(key, [0.0, 0.0])
        ps, pcv = pri_agg.get(key, [0.0, 0.0])
        cats.add(cat)
        cells.append({"region": region, "category": cat,
                      "spend_prior": round(ps, 2), "spend_cur": round(cs, 2),
                      "conv_prior": round(pcv, 1), "conv_cur": round(ccv, 1)})
    return {"prior_label": prior["abbr"], "cur_label": cm["abbr"],
            "categories": sorted(cats), "cells": cells}


def _landing_pages(engine, client_id, config):
    """Landing-page performance (clicks/cost/CTR + mobile speed) + a URL-derived category
    grid. The LP export has no conversion or device column, so no CVR / device grid."""
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, impressions, cost, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='landing_pages'"), {"c": client_id}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0, None])
    for lp, clicks, impr, cost, row in rows:
        d = agg[lp or "(unknown)"]
        d[0] += _num(clicks); d[1] += _num(impr); d[2] += _num(cost)
        if d[3] is None:
            d[3] = _asdict(row).get("mobile_speed_score")
    full = [{"url": url, "clicks": round(cl), "impr": round(im), "cost": round(co, 2),
             "ctr": round(cl / im, 4) if im else 0, "speed": sp}
            for url, (cl, im, co, sp) in sorted(agg.items(), key=lambda kv: -kv[1][2])]
    return {"count": len(full), "rows": full[:50],
            "category_grid": _lp_categories(full, config.get("product_categories", []))}


def _search_terms_section(engine, client_id, config):
    """Full Search Terms section: Intent & Grades, Relevant, Competitor, Flagged."""
    from collections import Counter
    from ..llm.relevance import get_or_classify
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_terms'"), {"c": client_id}).all()
    if not rows:
        return None
    brand_excl = [b.lower() for b in (config.get("brand_terms") or []) if b]
    terms = []
    for term, clicks, cost, conv, row in rows:
        tl = (term or "").lower()
        if brand_excl and any(b in tl for b in brand_excl):
            continue                                # non-brand analysis only
        d = _asdict(row)
        t = {"term": term or "", "match": d.get("search_terms_match_type", ""),
             "added": d.get("added_excluded"),
             "clicks": _num(clicks), "cost": _num(cost), "conv": _num(conv)}
        t["grade"] = _grade_term(t)
        terms.append(t)
    if not terms:
        return None

    top = sorted(terms, key=lambda x: -x["cost"])[:60]
    context = {"product_categories": config.get("product_categories", []),
               "brand_terms": config.get("brand_terms", []),
               "competitors_conquest": config.get("competitors_conquest", [])}
    cls = get_or_classify(engine, client_id, [t["term"] for t in top], context)
    for t in terms:
        r = cls.get(t["term"])
        t["intent"] = r["category"] if r else None
        t["relevant"] = r["relevant"] if r else None

    total_spend = round(sum(t["cost"] for t in terms), 2)

    # ---- performance grades (full metrics), by CVR band ----
    gc, gs, gcv = Counter(), Counter(), Counter()
    for t in terms:
        gc[t["grade"]] += 1; gs[t["grade"]] += t["cost"]; gcv[t["grade"]] += t["conv"]
    grades = [{"grade": g, "terms": gc[g], "spend": round(gs[g], 2),
               "spend_share": round(gs[g] / total_spend, 4) if total_spend else 0,
               "conv": round(gcv[g], 0), "cpa": round(gs[g] / gcv[g], 2) if gcv[g] else None}
              for g in ST_GRADES if g in gc]
    grade_summary = [{"grade": g["grade"], "terms": g["terms"], "cost": g["spend"]} for g in grades]

    # ---- intent segments (heuristic over ALL terms) + service categories donut ----
    comps_orig = config.get("competitors_conquest", []) + config.get("competitors_friendly", [])
    comps = [x.lower() for x in comps_orig if x]
    brand_l = [b.lower() for b in config.get("brand_terms", []) if b]
    waste_ex = [w.lower() for w in config.get("waste_exclusions", []) if w]
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}

    def category_of(term):
        tl = term.lower()
        for c, kws in catkw.items():
            if c.lower() in tl or any(w in tl for w in kws):
                return c[:1].upper() + c[1:]
        return None

    def intent_of(term):
        tl = term.lower()
        if comps and any(cx in tl for cx in comps):
            return "Competitor"
        if waste_ex and any(w in tl for w in waste_ex):
            return "Irrelevant"
        if category_of(term) or (brand_l and any(b in tl for b in brand_l)):
            return "Relevant"
        return "Needs Review"

    def status_of(t):
        ae = (t.get("added") or "").lower()
        if "exclud" in ae:
            return "Excluded"
        if "add" in ae:
            return "Already Added"
        g = t["grade"][0]
        if g in ("A", "B", "C"):
            return "Recommend to Add"
        if g == "D":
            return "Review"
        return "Unassigned"

    seg_c, seg_s = Counter(), Counter()
    svc_s = Counter(); comp_s = Counter(); comp_c = Counter(); comp_cv = Counter(); comp_cl = Counter()
    st_c, st_s = Counter(), Counter()
    for t in terms:
        seg = intent_of(t["term"]); t["seg"] = seg; seg_c[seg] += 1; seg_s[seg] += t["cost"]
        t["cat"] = category_of(t["term"])
        svc_s[t["cat"] or "Other / uncategorized"] += t["cost"]
        t["status"] = status_of(t); st_c[t["status"]] += 1; st_s[t["status"]] += t["cost"]
        tl = t["term"].lower()
        t["competitor"] = None
        for cx in comps_orig:
            if cx and cx.lower() in tl:
                t["competitor"] = cx
                comp_s[cx] += t["cost"]; comp_c[cx] += 1; comp_cv[cx] += t["conv"]; comp_cl[cx] += t["clicks"]
                break
    intent_segments = [{"name": n, "terms": seg_c[n], "spend": round(seg_s[n], 2),
                        "spend_share": round(seg_s[n] / total_spend, 4) if total_spend else 0}
                       for n in ["Relevant", "Competitor", "Needs Review", "Irrelevant"]]
    service_categories = [{"category": c, "spend": round(v, 2)}
                          for c, v in sorted(svc_s.items(), key=lambda kv: -kv[1]) if v > 0]
    competitor_breakdown = [{"segment": c, "spend": round(v, 2)}
                            for c, v in sorted(comp_s.items(), key=lambda kv: -kv[1])[:12] if v > 0]

    # competitor section — spend per matched competitor + the top competitor terms
    total_comp_spend = sum(comp_s.values())
    competitor_summary = [{"type": c, "terms": comp_c[c], "spend": round(comp_s[c], 2),
                           "spend_share": round(comp_s[c] / total_comp_spend, 4) if total_comp_spend else 0,
                           "conv": round(comp_cv[c], 0), "cpa": round(comp_s[c] / comp_cv[c], 2) if comp_cv[c] else None}
                          for c in sorted(comp_s, key=lambda k: -comp_s[k]) if comp_s[c] > 0 or comp_c[c] > 0]
    comp_matched = sorted([t for t in terms if t.get("competitor")], key=lambda x: -x["cost"])
    competitor_terms = [{"term": t["term"], "competitor": t["competitor"], "spend": round(t["cost"], 2),
                         "clicks": round(t["clicks"]), "conv": round(t["conv"], 1),
                         "cvr": round(t["conv"] / t["clicks"], 4) if t["clicks"] else 0,
                         "cpa": round(t["cost"] / t["conv"], 2) if t["conv"] else None} for t in comp_matched[:75]]

    STATUS_ORDER = ["Recommend to Add", "Already Added", "Review", "Excluded", "Unassigned"]
    keyword_status = [{"status": s, "terms": st_c[s], "spend": round(st_s[s], 2),
                       "spend_share": round(st_s[s] / total_spend, 4) if total_spend else 0}
                      for s in STATUS_ORDER]

    rel_sorted = sorted([t for t in terms if t["seg"] == "Relevant"], key=lambda x: -x["cost"])
    relevant_terms = [{"term": t["term"], "category": t["cat"] or "Uncategorized", "grade": t["grade"],
                       "status": t["status"], "spend": round(t["cost"], 2), "clicks": round(t["clicks"]),
                       "conv": round(t["conv"], 1), "cvr": round(t["conv"] / t["clicks"], 4) if t["clicks"] else 0,
                       "cpc": round(t["cost"] / t["clicks"], 2) if t["clicks"] else 0} for t in rel_sorted[:150]]
    rel_categories = sorted({r["category"] for r in relevant_terms if r["category"] != "Uncategorized"})

    flag_sorted = sorted([t for t in terms if t["seg"] == "Needs Review"], key=lambda x: -x["cost"])
    flagged_terms = [{"term": t["term"], "intent": t["seg"], "status": t["status"], "spend": round(t["cost"], 2),
                      "clicks": round(t["clicks"]), "conv": round(t["conv"], 1),
                      "cvr": round(t["conv"] / t["clicks"], 4) if t["clicks"] else 0,
                      "cpa": round(t["cost"] / t["conv"], 2) if t["conv"] else None} for t in flag_sorted[:75]]

    # legacy intent mix (top terms, LLM categories) kept for other consumers
    ic, isp = Counter(), Counter()
    for t in top:
        cat = (cls.get(t["term"]) or {}).get("category", "unclassified")
        ic[cat] += 1; isp[cat] += t["cost"]
    intent_summary = [{"intent": k, "terms": ic[k], "cost": round(isp[k], 2)} for k in sorted(ic, key=lambda x: -isp[x])]

    def trow(t):
        return {"term": t["term"], "match": t["match"], "clicks": round(t["clicks"]),
                "cost": round(t["cost"], 2), "conv": round(t["conv"], 1),
                "grade": t["grade"], "intent": t.get("intent"), "relevant": t.get("relevant")}

    relevant = [t for t in top if (cls.get(t["term"]) or {}).get("relevant")]
    competitor = sorted([t for t in terms if comps and any(cx in t["term"].lower() for cx in comps)],
                        key=lambda x: -x["cost"])[:25]
    flagged = sorted([t for t in top if t["conv"] == 0 and
                      (t["grade"].startswith("F") or (cls.get(t["term"]) or {}).get("relevant") is False)],
                     key=lambda x: -x["cost"])[:30]
    return {
        "source": next((v["source"] for v in cls.values()), "none"),
        "total_terms": len(terms),
        "total_spend": total_spend,
        "intent_segments": intent_segments,
        "service_categories": service_categories,
        "competitor_breakdown": competitor_breakdown,
        "competitor_summary": competitor_summary,
        "competitor_terms": competitor_terms,
        "competitor_total": len(comp_matched),
        "keyword_status": keyword_status,
        "relevant_terms": relevant_terms,
        "relevant_categories": rel_categories,
        "relevant_total": len(rel_sorted),
        "flagged_terms": flagged_terms,
        "flagged_total": len(flag_sorted),
        "grades": grades,
        "grade_method": [{"grade": g, "threshold": th, "interpretation": desc} for (g, th, desc) in ST_GRADE_METHOD],
        "grade_summary": grade_summary,
        "intent_summary": intent_summary,
        "top_graded": [trow(t) for t in sorted(terms, key=lambda x: -x["cost"])[:40]],
        "relevant": [trow(t) for t in sorted(relevant, key=lambda x: -x["cost"])[:25]],
        "competitor": [trow(t) for t in competitor],
        "flagged": [trow(t) for t in flagged],
    }


def _to_overview_findings(findings):
    out = [{"topic": f["title"], "detail": f["magnitude"]}
           for f in sorted(findings, key=lambda x: SEV_ORDER.get(x["severity"], 9))
           if f["severity"] != "PASS"]
    return out[:6]


def build_bundle(client_id, engine=None, date_from=None, date_to=None):
    """Return the DATA bundle dict for a client, or None if there's no campaign data.
    date_from/date_to (YYYY-MM or YYYY-MM-DD) filter the month-grained series/KPIs; whole-window
    reports (search terms, keywords, ads, geo, LP) are unaffected until date-segmented data lands."""
    engine = engine or get_engine()
    rng_from, rng_to = _ym_bound(date_from), _ym_bound(date_to)
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

        # keep only fully-covered months (drop the partial trailing export month), then
        # apply the requested date range at month granularity.
        cm = _latest_complete_month(engine, client_id)
        hi = (cm["year"], cm["month"]) if cm else None
        if rng_to and (hi is None or rng_to < hi):
            hi = rng_to
        if hi:
            series = [s for s in series if s[0][:2] <= hi]
        if rng_from:
            series = [s for s in series if s[0][:2] >= rng_from]
        if series:                      # KPIs/campaigns use the latest month in the (filtered) series
            ly, lm = series[-1][0][0], series[-1][0][1]
            cm = {"year": ly, "month": lm, "ym": f"{ly}-{lm:02d}",
                  "full": f"{FULL_MONTHS[lm-1]} {ly}", "abbr": f"{MABBR[lm-1]} {ly}"}

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
    campaigns = _campaigns(engine, client_id, cm) if cm else None
    geo = _geo(engine, client_id)
    budget = _budget(engine, client_id, cm, config) if cm else None
    qscore = _quality_score(engine, client_id, cm, config)
    qs_break = _qs_breakdown(engine, client_id, cm, config)
    keyword = _keyword_section(engine, client_id)
    kw_regions = _keyword_regions(engine, client_id, config)
    reg_cat = _region_category(engine, client_id, config)
    st = _search_terms_section(engine, client_id, config)
    ads = _ads_section(engine, client_id, config)
    lps = _landing_pages(engine, client_id, config)
    nb_cats = _nb_categories(engine, client_id, cm, config) if cm else None
    regions = _regions(engine, client_id, cm, config) if cm else None

    # Performance section — mirrors the reference nav order (Overview, Monthly Trends,
    # NB Categories, Regions, Campaign, Budget). NB Categories and Regions are both
    # campaign-derived YoY (the date-segmented source). All Brands / Brand Detail are
    # multi-brand only and never populate for a single-brand account, so they are absent.
    view_list = ["overview", "trends"]
    if nb_cats:
        view_list.append("nb-cats")
    if regions:
        view_list.append("regions")
    view_list += ["campaign-perf", "budget-pacing"]
    if keyword or kw_regions:
        view_list.append("kw-deep-dive")
    if qscore:
        view_list.append("qs-detail")
    if qs_break or keyword:
        view_list.append("qs-breakdown")
    if reg_cat or keyword:      # always show the tab; renderer shows an unlock note if unjoined
        view_list.append("region-category")
    if st:
        view_list += ["st-intent", "st-relevant"]
        if st["competitor"]:
            view_list.append("st-competitor")
        if st["flagged"]:
            view_list.append("st-flagged")
    if ads:
        view_list += ["ad-copy", "ad-lp"]
    if lps:
        view_list.append("lp-perf")
        if lps.get("category_grid"):
            view_list.append("lp-category")
    if geo:
        view_list.append("geo-perf")
    view_list.append("recs")

    return {
        "meta": {
            "client_id": client_id,
            "name": _client_name(engine, client_id),
            "periods": meta_periods,
            "complexity": {"n_brands": n_brands, "has_pmax": has_pmax},
            # Views this bundle populates. The frontend hides dashboard tabs not
            # listed here (workspace/admin tabs are always shown). Grows as later
            # increments populate more views.
            "views": view_list,
            "date_range": {
                "from": date_from, "to": date_to,
                "applied": bool(rng_from or rng_to),
                # views that honour the range today (month-grained); the rest are whole-window
                "windowed_views": ["overview", "trends", "campaign-perf", "budget-pacing"],
            },
            "generated_from": "warehouse",
        },
        "total_trend": total_trend,
        "kpis": kpis,
        "findings": findings,
        "recommendations": recommendations,
        "campaigns": campaigns,
        "geo_performance": geo,
        "budget_pacing": budget,
        "quality_score": qscore,
        "keyword_section": keyword,
        "qs_breakdown_section": qs_break,
        "region_category_section": reg_cat,
        "keyword_regions_section": kw_regions,
        "search_terms_section": st,
        "ads_section": ads,
        "landing_pages_section": lps,
        "nb_categories_section": nb_cats,
        "regions_section": regions,
    }
