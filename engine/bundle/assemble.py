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
            },
        })
    return recs


def _prior_month(cm):
    pm, py = cm["month"] - 1, cm["year"]
    if pm == 0:
        pm, py = 12, py - 1
    return {"full": f"{FULL_MONTHS[pm-1]} {py}", "abbr": f"{MABBR[pm-1]} {py}"}


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


def _quality_score(engine, client_id):
    """QS distribution, buckets, and top low-QS keywords from the Search Keyword + QS report."""
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, row FROM raw_rows WHERE client_id=:c AND report_type='search_keyword_qs'"),
            {"c": client_id}).all()
    if not rows:
        return None
    dist = {i: [0, 0.0] for i in range(1, 11)}
    qs_vals, kws = [], []
    for cost, clicks, row in rows:
        d = _asdict(row); cost = _num(cost); clicks = _num(clicks)
        try:
            q = int(float(d.get("quality_score")))
        except (TypeError, ValueError):
            continue
        if 1 <= q <= 10:
            dist[q][0] += 1; dist[q][1] += cost; qs_vals.append(q)
            kws.append((d.get("search_keyword", ""), d.get("search_keyword_match_type", ""), q, cost, clicks))
    if not qs_vals:
        return None

    def bucket(lo, hi):
        return sum(dist[i][0] for i in range(lo, hi + 1)), round(sum(dist[i][1] for i in range(lo, hi + 1)), 2)
    lk, lc = bucket(1, 4); mk, mc = bucket(5, 7); hk, hc = bucket(8, 10)
    top_low = sorted([k for k in kws if k[2] <= 5], key=lambda x: -x[3])[:15]
    return {
        "avg_qs": round(sum(qs_vals) / len(qs_vals), 1),
        "total_keywords": len(qs_vals),
        "distribution": [{"qs": i, "keywords": dist[i][0], "cost": round(dist[i][1], 2)} for i in range(1, 11)],
        "buckets": [{"label": "Low (1-4)", "keywords": lk, "cost": lc},
                    {"label": "Mid (5-7)", "keywords": mk, "cost": mc},
                    {"label": "High (8-10)", "keywords": hk, "cost": hc}],
        "top_low": [{"keyword": k[0], "match": k[1], "qs": k[2], "cost": round(k[3], 2), "clicks": round(k[4])} for k in top_low],
    }


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


def _grade_term(t):
    if t["conv"] >= 1:
        return "A — Converting"
    if t["cost"] > 0 and t["conv"] == 0 and t["clicks"] >= 5:
        return "F — No conversions"
    if t["clicks"] < 5:
        return "Low volume"
    return "C — Traffic, no conv"


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


def _ads_section(engine, client_id):
    """RSA inventory + performance (Ad Copy) and ad → landing-page pairing."""
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
        ads.append({"campaign": d.get("campaign", ""), "ad_group": d.get("ad_group", ""),
                    "type": d.get("ad_type", ""), "final_url": d.get("ad_final_url") or d.get("final_url") or "",
                    "headlines": hn, "descriptions": dn, "clicks": round(clicks), "impr": round(impr),
                    "cost": round(cost, 2), "conv": round(cv, 1), "ctr": round(clicks / impr, 4) if impr else 0})
    if not ads:
        return None
    ads.sort(key=lambda x: -x["cost"])
    return {"count": len(ads), "ads": ads[:40]}


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
    terms = []
    for term, clicks, cost, conv, row in rows:
        t = {"term": term or "", "match": _asdict(row).get("search_terms_match_type", ""),
             "clicks": _num(clicks), "cost": _num(cost), "conv": _num(conv)}
        t["grade"] = _grade_term(t)
        terms.append(t)

    top = sorted(terms, key=lambda x: -x["cost"])[:60]
    context = {"product_categories": config.get("product_categories", []),
               "brand_terms": config.get("brand_terms", []),
               "competitors_conquest": config.get("competitors_conquest", [])}
    cls = get_or_classify(engine, client_id, [t["term"] for t in top], context)
    for t in terms:
        r = cls.get(t["term"])
        t["intent"] = r["category"] if r else None
        t["relevant"] = r["relevant"] if r else None

    gc, gs = Counter(), Counter()
    for t in terms:
        gc[t["grade"]] += 1; gs[t["grade"]] += t["cost"]
    grade_order = ["A — Converting", "C — Traffic, no conv", "F — No conversions", "Low volume"]
    grade_summary = [{"grade": g, "terms": gc[g], "cost": round(gs[g], 2)} for g in grade_order if g in gc]

    ic, isp = Counter(), Counter()
    for t in top:
        cat = (cls.get(t["term"]) or {}).get("category", "unclassified")
        ic[cat] += 1; isp[cat] += t["cost"]
    intent_summary = [{"intent": k, "terms": ic[k], "cost": round(isp[k], 2)} for k in sorted(ic, key=lambda x: -isp[x])]

    comps = [x.lower() for x in (config.get("competitors_conquest", []) + config.get("competitors_friendly", []))]

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
    campaigns = _campaigns(engine, client_id, cm) if cm else None
    geo = _geo(engine, client_id)
    budget = _budget(engine, client_id, cm, config) if cm else None
    qscore = _quality_score(engine, client_id)
    keyword = _keyword_section(engine, client_id)
    st = _search_terms_section(engine, client_id, config)
    ads = _ads_section(engine, client_id)
    lps = _landing_pages(engine, client_id, config)

    view_list = ["overview", "trends", "campaign-perf", "budget-pacing"]
    if keyword:
        view_list.append("kw-deep-dive")
    if qscore:
        view_list.append("qs-detail")
    if keyword:
        view_list.append("qs-breakdown")
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
        "search_terms_section": st,
        "ads_section": ads,
        "landing_pages_section": lps,
    }
