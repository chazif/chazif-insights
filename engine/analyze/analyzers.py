#!/usr/bin/env python3
"""Deterministic analyzers — port of the audit skill's findings logic.

Each analyzer reads a client's warehouse and returns finding dicts. The assembler
maps findings -> bundle findings (Overview) + recommendations (Recs view).
The math is deterministic; thresholds mirror the audit operating instructions.
"""
import re
import json
from collections import defaultdict
from sqlalchemy import text


FULL_MONTHS = ["January", "February", "March", "April", "May", "June",
               "July", "August", "September", "October", "November", "December"]
_MONTH_NUM = {n.lower(): i + 1 for i, n in enumerate(FULL_MONTHS)}


def _asdict(row):
    """raw_rows.row via a text() query can arrive as a JSON string (SQLite) or a
    dict (Postgres jsonb). Normalize to a dict."""
    if isinstance(row, str):
        try:
            return json.loads(row)
        except (ValueError, TypeError):
            return {}
    return row or {}


def _parse_ym(label):
    """'June 2026' -> (2026, 6); None if unparseable."""
    parts = str(label or "").split()
    if len(parts) != 2:
        return None
    mo = _MONTH_NUM.get(parts[0].lower())
    try:
        yr = int(parts[1])
    except ValueError:
        return None
    return (yr, mo) if mo else None

SMART_BIDDING_FLOOR = 30      # conv/mo for standalone tCPA/tROAS
LOW_VOL_CONV = 15
LOW_VOL_SPEND = 100
STOP = set("a an the of for for to in on at and or near me my i you your with by "
           "is are best top buy shop store online".split())


def F(module, sev, title, obs, mag, impact, rec, summary, dollar, effort, timing, action, data=None):
    # data: {"columns": [...], "rows": [[...], ...]} — the actual records behind the finding
    return dict(module=module, severity=sev, title=title, observation=obs, magnitude=mag,
                impact=impact, recommendation=rec, summary=summary, dollar=dollar,
                effort=effort, timing=timing, action=action, data=data)


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


# ---------- D: data density ----------
def _density(c, client_id, cm, th):
    floor = int(th.get("smart_bidding_floor") or SMART_BIDDING_FLOOR)
    lv_conv = th.get("low_vol_conv") or LOW_VOL_CONV
    lv_spend = th.get("low_vol_spend") or LOW_VOL_SPEND
    findings = []
    rows = c.execute(text(
        "SELECT campaign, SUM(conversions) conv, SUM(cost) cost "
        "FROM raw_rows WHERE client_id=:c AND report_type='campaign_performance' AND date=:d "
        "GROUP BY campaign"), {"c": client_id, "d": cm["full"]}).all()
    if not rows:
        return findings
    camps = [(r[0], _num(r[1]), _num(r[2])) for r in rows]
    above = [x for x in camps if x[1] >= floor]
    below = [x for x in camps if x[1] < floor]
    dens = "; ".join(f"{(nm or '').split('|')[-1].strip()[:22]}: {cv:.0f}" for nm, cv, co in sorted(camps, key=lambda x: -x[1])[:8])
    d1_data = {"columns": ["Campaign", f"Conversions ({cm['abbr']})", "Cost", "Clears floor?"],
               "rows": [[nm, round(cv, 1), round(co, 2), "yes" if cv >= floor else "no"]
                        for nm, cv, co in sorted(camps, key=lambda x: -x[1])]}
    findings.append(F(
        "D", "CRITICAL" if len(below) > len(above) else "IMPORTANT",
        "Campaign conversion velocity vs Smart Bidding thresholds",
        f"{cm['abbr']} conversions by campaign — {dens}. {len(above)} of {len(camps)} campaigns clear the {floor}-conv/mo tCPA floor; {len(below)} are below it.",
        f"{len(above)} tCPA/tROAS-viable · {len(below)} below floor",
        "Sub-floor campaigns can't run Smart Bidding efficiently standalone — they spend without enough signal to optimize against.",
        "Aggregate low-volume campaigns into a Portfolio Bid Strategy (shared budget + pooled signal); let high-volume campaigns run independent tCPA/tROAS.",
        "Pool sub-floor campaigns into a portfolio; run high-volume ones on independent tCPA/tROAS",
        "HIGH", "M", "Week 1-2", "[ACTION REQUIRED]", d1_data))

    lowv = [x for x in camps if x[1] < lv_conv and x[2] > lv_spend]
    if lowv:
        names = "; ".join(f"{(nm or '').split('|')[-1].strip()} ({cv:.0f} conv, ${co:,.0f})" for nm, cv, co in sorted(lowv, key=lambda x: -x[2]))
        lowv_data = {"columns": ["Campaign", "Conversions", "Cost"],
                     "rows": [[nm, round(cv, 1), round(co, 2)] for nm, cv, co in sorted(lowv, key=lambda x: -x[2])]}
        findings.append(F(
            "D", "CRITICAL", "Campaigns below the Smart Bidding floor carrying material spend",
            f"{cm['abbr']}: {names}. Each is under {lv_conv:.0f} conv/mo yet spending >${lv_spend:,.0f}.",
            f"{len(lowv)} campaigns below the floor with material spend",
            "Below-floor campaigns can't learn and tend to run high CPAs.",
            "Consolidate into a shared portfolio, tighten geo/audience, or pause the persistent bleeders and reallocate to efficient campaigns.",
            "Consolidate/tighten or pause below-floor campaigns; reallocate to efficient ones",
            "HIGH", "S", "Week 1-2", "[ACTION REQUIRED]", lowv_data))
    return findings


# ---------- K: match types, three-bucket, waste ----------
def _match_types(c, client_id):
    rows = c.execute(text(
        "SELECT cost, clicks, conversions, row FROM raw_rows WHERE client_id=:c AND report_type='search_keyword_qs'"),
        {"c": client_id}).all()
    if not rows:
        return []
    agg = defaultdict(lambda: [0, 0.0, 0.0])  # match_type -> [n, cost, conv]
    for cost, clicks, conv, row in rows:
        mt = _asdict(row).get("search_keyword_match_type", "") or ""
        key = "Exact" if mt.lower().startswith("exact") else "Phrase" if mt.lower().startswith("phrase") else "Broad" if mt.lower().startswith("broad") else "Other"
        agg[key][0] += 1
        agg[key][1] += _num(cost)
        agg[key][2] += _num(conv)
    total = sum(v[0] for v in agg.values())
    dom = max(agg.items(), key=lambda kv: kv[1][1])[0] if agg else "—"
    idle = [k for k in ("Phrase", "Broad", "Exact") if agg.get(k, [0, 0, 0])[0] > 0 and agg[k][1] < 1]
    parts = ". ".join(f"{k}: {v[0]} kw / ${v[1]:,.0f} / {v[2]:.0f} conv" for k, v in
                      sorted(agg.items(), key=lambda kv: -kv[1][1]) if k != "Other")
    mt_data = {"columns": ["Match type", "Keywords", "Cost", "Conversions"],
               "rows": [[k, v[0], round(v[1], 2), round(v[2], 1)]
                        for k, v in sorted(agg.items(), key=lambda kv: -kv[1][1])]}
    return [F(
        "K", "IMPORTANT", "Match-type allocation and idle inventory",
        f"{parts}. Most spend runs on {dom}." + (f" Idle inventory: {', '.join(idle)} (keywords present, ~$0 spend)." if idle else ""),
        f"{total:,} keywords total · dominant spend on {dom}" + (f" · {', '.join(idle)} idle" if idle else ""),
        "Idle match-type layers contribute no Smart Bidding signal; an over-broad layer without a dense negative shield leaks spend.",
        "Right-size the tri-layer: Exact as the vault, Phrase as the factory, Broad only with Smart Bidding + a dense negative shield. Delete or re-activate idle inventory.",
        "Right-size Exact/Phrase/Broad; delete or re-activate idle inventory",
        "MEDIUM", "S", "Week 2", "[ACTION REQUIRED]", mt_data)]


def _three_bucket(c, client_id, cfg):
    friendly = cfg.get("competitors_friendly", [])
    conquest = cfg.get("competitors_conquest", [])
    comp_note = ""
    if conquest:
        comp_note += f" Conquest targets: {', '.join(conquest[:5])}."
    if friendly:
        comp_note += f" Protect (never conquest/negate): {', '.join(friendly[:5])}."
    camps = [r[0] or "" for r in c.execute(text(
        "SELECT DISTINCT campaign FROM raw_rows WHERE client_id=:c AND report_type='campaign_performance'"),
        {"c": client_id}).all()]
    low = " ".join(camps).lower()
    a_brand = bool(re.search(r"brand", low) and not re.search(r"non[- ]?brand", low)) or "brand" in low
    a_nonb = bool(re.search(r"non[- ]?brand|generic|category", low))
    a_conq = bool(re.search(r"conquest|competitor", low))
    present = [x for x, ok in [("Brand", a_brand), ("Non-Brand", a_nonb), ("Conquest", a_conq)] if ok]
    missing = [x for x, ok in [("Brand", a_brand), ("Non-Brand", a_nonb), ("Conquest", a_conq)] if not ok]
    if len(present) >= 2:
        return [F(
            "K", "PASS", "Three-Bucket architecture is in place",
            f"Detected buckets: {', '.join(present)}." + (f" Missing: {', '.join(missing)}." if missing else ""),
            "Structure follows the Brand / Non-Brand / Conquest rule",
            "Clean separation keeps Smart Bidding signal uncontaminated and lets ad copy match intent.",
            "Maintain the separation; keep brand terms out of non-brand campaigns via negatives." + comp_note,
            "Architecture is broadly correct — maintain it", "LOW", "S", "Reference", "[PASS]")]
    return [F(
        "K", "IMPORTANT", f"Architecture gap — missing {', '.join(missing)} separation",
        f"Detected buckets: {', '.join(present) or 'none'}. Missing: {', '.join(missing)}.",
        "Campaigns are not fully separated into Brand / Non-Brand / Conquest",
        "Blended buckets corrupt Smart Bidding signal and stop ad copy matching intent.",
        "Rebuild into dedicated Brand Defense / Non-Brand (by category) / Conquest campaigns." + comp_note,
        "Separate into Brand / Non-Brand / Conquest campaigns",
        "MEDIUM", "L", "Month 2", "[BUILD REQUIRED]")]


def _brand_split(c, client_id, brand_terms):
    """Brand vs non-brand efficiency, using configured brand terms (not a heuristic)."""
    if not brand_terms:
        return []
    bt = [b.lower() for b in brand_terms]
    rows = c.execute(text(
        "SELECT cost, conversions, row FROM raw_rows WHERE client_id=:c AND report_type='search_keyword_qs'"),
        {"c": client_id}).all()
    if not rows:
        return []
    bc = bv = nc = nv = 0.0
    for cost, conv, row in rows:
        kw = (_asdict(row).get("search_keyword") or "").lower()
        cost, conv = _num(cost), _num(conv)
        if any(b in kw for b in bt):
            bc += cost; bv += conv
        else:
            nc += cost; nv += conv
    if not (bv or nv):
        return []
    bcpa = bc / bv if bv else 0
    ncpa = nc / nv if nv else 0
    gap = (ncpa / bcpa) if bcpa else 0
    bs_data = {"columns": ["Segment", "Spend", "Conversions", "CPA"],
               "rows": [["Brand", round(bc, 2), round(bv, 1), round(bcpa, 2)],
                        ["Non-brand", round(nc, 2), round(nv, 1), round(ncpa, 2)]]}
    return [F(
        "K", "OPPORTUNITY", f"Brand vs non-brand efficiency ({gap:.1f}× CPA gap)",
        f"BRAND ({', '.join(brand_terms[:3])}): ${bc:,.0f} / {bv:.0f} conv / ${bcpa:,.2f} CPA. "
        f"NON-BRAND: ${nc:,.0f} / {nv:.0f} conv / ${ncpa:,.2f} CPA.",
        f"Brand = {(bv/(bv+nv)*100 if (bv+nv) else 0):.0f}% of conv on {(bc/(bc+nc)*100 if (bc+nc) else 0):.0f}% of spend",
        "Brand is the efficiency anchor; non-brand carries growth at a higher CPA and should be measured on its own target.",
        "Keep brand defended and cheap; trim non-brand low-QS bleeders; hold non-brand to its own CPA target.",
        "Defend brand; measure non-brand on its own target", "MEDIUM", "M", "Month 2", "[ACTION REQUIRED]", bs_data)]


def _waste(c, client_id, cfg):
    excl = [t.lower() for t in (cfg.get("brand_terms", []) + cfg.get("competitors_friendly", []) + cfg.get("waste_exclusions", []))]
    total = _num(c.execute(text("SELECT SUM(cost) FROM raw_rows WHERE client_id=:c AND report_type='search_terms'"), {"c": client_id}).scalar())
    uni = defaultdict(float)
    waste_terms = []
    waste = protected = 0.0
    for term, cost in c.execute(text(
        "SELECT entity, cost FROM raw_rows WHERE client_id=:c AND report_type='search_terms' "
        "AND cost>0 AND (conversions=0 OR conversions IS NULL)"), {"c": client_id}).all():
        tl = (term or "").lower()
        cost = _num(cost)
        if excl and any(x in tl for x in excl):   # brand / friendly-competitor / explicit exclusion -> protected
            protected += cost
            continue
        waste += cost
        waste_terms.append((term, cost))
        for w in set(re.findall(r"[a-z0-9]+", tl)):
            if w in STOP or len(w) < 3:
                continue
            uni[w] += cost
    if not waste:
        return []
    topuni = ", ".join(f"{w} (${v:,.0f})" for w, v in sorted(uni.items(), key=lambda x: -x[1])[:6])
    pct = (waste / total * 100) if total else 0
    waste_data = {"columns": ["Search term (0 conversions)", "Cost"],
                  "rows": [[t, round(co, 2)] for t, co in sorted(waste_terms, key=lambda x: -x[1])[:30]]}
    prot_note = f" (${protected:,.0f} in protected brand/competitor terms excluded)" if protected else ""
    return [F(
        "K", "CRITICAL" if pct >= 40 else "IMPORTANT", "Zero-conversion spend and thin negative shield",
        f"${waste:,.0f} on zero-conversion search terms ({pct:.0f}% of search-term spend){prot_note}. Top wasted themes: {topuni}.",
        f"${waste:,.0f} zero-conv · {pct:.0f}% of search spend",
        "Without negatives the same non-converting queries keep firing every period.",
        "Build 3 account-level shared negative lists (brand-protection / intent filter / junk-geo); seed from the top wasted themes.",
        "Build a 3-tier negative shield seeded from the waste themes",
        "HIGH" if pct >= 40 else "MEDIUM", "M", "Week 2", "[BUILD REQUIRED]", waste_data)]


# ---------- Q: quality score ----------
def _quality(c, client_id, th):
    qs_floor = int(th.get("qs_floor") or 3)
    rows = c.execute(text(
        "SELECT cost, row FROM raw_rows WHERE client_id=:c AND report_type='search_keyword_qs'"),
        {"c": client_id}).all()
    if not rows:
        return []
    findings = []
    be_cost = qsdz_cost = 0
    be_kws, dz_kws, qs_vals = [], [], []
    for cost, row in rows:
        row = _asdict(row)
        cost = _num(cost)
        kw = row.get("search_keyword", "")
        if (row.get("exp_ctr") or "").lower() == "below average":
            be_cost += cost; be_kws.append((kw, row.get("quality_score"), cost))
        qs = row.get("quality_score")
        try:
            qsf = float(qs)
            qs_vals.append(qsf)
            if qsf <= qs_floor:
                qsdz_cost += cost; dz_kws.append((kw, qsf, cost))
        except (TypeError, ValueError):
            pass
    avgqs = sum(qs_vals) / len(qs_vals) if qs_vals else 0
    if be_cost:
        overpay = be_cost * 0.33
        be_data = {"columns": ["Keyword", "QS", "Cost"],
                   "rows": [[k, q, round(co, 2)] for k, q, co in sorted(be_kws, key=lambda x: -x[2])[:30]]}
        findings.append(F(
            "Q", "IMPORTANT", f"Below-average expected CTR on ${be_cost:,.0f} of spend",
            f"{len(be_kws)} keywords carry Below-Avg expected CTR (${be_cost:,.0f} spend). Account avg QS ≈ {avgqs:.1f}.",
            f"${be_cost:,.0f} on Below-Avg eCTR → ~${overpay:,.0f} modeled CPC penalty",
            "Below-Avg eCTR carries a CPC premium — the weakest QS lever.",
            "Rework the highest-spend Below-Avg eCTR keywords (exact term in H1, tighter benefit/CTA); A/B via Ad Variations.",
            "Rework highest-spend Below-Avg eCTR keywords", "MEDIUM", "M", "Week 1-2", "[ACTION REQUIRED]", be_data))
    if dz_kws:
        dz_data = {"columns": ["Keyword", "QS", "Cost"],
                   "rows": [[k, q, round(co, 2)] for k, q, co in sorted(dz_kws, key=lambda x: -x[2])[:30]]}
        findings.append(F(
            "Q", "IMPORTANT", f"QS 1-{qs_floor} danger zone holds {len(dz_kws)} keywords (${qsdz_cost:,.0f})",
            f"QS 1-{qs_floor}: {len(dz_kws)} keywords, ${qsdz_cost:,.0f} spend. Account avg QS ≈ {avgqs:.1f}.",
            f"{len(dz_kws)} low-QS keywords paying CPC penalties",
            "Low-QS keywords pay CPC penalties; fixing or pausing frees budget for higher-QS terms.",
            "Pause QS 1-3 with Below-Avg eCTR and <2 conv; rework copy first for low-QS converters.",
            "Pause/rework the QS 1-3 danger-zone keywords", "MEDIUM", "M", "Month 2", "[ACTION REQUIRED]", dz_data))
    return findings


# ---------- P: PMax placement spray ----------
def _pmax(c, client_id):
    total = c.execute(text("SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements'"), {"c": client_id}).scalar() or 0
    if not total:
        return []
    served = c.execute(text("SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements' AND impressions>=2"), {"c": client_id}).scalar() or 0
    one = c.execute(text("SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements' AND impressions<=1"), {"c": client_id}).scalar() or 0
    top = c.execute(text("SELECT entity, impressions FROM raw_rows WHERE client_id=:c AND report_type='pmax_placements' "
                         "AND impressions>=2 ORDER BY impressions DESC"), {"c": client_id}).fetchmany(25)
    pmax_data = {"columns": ["Top served placements", "Impressions"],
                 "rows": [[p or "(unknown)", round(_num(im))] for p, im in top]}
    return [F(
        "P", "CRITICAL", f"PMax spray — only {served/total*100:.1f}% of placements served ≥2 impressions",
        f"{total:,} placement candidates; {served:,} ({served/total*100:.1f}%) served ≥2 impressions, {one:,} ({one/total*100:.0f}%) got ≤1.",
        f"{one/total*100:.0f}% of placements got ≤1 impression — budget sprayed thin",
        "A long tail of one-impression placements (often foreign-language / junk / video reach) dilutes budget and pollutes brand safety.",
        "Apply account-level placement exclusions (non-English locales, sensitive categories); disable PMax video/display reach if not core; tighten geo/audience signals.",
        "Add placement exclusions + tighten signals to stop the PMax spray",
        "HIGH", "M", "Week 2", "[ACTION REQUIRED]", pmax_data)]


# ---------- D: month-over-month conversion trend (seasonality-aware) ----------
def _trend(c, client_id, cm, seasonality):
    rows = c.execute(text(
        "SELECT date, SUM(conversions) conv FROM raw_rows WHERE client_id=:c "
        "AND report_type='campaign_performance' AND date IS NOT NULL GROUP BY date"),
        {"c": client_id}).all()
    series = []
    for date, conv in rows:
        ym = _parse_ym(date)
        if ym:
            series.append((ym, _num(conv)))
    series.sort()
    series = [s for s in series if s[0] <= (cm["year"], cm["month"])]
    if len(series) < 2:
        return []
    (_, cur_conv), (_, prior_conv) = series[-1], series[-2]
    if prior_conv < 10:                     # too small to judge a % move
        return []
    drop = (cur_conv - prior_conv) / prior_conv
    if drop >= -0.15:                       # no material decline
        return []

    month_name = FULL_MONTHS[cm["month"] - 1]
    trough = None
    for w in (seasonality or []):
        months = [str(m).strip().lower() for m in (w.get("months") or [])]
        if month_name.lower() in months or month_name[:3].lower() in months:
            trough = w.get("label") or "seasonal trough"
            break
    pct = abs(drop) * 100
    if trough:                              # suppressed: expected per business context
        return [F(
            "D", "PASS", f"Conversions down {pct:.0f}% MoM — expected seasonal trough",
            f"{cm['abbr']} conversions {cur_conv:.0f} vs prior {prior_conv:.0f} ({drop*100:+.0f}%). "
            f"{month_name} is a configured seasonal trough ({trough}).",
            "Expected seasonal dip — suppressed",
            "Matches the business-context seasonality window; not a performance problem.",
            "Hold — expected seasonal dip; re-baseline after the trough.",
            "Expected seasonal dip — monitor only", "LOW", "S", "Reference", "[PASS]")]
    trend_data = {"columns": ["Month", "Conversions"],
                  "rows": [[FULL_MONTHS[mo - 1] + " " + str(yr), round(cv, 1)] for (yr, mo), cv in series[-8:]]}
    return [F(
        "D", "CRITICAL" if drop <= -0.4 else "IMPORTANT",
        f"Conversion decline — down {pct:.0f}% month-over-month",
        f"{cm['abbr']} conversions {cur_conv:.0f} vs prior {prior_conv:.0f} ({drop*100:+.0f}%).",
        f"{pct:.0f}% MoM conversion drop",
        "A material month-over-month conversion drop needs a cause check (tracking break, budget cut, competition, or seasonality).",
        "Pull Change History; verify conversion tracking fires; check budget/bid changes before restructuring.",
        "Investigate the MoM conversion drop (tracking first)",
        "HIGH" if drop <= -0.4 else "MEDIUM", "S", "Week 1", "[ACTION REQUIRED]", trend_data)]


def run_analyzers(engine, client_id, cm, config=None):
    """Run all analyzers; return a flat list of findings. `config` is the client's
    business-context config (brand/competitor terms, thresholds, overrides)."""
    from ..clientconfig import merged
    cfg = merged(config or {})
    th = cfg["thresholds"]
    findings = []
    with engine.connect() as c:
        findings += _density(c, client_id, cm, th)
        findings += _trend(c, client_id, cm, cfg["seasonality"])
        findings += _match_types(c, client_id)
        findings += _brand_split(c, client_id, cfg["brand_terms"])
        findings += _three_bucket(c, client_id, cfg)
        findings += _waste(c, client_id, cfg)
        findings += _quality(c, client_id, th)
        findings += _pmax(c, client_id)
    return findings
