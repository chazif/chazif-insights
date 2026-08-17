#!/usr/bin/env python3
"""Assemble a client's DATA bundle from the raw warehouse (Phase 2, increment 1).

Produces the keys the core views (Overview, Monthly Trends) consume, computed from
real ingested data. The analyzers (density, n-gram waste, QS, three-bucket, PMax)
and the full view set land in later increments; this proves the raw -> bundle ->
dashboard seam for a real client.
"""
import calendar
import datetime
import re
from collections import defaultdict
from sqlalchemy import text, select, func
from ..ingest.store import get_engine, clients, uploads, qs_history
from ..ingest.service import get_config
from ..ingest.parser import GEO_SLUGS, impr_share_frac
from ..analyze.analyzers import run_analyzers, _asdict, _num
from ..warehouse import bq
from ..mapping import (Resolver as _MapResolver, resolver as _build_resolver,
                       pending_counts as _mapping_pending)
from ..grading import (cohort_grader, GRADE_BANDS, SCORE_BANDS, ZERO_CONV_CLICKS)


def _grading_cfg(config):
    """(mode, benchmarks-dict) from client config, defaulting to relative + no benchmarks."""
    config = config or {}
    return (config.get("grading_mode") or "relative").lower(), (config.get("benchmarks") or {})


def _run_sections(tasks, parallel):
    """Run each named thunk and return {name: result}. When `parallel`, the thunks run in
    a thread pool: the section builders are independent and each opens its own connection,
    so overlapping their queries turns ~N sequential BigQuery jobs into a few concurrent
    waves (the dominant cost of a bundle build in production). Sequential otherwise — local
    SQLite can't share connections across threads and is fast enough that it doesn't matter.
    Exceptions propagate exactly as in the sequential path."""
    if not parallel:
        return {name: fn() for name, fn in tasks.items()}
    from concurrent.futures import ThreadPoolExecutor
    out = {}
    with ThreadPoolExecutor(max_workers=min(12, len(tasks) or 1)) as ex:
        futs = {ex.submit(fn): name for name, fn in tasks.items()}
        for fut, name in futs.items():
            out[name] = fut.result()
    return out

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
_MONTH_ABBR = {a.lower(): FULL_MONTHS[i].lower() for i, a in enumerate(MABBR)}  # 'mar' -> 'march'


def _mk(yr, mo):
    return (yr, mo, f"{yr}-{mo:02d}", f"{MABBR[mo-1]} {yr}") if 1 <= mo <= 12 else None


def _slash_order(dates):
    """Infer day/month order for D/M or M/D slash dates by finding a disambiguating
    value (a component > 12). 'dmy' (day-first, most locales) or 'mdy' (US default)."""
    for d in dates:
        m = re.match(r"^\s*(\d{1,2})/(\d{1,2})/\d{2,4}\s*$", str(d or ""))
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > 12:
                return "dmy"
            if b > 12:
                return "mdy"
    return "mdy"


def _month_key(label, order="mdy"):
    """Normalize a Google Ads Month/Day cell to (year, month, 'YYYY-MM', 'Mon YYYY');
    None if unparseable. Accepts the formats Report Editor emits across locales/settings:
    'March 2026', 'Mar 2026', '2026-03', '2026-03-01', '2026/03/01', '3/2026', and day
    dates '23/10/2025' / '10/23/2025' (order disambiguated via `order`)."""
    if not label:
        return None
    s = str(label).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$", s)        # 2026-03 / 2026-03-15 / 2026/03/15
    if m:
        return _mk(int(m.group(1)), int(m.group(2)))
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s)              # D/M/YYYY or M/D/YYYY (day date)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        yr = int(m.group(3)); yr += 2000 if yr < 100 else 0
        mo = b if order == "dmy" else a
        if not 1 <= mo <= 12:                                        # impossible -> use the other component
            mo = a if order == "dmy" else b
        return _mk(yr, mo)
    m = re.match(r"^(\d{1,2})/(\d{2,4})$", s)                        # M/YYYY
    if m:
        yr = int(m.group(2)); yr += 2000 if yr < 100 else 0
        return _mk(yr, int(m.group(1)))
    parts = s.split()                                                # March 2026 / Mar 2026
    if len(parts) == 2:
        mo = MONTHS.get(parts[0].lower()) or MONTHS.get(_MONTH_ABBR.get(parts[0][:3].lower(), ""))
        try:
            yr = int(parts[1])
        except ValueError:
            return None
        if mo:
            return _mk(yr, mo)
    return None


def _client_name(engine, client_id):
    with engine.connect() as c:
        r = c.execute(select(clients.c.name).where(clients.c.client_id == client_id)).first()
        return r[0] if r else client_id


def _ym_bound(s):
    """'2026-06' or '2026-06-15' -> (2026, 6); None if empty/unparseable."""
    m = re.match(r"(\d{4})-(\d{2})", str(s or ""))
    return (int(m.group(1)), int(m.group(2))) if m else None


def _date_bound(s, end=False):
    """'2026-03-15' -> that datetime.date; '2026-03' -> first (end=False) or last
    (end=True) day of the month; None if empty/unparseable. A real date object (not an
    ISO string) so the param binds as DATE on BigQuery (its DATE columns won't compare
    against a STRING) — and it still works on SQLite/Postgres."""
    m = re.match(r"^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$", str(s or "").strip())
    if not m:
        return None
    y, mo = int(m.group(1)), int(m.group(2))
    d = int(m.group(3)) if m.group(3) else (calendar.monthrange(y, mo)[1] if end else 1)
    try:
        return datetime.date(y, mo, d)
    except ValueError:
        return None


def _range_sql(d_from, d_to):
    """SQL fragment + params limiting raw_rows to [d_from, d_to] by date_norm. Undated
    rows (date_norm NULL) are kept, so snapshot reports not yet re-uploaded at day level
    still show their whole window. Returns ('', {}) when no range is set. Params are
    datetime.date objects (DATE-typed for BigQuery)."""
    if not (d_from or d_to):
        return "", {}
    return (" AND (date_norm IS NULL OR date_norm BETWEEN :d_from AND :d_to)",
            {"d_from": d_from or datetime.date(1, 1, 1), "d_to": d_to or datetime.date(9999, 12, 31)})


def _has_day(s):
    """True if the request bound is day-precise ('2026-07-14'), vs month-only ('2026-07')."""
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}", str(s or "")))


def _as_date(v):
    """Coerce a DATE column value (date object on Postgres, ISO string on SQLite) to date."""
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(v or ""))
    return datetime.date(int(m[1]), int(m[2]), int(m[3])) if m else None


def _shift_year(d, n):
    try:
        return d.replace(year=d.year + n)
    except ValueError:                     # Feb 29 -> Feb 28 in a non-leap prior year
        return d.replace(year=d.year + n, day=28)


def _cp_range_sums(c, client_id, keep, lo, hi):
    """Sum campaign_performance cost/clicks/conv over the day range [lo, hi] (date objects)."""
    cost = clicks = conv = 0.0
    for co, cl, cv, row in c.execute(text(
            "SELECT cost, clicks, conversions, row FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance' AND date_norm BETWEEN :lo AND :hi"),
            {"c": client_id, "lo": lo, "hi": hi}):
        if keep(_asdict(row)):
            cost += _num(co); clicks += _num(cl); conv += _num(cv)
    return cost, clicks, conv


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


def _to_recommendations(findings, client_id=None):
    from ..decisions.keys import action_key
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
            # stable identity for the decision-system lifecycle (accept/dismiss/…)
            "action_key": action_key(client_id, f) if client_id else None,
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
    return {"year": py, "month": pm, "full": f"{FULL_MONTHS[pm-1]} {py}", "abbr": f"{MABBR[pm-1]} {py}"}


def _yoy_prior(cm):
    """Same month, prior year — the YoY comparison period."""
    py = cm["year"] - 1
    return {"year": py, "month": cm["month"],
            "full": f"{FULL_MONTHS[cm['month']-1]} {py}", "abbr": f"{MABBR[cm['month']-1]} {py}"}


def _campaigns(engine, client_id, cm, keep=None, dateless=False):
    """Per-campaign snapshot for the latest complete month + month-over-month deltas.
    Rows are matched to a month via _month_key (robust to 'June 2026' / '2026-06' / ...).
    When `dateless` (the export carries no parseable month), all rows are treated as the
    current snapshot and there is no prior month to compare against."""
    keep = keep or (lambda d: True)
    prior = _prior_month(cm)
    with engine.connect() as c:
        allrows = c.execute(text(
            "SELECT date, campaign, clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='campaign_performance'"), {"c": client_id}).all()
    order = _slash_order(r[0] for r in allrows)

    def month_map(target, allow_dateless):
        out = {}
        for date, camp, clicks, cost, conv, row in allrows:
            mk = _month_key(date, order)
            match = (mk[:2] == target) if mk else (allow_dateless and target == (cm["year"], cm["month"]))
            if not match or not keep(_asdict(row)):
                continue
            e = out.setdefault(camp, {"clicks": 0.0, "cost": 0.0, "conv": 0.0,
                                      "type": _asdict(row).get("campaign_type", "")})
            e["clicks"] += _num(clicks); e["cost"] += _num(cost); e["conv"] += _num(conv)
        return out

    cur = month_map((cm["year"], cm["month"]), dateless)
    pri = month_map((prior["year"], prior["month"]), False)
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


def _geo(engine, client_id, keep=None, date_from=None, date_to=None):
    """Performance by geographic location (whatever grain the export carries — State
    for most single-market accounts). Cost derived from Cost/conv since the Geographic
    export has no Cost column. Returns None if no geo data."""
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, impressions, conversions, conv_value, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='geographic'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0.0])  # clicks, impr, conv, conv_value, cost
    for ent, clicks, impr, conv, cval, row in rows:
        if not keep(_asdict(row)):
            continue
        loc = ent or "(not set)"
        d = agg[loc]
        cv = _num(conv)
        d[0] += _num(clicks); d[1] += _num(impr); d[2] += cv; d[3] += _num(cval)
        cpc = _num(_asdict(row).get("cost_conv"))     # Cost / conv.
        d[4] += cpc * cv if cpc else 0.0
    if not agg:
        return None
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


def _effective_budget(config):
    """Effective monthly budget: sum of uploaded dimensional budget_lines if any,
    otherwise the manually-entered thresholds.monthly_budget. None if neither is set."""
    lines = config.get("budget_lines") or []
    if lines:
        return round(sum(_num(l.get("monthly")) for l in lines), 2)
    m = (config.get("thresholds") or {}).get("monthly_budget")
    try:
        return float(m) if m not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _budget_section(config):
    """Budget composition for the Budget tab: effective monthly total, its source
    (file / manual / none), the dimensional lines, and per-dimension rollups."""
    lines = config.get("budget_lines") or []
    manual = (config.get("thresholds") or {}).get("monthly_budget")
    try:
        manual = float(manual) if manual not in (None, "") else None
    except (TypeError, ValueError):
        manual = None
    total = _effective_budget(config)
    source = "file" if lines else ("manual" if manual else "none")

    def rollup(dim):
        agg = defaultdict(float)
        for l in lines:
            agg[l.get(dim) or "(unspecified)"] += _num(l.get("monthly"))
        return [{"key": k, "monthly": round(v, 2)} for k, v in sorted(agg.items(), key=lambda x: -x[1])]
    rollups = {dim: rollup(dim) for dim in ("brand", "region", "category") if any(l.get(dim) for l in lines)}
    return {"total_monthly": total, "source": source, "manual": round(manual, 2) if manual else None,
            "line_count": len(lines),
            "lines": [{"brand": l.get("brand"), "region": l.get("region"), "category": l.get("category"),
                       "monthly": round(_num(l.get("monthly")), 2)} for l in lines],
            "rollups": rollups}


def _budget_status(bud, act):
    if not bud:
        return "n/a"
    p = act / bud
    return "over" if p > 1.05 else "under" if p < 0.9 else "on-track"


def _budget_reconciliation(engine, client_id, cm, config, dateless=False):
    """Reconcile the planned budget against actual spend for the latest complete month:
    a total budget-vs-actual, plus a per-category breakdown when the budget carries a
    category dimension (actual bucketed by product category from campaign names —
    approximate). None if there is no month or no budget to reconcile against."""
    if not cm:
        return None
    total_budget = _effective_budget(config)
    if not total_budget:
        return None
    with engine.connect() as c:
        allrows = c.execute(text(
            "SELECT date, campaign, cost FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance'"), {"c": client_id}).all()
    order = _slash_order(r[0] for r in allrows)
    target = (cm["year"], cm["month"])
    rows = [(camp, cost) for date, camp, cost in allrows
            if (_month_key(date, order)[:2] == target if _month_key(date, order) else dateless)]
    total_actual = round(sum(_num(cost) for _camp, cost in rows), 2)

    recon = {"month": cm["abbr"], "total_budget": round(total_budget, 2), "total_actual": total_actual,
             "variance": round(total_actual - total_budget, 2),
             "pct": round(total_actual / total_budget, 4) if total_budget else None,
             "status": _budget_status(total_budget, total_actual), "by_category": None}

    lines = config.get("budget_lines") or []
    if any(l.get("category") for l in lines):
        bud_cat = defaultdict(float)
        for l in lines:
            bud_cat[l.get("category") or "(unspecified)"] += _num(l.get("monthly"))
        catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
                 for c in (config.get("product_categories") or [])}

        def categorize(name):
            n = (name or "").lower()
            for cat, kws in catkw.items():
                if cat.lower() in n or any(w in n for w in kws):
                    return cat[:1].upper() + cat[1:]
            return "Other / uncategorized"
        act_cat = defaultdict(float)
        for camp, cost in rows:
            act_cat[categorize(camp)] += _num(cost)
        cats = sorted(set(bud_cat) | set(act_cat), key=lambda k: -(bud_cat.get(k, 0) + act_cat.get(k, 0)))
        recon["by_category"] = [{"category": k, "budget": round(bud_cat.get(k, 0), 2), "actual": round(act_cat.get(k, 0), 2),
                                 "variance": round(act_cat.get(k, 0) - bud_cat.get(k, 0), 2),
                                 "pct": round(act_cat.get(k, 0) / bud_cat[k], 4) if bud_cat.get(k) else None,
                                 "status": _budget_status(bud_cat.get(k, 0), act_cat.get(k, 0))} for k in cats]
    return recon


def _pacing_daily(engine, client_id, config, keep=None):
    """Daily budget pacing for the latest month with day-level campaign data: cumulative
    spend vs a flat daily-budget target, plus a run-rate month-end projection. None when
    there's no monthly budget or no day-segmented campaign data (the view then keeps its
    monthly-only behaviour).

    Pacing is measured against the last day that HAS data (`data_through`), never the
    calendar date — so a stale upload can't fake an "underpacing" alarm. v1 uses a flat
    daily budget (monthly / days-in-month); weekday weighting is a follow-up."""
    keep = keep or (lambda d: True)
    budget = _effective_budget(config)
    if not budget:
        return None
    # Prefer the account-level daily-spend export (the "Pacing" report) when present — it's
    # the exact per-day account total and covers accounts that lack day-level campaign data;
    # otherwise fall back to summing campaign_performance by day.
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT date_norm, cost, row FROM raw_rows WHERE client_id=:c "
            "AND report_type='account_spend' AND date_norm IS NOT NULL"), {"c": client_id}).all()
        if not rows:
            rows = c.execute(text(
                "SELECT date_norm, cost, row FROM raw_rows WHERE client_id=:c "
                "AND report_type='campaign_performance' AND date_norm IS NOT NULL"), {"c": client_id}).all()
    daily = defaultdict(float)
    for dn, cost, row in rows:
        d = _as_date(dn)
        if d is None or not keep(_asdict(row)):
            continue
        daily[d] += _num(cost)
    if not daily:
        return None

    last = max(daily)
    y, mo = last.year, last.month
    dim = calendar.monthrange(y, mo)[1]
    daily_budget = budget / dim
    month_days = sorted(d for d in daily if d.year == y and d.month == mo)
    if not month_days:
        return None

    cum, days = 0.0, []
    for dd in month_days:
        cum += daily[dd]
        target = daily_budget * dd.day
        days.append({"date": dd.isoformat(), "spend": round(daily[dd], 2),
                     "cum_spend": round(cum, 2), "cum_target": round(target, 2),
                     "pace_pct": round(cum / target, 4) if target else None,
                     "status": _budget_status(target, cum)})

    elapsed = month_days[-1].day               # day number of the last day with data
    mtd_target = daily_budget * elapsed
    projection = cum / elapsed * dim if elapsed else 0.0   # linear run-rate to month end
    proj_pct = projection / budget if budget else None
    return {
        "month": f"{MABBR[mo-1]} {y}", "ym": f"{y}-{mo:02d}",
        "monthly_budget": round(budget, 2), "daily_budget": round(daily_budget, 2),
        "days_in_month": dim, "data_through": month_days[-1].isoformat(),
        "days_with_data": len(month_days),
        "mtd_spend": round(cum, 2), "mtd_target": round(mtd_target, 2),
        "pace_pct": round(cum / mtd_target, 4) if mtd_target else None,
        "status": _budget_status(mtd_target, cum),
        "days": days,
        "projection": {"spend": round(projection, 2), "variance": round(projection - budget, 2),
                       "pct": round(proj_pct, 4) if proj_pct is not None else None,
                       "status": _budget_status(budget, projection)},
        "months_available": [f"{MABBR[m-1]} {yy}"
                             for (yy, m) in sorted({(d.year, d.month) for d in daily}, reverse=True)],
    }


def _budget(engine, client_id, cm, config, keep=None, dateless=False):
    """Monthly spend vs a configured monthly budget, plus (when day-segmented data exists)
    intra-month daily pacing under `daily`. A dateless export is reported as a single
    current-month bucket."""
    keep = keep or (lambda d: True)
    budget = _effective_budget(config)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT date, cost, row FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance'"), {"c": client_id}).all()
    order = _slash_order(r[0] for r in rows)
    magg = defaultdict(float)      # (year, month) -> spend
    for date, cost, row in rows:
        if not keep(_asdict(row)):
            continue
        mk = _month_key(date, order)
        if mk:
            magg[mk[:2]] += _num(cost)
        elif dateless:
            magg[(cm["year"], cm["month"])] += _num(cost)
    series = sorted(magg.items())
    series = [s for s in series if s[0] <= (cm["year"], cm["month"])]
    months = [{
        "month": f"{MABBR[mo-1]} {yr}", "spend": round(cost, 2),
        "budget": round(budget, 2) if budget else None,
        "variance": round(cost - budget, 2) if budget else None,
        "pct": round(cost / budget, 4) if budget else None,
    } for ((yr, mo), cost) in series[-12:]]
    latest = months[-1] if months else None
    status = None
    if latest and budget:
        p = latest["pct"]
        status = "over" if p > 1.05 else "under" if p < 0.9 else "on-track"
    return {"monthly_budget": round(budget, 2) if budget else None,
            "months": months, "latest": latest, "status": status,
            "daily": _pacing_daily(engine, client_id, config, keep)}


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


def _kw_qs_rows(engine, client_id, d_from=None, d_to=None):
    """Per-keyword pseudo-rows for the QS builders, so day-segmented QS exports don't
    double-count keywords. Performance (cost/clicks/impr/conv) is summed over the date
    range; QS + the three components come from qs_history as the LATEST snapshot on or
    before the range end (falling back to the row's own QS when qs_history has none,
    e.g. data ingested before QS history existed). Returns [(cost, clicks, impr, conv,
    row_dict), ...] — the same shape the builders already iterate."""
    rc, rp = _range_sql(d_from, d_to)
    with engine.connect() as c:
        raw = c.execute(text(
            "SELECT cost, clicks, impressions, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_keyword_qs'" + rc), {"c": client_id, **rp}).all()
        qp = {"c": client_id}
        qwhere = "client_id=:c"
        if d_to:
            qwhere += " AND as_of_date <= :dto"; qp["dto"] = d_to
        qs_rows = c.execute(text(
            "SELECT kw_key, as_of_date, quality_score, exp_ctr_label, ad_relevance_label, "
            "landing_page_exp_label FROM qs_history WHERE " + qwhere), qp).all()
    latest = {}                                        # kw_key -> latest snapshot in range
    for kk, ad, qs, el, al, ll in qs_rows:
        cur = latest.get(kk)
        if cur is None or (ad and (cur[0] is None or ad > cur[0])):
            latest[kk] = (ad, qs, el, al, ll)
    agg = {}
    for cost, clicks, impr, conv, row in raw:
        d = _asdict(row)
        key = "\x1f".join("" if x is None else str(x) for x in
                          (d.get("search_keyword"), d.get("search_keyword_match_type"),
                           d.get("campaign"), d.get("ad_group")))
        e = agg.get(key)
        if e is None:
            e = agg[key] = [0.0, 0.0, 0.0, 0.0, dict(d)]
        e[0] += _num(cost); e[1] += _num(clicks); e[2] += _num(impr); e[3] += _num(conv)
    out = []
    for key, e in agg.items():
        d = e[4]
        lt = latest.get(key)
        if lt:                                         # override with the frozen latest-in-range QS
            _, qs, el, al, ll = lt
            d["quality_score"] = qs
            d["exp_ctr"], d["ad_relevance"], d["landing_page_exp"] = el, al, ll
        out.append((e[0], e[1], e[2], e[3], d))
    return out


def _qs_trend(engine, client_id, brand_terms):
    """Average Quality Score over time from the frozen qs_history, one point per calendar
    month: for each (keyword, month) take that month's latest QS, then average across the
    non-brand keyword portfolio. Full history (not date-range bound) so the trajectory is
    stable. Returns [{month, avg_qs, keywords}, ...] oldest-first (empty if no history)."""
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT as_of_date, kw_key, quality_score, search_keyword, campaign "
            "FROM qs_history WHERE client_id=:c AND quality_score IS NOT NULL"), {"c": client_id}).all()
    best = {}                                   # (year, month, kw_key) -> (as_of_date, qs)
    for ad, kk, qs, kw, camp in rows:
        d = _as_date(ad)
        if not d or qs is None:
            continue
        kwl, cl = (kw or "").lower(), (camp or "").lower()
        if brand_terms and (any(b in kwl for b in brand_terms) or any(b in cl for b in brand_terms)):
            continue                            # non-brand portfolio only
        k = (d.year, d.month, kk)
        cur = best.get(k)
        if cur is None or d > cur[0]:
            best[k] = (d, float(qs))
    agg = {}                                    # (year, month) -> [sum_qs, n]
    for (y, m, _kk), (_d, qs) in best.items():
        a = agg.setdefault((y, m), [0.0, 0]); a[0] += qs; a[1] += 1
    return [{"month": f"{MABBR[m-1]} {y}", "avg_qs": round(s / n, 2), "keywords": n}
            for (y, m), (s, n) in sorted(agg.items())]


def _quality_score(engine, client_id, cm=None, config=None, keep=None, date_from=None, date_to=None):
    """Non-brand Quality Score overview from the Search Keyword + QS report: per-QS
    (1-10) keyword/spend/click/conv rollups with CPC/CTR/CVR/CPA, four QS buckets, a
    weak→strong CPC-differential savings estimate, portfolio totals, and a monthly
    avg-QS trend from the frozen qs_history."""
    config = config or {}
    keep = keep or (lambda d: True)
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    rows = _kw_qs_rows(engine, client_id, date_from, date_to)   # per-keyword, latest-in-range QS
    if not rows:
        return None
    per = {i: {"keywords": 0, "cost": 0.0, "clicks": 0.0, "impr": 0.0, "conv": 0.0} for i in range(1, 11)}
    for cost, clicks, impr, conv, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
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
        "trend": _qs_trend(engine, client_id, brand_terms),
        "totals": {"keywords": total_kw, "cost": round(total_cost, 2), "clicks": round(total_clicks),
                   "conv": round(total_conv, 1), **rates(total_cost, total_clicks, total_impr, total_conv)},
    }


def _qs_breakdown(engine, client_id, cm, config, keep=None, date_from=None, date_to=None):
    """QS Breakdown: per-component (eCTR / Ad Relevance / LP Experience) rating rollups,
    the 27-way eCTR×LP×AdRel combination grid (avg CPC / spend / avg QS per cell), a
    weak→QS7 savings estimate by brand, and the top QS≤6 optimization keywords. Non-brand."""
    config = config or {}
    keep = keep or (lambda d: True)
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

    rows = _kw_qs_rows(engine, client_id, date_from, date_to)   # per-keyword, latest-in-range QS
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
        if not keep(d):
            continue
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


def _region_category(engine, client_id, config, keep=None, date_from=None, date_to=None, res=None):
    """Region & Category — for each Brand×Region×Category slice, avg CPC split by the
    keyword's component rating (Below / Average / Above) per QS component, with the
    Below−Above CPC spread. Prefers the region-segmented keyword export ('keyword_geo',
    region + spend) joined to search_keyword_qs (component ratings). When that export is
    absent, falls back to deriving each keyword's region from its geo-tiered campaign name
    (like the Regions view) so region-structured accounts still get the view — coarser than
    a true geo segment (`derived: true` in the result). None if neither source yields data."""
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        geo = c.execute(text("SELECT clicks, cost, row FROM raw_rows WHERE client_id=:c "
                             "AND report_type='keyword_geo'" + rc), {"c": client_id, **rp}).all()
        kqs = c.execute(text("SELECT cost, clicks, row FROM raw_rows WHERE client_id=:c "
                             "AND report_type='search_keyword_qs'" + rc), {"c": client_id, **rp}).all()
    used_geo = bool(geo)
    if not geo and not kqs:
        return None
    kw_ratings = {}
    for cost, clicks, row in kqs:
        d = _asdict(row); kw = (d.get("search_keyword") or "").lower()
        if kw:
            kw_ratings[kw] = {ck: _norm_rating(d.get(ck)) for ck, _, _ in QS_COMPONENTS}
    if used_geo and not kw_ratings:
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

    def add(region, kw, cost, clicks, ratings):
        if not kw or not region:
            return
        if brand_terms and any(b in kw.lower() for b in brand_terms):
            return                                    # non-brand only
        key = (brand_label, region, categorize(kw))
        s = slices.get(key)
        if s is None:
            s = slices[key] = {"total": 0.0, "comp": {ck: {r: [0.0, 0.0] for r in QS_RATINGS}
                                                      for ck, _, _ in QS_COMPONENTS}}
        s["total"] += cost
        if ratings:
            for ck, _, _ in QS_COMPONENTS:
                rating = ratings.get(ck)
                if rating:
                    b = s["comp"][ck][rating]; b[0] += cost; b[1] += clicks

    if used_geo:                                      # true per-keyword geography
        for clicks, cost, row in geo:
            d = _asdict(row)
            if not keep(d):
                continue
            kw = d.get("search_keyword")
            add(_region_value(d), kw, _num(cost), _num(clicks), kw_ratings.get((kw or "").lower()))
    else:                                             # fallback: region resolved from the campaign mapping
        res = res or _MapResolver([], config)
        for cost, clicks, row in kqs:
            d = _asdict(row)
            if not keep(d):
                continue
            kw = d.get("search_keyword")
            ratings = {ck: _norm_rating(d.get(ck)) for ck, _, _ in QS_COMPONENTS}
            add(res.region(d.get("campaign")), kw, _num(cost), _num(clicks), ratings)
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
    return {"components": components, "categories": cats, "regions": regs, "derived": not used_geo}


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


def _keyword_section(engine, client_id, keep=None, date_from=None, date_to=None):
    """Keyword Deep Dive (top keywords) + QS component breakdown (eCTR / Ad relevance /
    LP experience) with a modeled CPC-penalty savings estimate."""
    from collections import Counter
    keep = keep or (lambda d: True)
    rows = _kw_qs_rows(engine, client_id, date_from, date_to)   # per-keyword, latest-in-range QS
    if not rows:
        return None
    kws = []
    comp = {"exp_ctr": Counter(), "ad_relevance": Counter(), "landing_page_exp": Counter()}
    comp_sp = {"exp_ctr": Counter(), "ad_relevance": Counter(), "landing_page_exp": Counter()}
    below_ctr = 0.0
    for cost, clicks, impr, conv, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
        cost = _num(cost); clicks = _num(clicks); cv = _num(conv)
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


def _keyword_regions(engine, client_id, config, keep=None, date_from=None, date_to=None):
    """Keyword × region pivot for the Keyword Deep Dive heatmap, from a keyword report
    segmented by geography (report_type 'keyword_geo'). None if that segmented export
    hasn't been uploaded — the view then falls back to the flat keyword table."""
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT cost, clicks, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='keyword_geo'" + rc), {"c": client_id, **rp}).all()
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
        if not keep(d):
            continue
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


def _ads_section(engine, client_id, config=None, keep=None, date_from=None, date_to=None):
    """RSA inventory + CTR-graded ad performance (Ad Copy) and ad → landing-page pairing."""
    from collections import Counter
    config = config or {}
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
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
            "WHERE client_id=:c AND report_type='ads_performance'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    ads = []
    for clicks, impr, cost, conv, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
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
                    "cvr": round(cv / clicks, 4) if clicks else 0})
    if not ads:
        return None
    ads.sort(key=lambda x: (-x["cost"], x["ad_group"], x["headline"]))   # stable tie-break for the top-100 cutoff

    # Grade CTR (ad copy) + CVR (landing page) relative to each branded/non-branded cohort's
    # own median, static-band fallback for small cohorts / static mode. See engine/grading.py.
    mode, bm = _grading_cfg(config)

    def _grade_cohort(cohort, ctr_bench):
        ctr_g, ctr_meta = cohort_grader(
            cohort, rate=lambda a: a["ctr"],   # simple median (unweighted) for CTR
            in_scope=lambda a: a["impr"] >= 100,
            static_fn=lambda a: _grade_ad(a["ctr"], a["impr"], a["branded"]),
            bands=GRADE_BANDS, mode=mode, benchmark=ctr_bench)
        lp_g, lp_meta = cohort_grader(
            cohort, rate=lambda a: a["cvr"], weight=lambda a: a["clicks"],
            in_scope=lambda a: a["impr"] >= 100 and a["clicks"] >= 5,
            static_fn=lambda a: _grade_lp(a["cvr"], a["impr"], a["clicks"]),
            bands=GRADE_BANDS, mode=mode, benchmark=bm.get("lp_cvr"),
            zero_conv=lambda a: a["conv"] == 0 and a["clicks"] >= ZERO_CONV_CLICKS)
        for a in cohort:
            a["grade"] = ctr_g(a)
            a["lp_grade"] = lp_g(a)
        return {"ctr": ctr_meta, "lp": lp_meta}

    grading_meta = {False: _grade_cohort([a for a in ads if not a["branded"]], bm.get("ctr_nonbrand")),
                    True: _grade_cohort([a for a in ads if a["branded"]], bm.get("ctr_brand"))}

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

    nb_out = group_data([a for a in ads if not a["branded"]]) or None
    br_out = group_data([a for a in ads if a["branded"]]) or None
    if nb_out and nb_out["count"]:
        nb_out["grading"] = grading_meta[False]
    if br_out and br_out["count"]:
        br_out["grading"] = grading_meta[True]
    return {"count": len(ads), "ads": ads[:100],
            "ad_copy": {"thresholds": AD_THRESH_TEXT,
                        "nonbranded": nb_out if nb_out and nb_out["count"] else None,
                        "branded": br_out if br_out and br_out["count"] else None}}


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


def _nb_categories(engine, client_id, cm, config, keep=None, compare="yoy", res=None):
    """YoY non-brand spend/conversions by category, resolved through the central
    campaign mapping (name-heuristic fallback for unmapped campaigns), latest complete
    month vs same month prior year — with a prior-calendar-month fallback when the
    account has under a year of history, matching the KPI logic. Brand campaigns are
    excluded. None if there is no non-brand data."""
    if not cm:
        return None
    keep = keep or (lambda d: True)
    res = res or _MapResolver([], config)

    with engine.connect() as c:
        allrows = c.execute(text(
            "SELECT date, campaign, cost, conversions FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance'"), {"c": client_id}).all()
    order = _slash_order(r[0] for r in allrows)
    dateless = not any(_month_key(r[0], order) for r in allrows)

    def month_agg(target, allow_dateless):
        agg = defaultdict(lambda: [0.0, 0.0])  # spend, conv
        for date, camp, cost, conv in allrows:
            mk = _month_key(date, order)
            match = (mk[:2] == target) if mk else (allow_dateless and target == (cm["year"], cm["month"]))
            if not match or not keep({"campaign": camp}):
                continue
            cat = res.nb_category(camp)
            if cat is None:
                continue
            a = agg[cat]; a[0] += _num(cost); a[1] += _num(conv)
        return agg

    prior = _prior_month(cm) if compare in ("mom", "custom") else _yoy_prior(cm)
    cur_agg = month_agg((cm["year"], cm["month"]), dateless)
    pri_agg = month_agg((prior["year"], prior["month"]), False)
    if not cur_agg and not pri_agg:
        return None
    if not pri_agg and compare not in ("mom", "custom") and not dateless:   # < 1yr of history -> prior month
        prior = _prior_month(cm)
        pri_agg = month_agg((prior["year"], prior["month"]), False)

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


def _regions(engine, client_id, cm, config, keep=None, compare="yoy", res=None):
    """YoY non-brand spend/conversions by region, resolved through the central campaign
    mapping (geo-tier name parsing as fallback for unmapped campaigns). Returns per
    (region, category) cells so the frontend can filter by category; None if no
    region-attributed campaigns exist."""
    if not cm:
        return None
    keep = keep or (lambda d: True)
    res = res or _MapResolver([], config)

    with engine.connect() as c:
        allrows = c.execute(text(
            "SELECT date, campaign, cost, conversions FROM raw_rows WHERE client_id=:c "
            "AND report_type='campaign_performance'"), {"c": client_id}).all()
    order = _slash_order(r[0] for r in allrows)
    dateless = not any(_month_key(r[0], order) for r in allrows)

    def month_cells(target, allow_dateless):
        agg = defaultdict(lambda: [0.0, 0.0])  # (region, category) -> spend, conv
        for date, camp, cost, conv in allrows:
            mk = _month_key(date, order)
            match = (mk[:2] == target) if mk else (allow_dateless and target == (cm["year"], cm["month"]))
            if not match or not keep({"campaign": camp}):
                continue
            cat = res.nb_category(camp)
            if cat is None:                 # brand campaign
                continue
            region = res.region(camp)
            if region is None:              # account-wide ("All") / no region attribution
                continue
            a = agg[(region, cat)]; a[0] += _num(cost); a[1] += _num(conv)
        return agg

    prior = _prior_month(cm) if compare in ("mom", "custom") else _yoy_prior(cm)
    cur_agg = month_cells((cm["year"], cm["month"]), dateless)
    pri_agg = month_cells((prior["year"], prior["month"]), False)
    if not cur_agg and not pri_agg:
        return None
    if not pri_agg and compare not in ("mom", "custom") and not dateless:
        prior = _prior_month(cm)
        pri_agg = month_cells((prior["year"], prior["month"]), False)

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


def _lp_score(cvr, clicks):
    """Landing-page quality label from its conversion rate."""
    if clicks < 5:
        return "—"
    if cvr >= 0.45:
        return "Excellent"
    if cvr >= 0.30:
        return "Strong"
    if cvr >= 0.20:
        return "Average"
    return "Below Avg"


def _lp_performance(engine, client_id, config=None, keep=None, date_from=None, date_to=None):
    """Per landing-page cost/clicks/conv/CVR/CPA + quality Score, from ads grouped by
    final URL (the ads report is the only source that carries LP-level conversions). The
    Score is graded relative to this account's own landing-page CVR distribution (static
    bands as fallback). Returns {rows, grading} or None."""
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='ads_performance'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0])   # cost, clicks, conv
    for clicks, cost, conv, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
        url = d.get("ad_final_url") or d.get("final_url") or ""
        if not url:
            continue
        a = agg[url]; a[0] += _num(cost); a[1] += _num(clicks); a[2] += _num(conv)
    if not agg:
        return None
    out = []
    for url, (cost, clicks, conv) in sorted(agg.items(), key=lambda kv: -kv[1][0])[:50]:
        cvr = conv / clicks if clicks else 0
        out.append({"url": url, "cost": round(cost, 2), "clicks": round(clicks), "conv": round(conv, 1),
                    "cvr": round(cvr, 4), "cpa": round(cost / conv, 2) if conv else None})
    mode, bm = _grading_cfg(config)
    score_of, meta = cohort_grader(
        out, rate=lambda r: r["cvr"], weight=lambda r: r["clicks"],
        in_scope=lambda r: r["clicks"] >= 5, static_fn=lambda r: _lp_score(r["cvr"], r["clicks"]),
        bands=SCORE_BANDS, mode=mode, benchmark=bm.get("lp_cvr"),
        zero_conv=lambda r: r["conv"] == 0 and r["clicks"] >= ZERO_CONV_CLICKS)
    for r in out:
        r["score"] = score_of(r)
    return {"rows": out, "grading": meta}


def _lp_category_grid(engine, client_id, config, keep=None, date_from=None, date_to=None):
    """LP × category CVR matrix from ads grouped by final URL × ad category (an LP can
    serve several categories, each with its own conversion rate). Brand ads bucket to
    'BR'; the rest to their product category or 'Other'. None if no ad data."""
    from collections import Counter
    config = config or {}
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}

    def ad_category(url_text):
        n = url_text.lower()
        for c, kws in catkw.items():
            if c.lower() in n or any(w in n for w in kws):
                return (c[:1].upper() + c[1:])
        return "Other"

    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='ads_performance'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    cell = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0]))  # url -> cat -> clicks,conv,cost
    url_tot = defaultdict(lambda: [0.0, 0.0, 0.0])
    for clicks, cost, conv, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
        url = d.get("ad_final_url") or d.get("final_url") or ""
        if not url:
            continue
        clicks, cost, conv = _num(clicks), _num(cost), _num(conv)
        branded = bool(brand_terms and any(b in (d.get("campaign", "") + " " + d.get("ad_group", "")).lower() for b in brand_terms))
        cat = "BR" if branded else ad_category((d.get("ad_group", "") or "") + " " + (d.get("headline_1") or ""))
        cc = cell[url][cat]; cc[0] += clicks; cc[1] += conv; cc[2] += cost
        ut = url_tot[url]; ut[0] += clicks; ut[1] += conv; ut[2] += cost
    if not url_tot:
        return None

    cat_spend = Counter()
    for u in cell:
        for cat, v in cell[u].items():
            cat_spend[cat] += v[2]
    categories = [c for c, _ in cat_spend.most_common()]

    rows_out = []
    for url, (cl, cv, co) in sorted(url_tot.items(), key=lambda kv: -kv[1][2])[:100]:
        cats = cell[url]
        rows_out.append({"url": url, "cost": round(co, 2), "clicks": round(cl), "conv": round(cv, 1),
                         "overall_cvr": round(cv / cl, 4) if cl else 0, "n_cats": len(cats),
                         "cvr_by_cat": {cat: (round(v[1] / v[0], 4) if v[0] else None) for cat, v in cats.items()}})

    summary = []
    for cat in categories:
        entries = [(cell[u][cat][1] / cell[u][cat][0], u, cell[u][cat][2])
                   for u in cell if cat in cell[u] and cell[u][cat][0]]
        if not entries:
            continue
        entries.sort(key=lambda e: (e[0], e[1]))   # cvr, then url — deterministic best/worst on ties
        vals = [e[0] for e in entries]
        summary.append({"category": cat, "lps_running": len([u for u in cell if cat in cell[u]]),
                        "spend": round(sum(cell[u][cat][2] for u in cell if cat in cell[u]), 2),
                        "min_cvr": round(vals[0], 4), "median_cvr": round(vals[len(vals) // 2], 4),
                        "max_cvr": round(vals[-1], 4), "best_lp": entries[-1][1], "worst_lp": entries[0][1]})

    tc = sum(v[0] for v in url_tot.values()); tv = sum(v[1] for v in url_tot.values())
    tco = sum(v[2] for v in url_tot.values())
    return {"categories": categories, "rows": rows_out, "summary": summary, "total": len(url_tot),
            "stats": {"landing_pages": len(url_tot), "spend": round(tco, 2), "clicks": round(tc),
                      "conversions": round(tv, 1), "weighted_cvr": round(tv / tc, 4) if tc else 0,
                      "avg_cats": round(sum(len(cell[u]) for u in cell) / len(cell), 1)}}


def _landing_pages(engine, client_id, config, keep=None, date_from=None, date_to=None):
    """Landing-page performance (clicks/cost/CTR + mobile speed) + a URL-derived category
    grid. The LP export has no conversion or device column, so no CVR / device grid."""
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, impressions, cost, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='landing_pages'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0, None])
    for lp, clicks, impr, cost, row in rows:
        rd = _asdict(row)
        if not keep(rd):
            continue
        d = agg[lp or "(unknown)"]
        d[0] += _num(clicks); d[1] += _num(impr); d[2] += _num(cost)
        spd = rd.get("mobile_speed_score")          # a URL can appear on several days;
        if spd is not None and (d[3] is None or _num(spd) > _num(d[3])):
            d[3] = spd                              # keep the max so row order doesn't decide it
    full = [{"url": url, "clicks": round(cl), "impr": round(im), "cost": round(co, 2),
             "ctr": round(cl / im, 4) if im else 0, "speed": sp}
            for url, (cl, im, co, sp) in sorted(agg.items(), key=lambda kv: -kv[1][2])]
    return {"count": len(full), "rows": full[:50],
            "category_grid": _lp_categories(full, config.get("product_categories", []))}


def _search_terms_section(engine, client_id, config, keep=None, date_from=None, date_to=None):
    """Full Search Terms section: Intent & Grades, Relevant, Competitor, Flagged."""
    from collections import Counter
    from ..llm.relevance import get_or_classify
    keep = keep or (lambda d: True)
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, clicks, cost, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='search_terms'" + rc), {"c": client_id, **rp}).all()
    if not rows:
        return None
    brand_excl = [b.lower() for b in (config.get("brand_terms") or []) if b]
    _blank_added = (None, "", "None", "none")
    agg = {}
    for term, clicks, cost, conv, row in rows:
        tl = (term or "").lower()
        if brand_excl and any(b in tl for b in brand_excl):
            continue                                # non-brand analysis only
        d = _asdict(row)
        if not keep(d):
            continue
        # Day-segmented exports repeat a term across days (and across campaign / ad group /
        # keyword). Roll up per (term, campaign, ad group, keyword) so each combination shows
        # once with summed metrics instead of one row per day.
        camp, ag, kw = d.get("campaign"), d.get("ad_group"), d.get("search_keyword")
        key = (term or "", camp, ag, kw)
        t = agg.get(key)
        if t is None:
            t = {"term": term or "", "campaign": camp, "ad_group": ag, "search_keyword": kw,
                 "match": d.get("search_terms_match_type", ""), "added": d.get("added_excluded"),
                 "clicks": 0.0, "cost": 0.0, "conv": 0.0}
            agg[key] = t
        t["clicks"] += _num(clicks); t["cost"] += _num(cost); t["conv"] += _num(conv)
        ae = d.get("added_excluded")                # keep a real Added/Excluded over a blank "None"
        if ae not in _blank_added and t["added"] in _blank_added:
            t["added"] = ae
    terms = list(agg.values())
    if not terms:
        return None
    # Grade terms by conversion rate relative to this account's non-brand term cohort
    # (static bands fallback for small cohorts / static mode). See engine/grading.py.
    _gmode, _gbm = _grading_cfg(config)
    _term_grade, _term_grading = cohort_grader(
        terms, rate=lambda t: (t["conv"] / t["clicks"] if t["clicks"] else 0), weight=lambda t: t["clicks"],
        in_scope=lambda t: t["clicks"] >= 5, static_fn=_grade_term,
        bands=GRADE_BANDS, mode=_gmode, benchmark=_gbm.get("term_cvr"),
        zero_conv=lambda t: t["conv"] == 0 and t["clicks"] >= ZERO_CONV_CLICKS)
    for t in terms:
        t["grade"] = _term_grade(t)

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
    comp_matched = sorted([t for t in terms if t.get("competitor")], key=lambda x: (-x["cost"], x["term"]))
    competitor_terms = [{"term": t["term"], "competitor": t["competitor"],
                         "campaign": t.get("campaign"), "ad_group": t.get("ad_group"),
                         "search_keyword": t.get("search_keyword"), "spend": round(t["cost"], 2),
                         "clicks": round(t["clicks"]), "conv": round(t["conv"], 1),
                         "cvr": round(t["conv"] / t["clicks"], 4) if t["clicks"] else 0,
                         "cpa": round(t["cost"] / t["conv"], 2) if t["conv"] else None} for t in comp_matched[:75]]

    STATUS_ORDER = ["Recommend to Add", "Already Added", "Review", "Excluded", "Unassigned"]
    keyword_status = [{"status": s, "terms": st_c[s], "spend": round(st_s[s], 2),
                       "spend_share": round(st_s[s] / total_spend, 4) if total_spend else 0}
                      for s in STATUS_ORDER]

    rel_sorted = sorted([t for t in terms if t["seg"] == "Relevant"], key=lambda x: -x["cost"])
    relevant_terms = [{"term": t["term"], "category": t["cat"] or "Uncategorized", "grade": t["grade"],
                       "campaign": t.get("campaign"), "ad_group": t.get("ad_group"),
                       "search_keyword": t.get("search_keyword"),
                       "status": t["status"], "spend": round(t["cost"], 2), "clicks": round(t["clicks"]),
                       "conv": round(t["conv"], 1), "cvr": round(t["conv"] / t["clicks"], 4) if t["clicks"] else 0,
                       "cpc": round(t["cost"] / t["clicks"], 2) if t["clicks"] else 0} for t in rel_sorted[:150]]
    rel_categories = sorted({r["category"] for r in relevant_terms if r["category"] != "Uncategorized"})

    # secondary sort by term so the top-75 cutoff is deterministic — many "Needs Review"
    # terms are zero-spend and tie on cost, and input row order isn't guaranteed.
    flag_sorted = sorted([t for t in terms if t["seg"] == "Needs Review"],
                         key=lambda x: (-x["cost"], x["term"]))
    flagged_terms = [{"term": t["term"], "intent": t["seg"], "status": t["status"],
                      "campaign": t.get("campaign"), "ad_group": t.get("ad_group"),
                      "search_keyword": t.get("search_keyword"), "spend": round(t["cost"], 2),
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
        "grades_grading": _term_grading,
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


_FILTER_TEXT_FIELDS = ("campaign", "ad_group", "search_keyword", "search_term",
                       "landing_page", "ad_final_url", "final_url", "state_matched")


def _row_text(d):
    return " ".join(str(d.get(f) or "") for f in _FILTER_TEXT_FIELDS).lower()


def _row_filter(filters, config, engine=None, client_id=None, res=None):
    """Build a keep(row_dict) predicate for the global topbar filters.

    Attribution is MAPPING-FIRST: when a row's campaign is in the central campaign
    mapping (engine/mapping.py), its brand / region / category / segment come from
    there. Unmapped campaigns — and rows carrying no campaign at all — fall back to
    the original text/geo heuristics. Most exports carry only some of the filter
    dimensions, so we bridge through ad_group where possible: ad_group_performance
    maps ad_group -> campaign, and the geographic report maps ad_group -> region.
    A filter is only skipped for a row when there is genuinely no way to resolve it."""
    filters = filters or {}
    seg = (filters.get("seg") or "all").lower()
    campaign = filters.get("campaign") or "all"
    region = filters.get("region") or "all"
    category = filters.get("category") or "all"
    brand = filters.get("brand") or "all"
    ctype = filters.get("type") or "all"
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    catkw = {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
             for c in (config.get("product_categories") or [])}
    active = any(x != "all" for x in (seg, campaign, region, category, brand, ctype))
    res = res or _MapResolver([], config)
    mapping_regions = set(res.regions)

    def is_brand(txt):
        return bool(brand_terms and any(b in txt for b in brand_terms))

    def cat_of(txt):
        for c, kws in catkw.items():
            if c.lower() in txt or any(w in txt for w in kws):
                return c[:1].upper() + c[1:]
        return None

    # ---- ad_group bridges (ad_group -> campaign, ad_group -> region) ----
    ag2camp, region_ags, region_camps = {}, None, None
    if active and engine is not None and client_id:
        with engine.connect() as c:
            for ag, camp in c.execute(text(
                "SELECT DISTINCT ad_group, campaign FROM raw_rows WHERE client_id=:c "
                "AND report_type='ad_group_performance'"), {"c": client_id}):
                if ag:
                    ag2camp[ag] = camp
        if region != "all" and region not in mapping_regions:
            region_ags = set()
            with engine.connect() as c:
                for ag, row in c.execute(text(
                    "SELECT ad_group, row FROM raw_rows WHERE client_id=:c "
                    "AND report_type='geographic'"), {"c": client_id}):
                    if ag and _region_value(_asdict(row)) == region:
                        region_ags.add(ag)
            # ad_group -> campaign lets the region filter also reach campaign-keyed rows
            region_camps = {ag2camp[a] for a in region_ags if a in ag2camp}

    def keep(d):
        if not active:
            return True
        camp = d.get("campaign") or ag2camp.get(d.get("ad_group") or "")
        mapped = camp is not None and res.known(camp)
        if ctype != "all":                          # campaign-type filter (mapping camp_type)
            t = res.camp_type(camp) if camp else None
            if t is not None and t.strip().lower() != ctype.strip().lower():
                return False
        if campaign != "all":
            if d.get("campaign"):
                if d["campaign"] != campaign:
                    return False
            else:                                   # bridge: ad_group -> campaign
                ag = d.get("ad_group")
                if ag and ag in ag2camp and ag2camp[ag] != campaign:
                    return False
        txt = _row_text(d)
        if seg != "all":
            is_b = res.is_brand(camp) if mapped else is_brand(txt)
            if seg == "br" and not is_b:
                return False
            if seg == "nb" and is_b:
                return False
        if brand != "all":
            mb = (res.brand(camp) or "") if mapped else ""
            if mb:
                if mb.strip().lower() != brand.strip().lower():
                    return False
            elif brand.lower() not in txt:
                return False
        if category != "all":
            if mapped:
                if (res.category(camp) or "").strip().lower() != category.strip().lower():
                    return False
            else:
                c = cat_of(txt)
                if c is not None and c != category:
                    return False
        if region != "all":
            if region in mapping_regions:           # a mapping-defined region slice
                if mapped:
                    mr = res.region(camp)           # None == "All" -> serves every region
                    if mr is not None and mr != region:
                        return False
                # unmapped campaign under a mapping-region filter: no way to place it -> keep
            else:                                   # a geo value (state etc.) -> legacy paths
                rv = _region_value(d)
                if rv is not None:
                    if rv != region:
                        return False
                elif region_ags is not None:
                    ag = d.get("ad_group")
                    if ag:                                      # bridge: ad_group -> region
                        if ag not in region_ags:
                            return False
                    else:                                       # bridge: campaign -> region
                        if d.get("campaign") and region_camps and d["campaign"] not in region_camps:
                            return False
        return True

    return keep, active


def _filters_meta(engine, client_id, config, res=None):
    """Option lists for the topbar filter dropdowns. The central campaign mapping's
    vocabulary comes first (its regions/categories/brands are what the mapping-first
    filter matches); geo values and config products fill in behind it."""
    res = res or _MapResolver([], config)
    with engine.connect() as c:
        campaigns = [r[0] for r in c.execute(text(
            "SELECT DISTINCT campaign FROM raw_rows WHERE client_id=:c AND campaign IS NOT NULL "
            "AND campaign<>'' ORDER BY campaign"), {"c": client_id}) if r[0]]
        geo_regions = set()
        for (row,) in c.execute(text("SELECT row FROM raw_rows WHERE client_id=:c "
                                     "AND report_type IN ('geographic','keyword_geo')"), {"c": client_id}):
            rv = _region_value(_asdict(row))
            if rv:
                geo_regions.add(rv)
    regions = res.regions + sorted(geo_regions - set(res.regions))
    cfg_cats = [c[:1].upper() + c[1:] for c in (config.get("product_categories") or [])]
    categories = res.categories + [c for c in cfg_cats if c not in set(res.categories)]
    brand_label = (config.get("brand_terms") or [None])[0] or _client_name(engine, client_id)
    brands = res.brands or ([brand_label] if brand_label else [])
    return {"campaigns": campaigns[:300], "regions": regions,
            "categories": categories, "brands": brands, "types": res.types}


def _auction_insights_section(engine, client_id, date_from=None, date_to=None):
    """Competitor share-of-voice from the Auction Insights export (per day × campaign ×
    domain). Each share metric is IMPRESSION-WEIGHTED per domain, not averaged: the
    weight is our own campaign impressions for that (campaign, day) — Google reports a
    competitor's share only over the auctions we were eligible for, so our impression
    count is the shared denominator. Falls back to an equal-weighted average for a
    domain when no (campaign, day) impressions can be joined (e.g. campaign_performance
    not yet re-uploaded at day level). The date range narrows both the AI rows and the
    campaign weights so the two stay aligned. Returns {rows, count, weighted} or None."""
    rc, rp = _range_sql(date_from, date_to)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, campaign, date_norm, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='auction_insights'" + rc), {"c": client_id, **rp}).all()
        if not rows:
            return None
        our_impr = defaultdict(float)   # (campaign, day) -> our impressions
        for camp, dn, impr in c.execute(text(
                "SELECT campaign, date_norm, impressions FROM raw_rows "
                "WHERE client_id=:c AND report_type='campaign_performance'" + rc), {"c": client_id, **rp}):
            if impr:
                our_impr[(camp, dn)] += float(impr)

    FIELDS = {
        "impr_share": "search_impr_share_auction_insights",
        "overlap_rate": "search_overlap_rate",
        "position_above": "position_above_rate",
        "top_of_page": "top_of_page_rate",
        "outranking": "search_outranking_share",
    }
    wsum = defaultdict(lambda: {k: [0.0, 0.0] for k in FIELDS})   # [Σ share*w, Σ w]
    flat = defaultdict(lambda: {k: [0.0, 0] for k in FIELDS})     # fallback [Σ share, count]
    any_weighted = False
    for ent, camp, dn, row in rows:
        d = _asdict(row)
        domain = (ent or d.get("display_url_domain") or "").strip()
        if not domain:
            continue
        w = our_impr.get((camp, dn), 0.0)
        if w > 0:
            any_weighted = True
        aw, af = wsum[domain], flat[domain]
        for key, slug in FIELDS.items():
            frac = impr_share_frac(d.get(slug))
            if frac is None:
                continue
            if w > 0:
                aw[key][0] += frac * w
                aw[key][1] += w
            af[key][0] += frac
            af[key][1] += 1
    if not flat:
        return None

    def value(domain, key):
        sw, w = wsum[domain][key]
        if w > 0:
            return round(sw / w, 4)
        s, n = flat[domain][key]                 # no joinable impressions -> equal-weighted
        return round(s / n, 4) if n else None

    out = [{"domain": dom, **{k: value(dom, k) for k in FIELDS}} for dom in flat]
    out.sort(key=lambda r: (r["impr_share"] is None, -(r["impr_share"] or 0)))
    return {"rows": out, "count": len(out), "weighted": any_weighted}


_UNIT_SLUGS = ("product_quantity", "units_sold", "purchased_quantity", "qty_sold", "units", "product_units_sold")


def _products_sold(engine, client_id, keep=None):
    """Top products actually sold, from the Products Sold export (product title + conversions
    + conv value, and units when the export carries a quantity column). None if absent."""
    keep = keep or (lambda d: True)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT entity, conversions, conv_value, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='products_sold'"), {"c": client_id}).all()
    if not rows:
        return None
    agg = defaultdict(lambda: [0.0, 0.0, 0.0])   # conv, value, units
    for ent, conv, val, row in rows:
        d = _asdict(row)
        if not keep(d):
            continue
        title = ent or d.get("product_title_sold") or d.get("item_id_sold") or "(unknown)"
        units = _num(next((d[s] for s in _UNIT_SLUGS if d.get(s) is not None), None))
        a = agg[title]; a[0] += _num(conv); a[1] += _num(val); a[2] += units
    if not agg:
        return None
    # rank by revenue, then units, then conversions — so accounts that track units but not
    # conversion value (common) still get a meaningful ordering.
    out = [{"product": p, "conv": round(cv, 1), "conv_value": round(v, 2), "units": round(u, 1)}
           for p, (cv, v, u) in sorted(agg.items(), key=lambda kv: (-kv[1][1], -kv[1][2], -kv[1][0]))][:75]
    tot = [sum(x) for x in zip(*[[r["conv"], r["conv_value"], r["units"]] for r in out])]
    return {"rows": out, "total_products": len(agg), "has_units": any(r["units"] for r in out),
            "totals": {"conv": round(tot[0], 1), "conv_value": round(tot[1], 2), "units": round(tot[2], 1)}}


def _shopping_section(engine, client_id, cm, config, keep=None, res=None, compare="yoy"):
    """Shopping + Performance Max module (S1): per-campaign spend / conversions / value / CPA /
    ROAS for Shopping & PMax campaigns (identified by the central mapping's camp_type), the
    module's share of total account spend, a monthly trend, and top products sold. None when
    the account runs no Shopping/PMax campaigns (the module hides for lead-gen accounts)."""
    if not cm:
        return None
    keep = keep or (lambda d: True)
    res = res or _MapResolver([], config)
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT date, campaign, cost, conversions, conv_value, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='campaign_performance'"), {"c": client_id}).all()
    if not any(r[1] and res.is_shopping(r[1]) for r in rows):
        return None
    order = _slash_order(r[0] for r in rows)
    dateless = not any(_month_key(r[0], order) for r in rows)
    cur_t = (cm["year"], cm["month"])

    per = {}                                         # shopping campaign -> [cost, conv, value] (current month)
    acct_cost = 0.0                                  # whole-account cost this month (for share)
    monthly = defaultdict(lambda: [0.0, 0.0, 0.0])   # (y, m) -> shopping cost / conv / value
    for date, camp, cost, conv, val, row in rows:
        if not camp or not keep(_asdict(row)):
            continue
        cost, conv, val = _num(cost), _num(conv), _num(val)
        mk = _month_key(date, order)
        in_cur = (mk[:2] == cur_t) if mk else dateless
        shopping = res.is_shopping(camp)
        if in_cur:
            acct_cost += cost
            if shopping:
                e = per.setdefault(camp, [0.0, 0.0, 0.0]); e[0] += cost; e[1] += conv; e[2] += val
        if shopping and (mk or dateless):
            m = monthly[mk[:2] if mk else cur_t]; m[0] += cost; m[1] += conv; m[2] += val

    rows_out = [{"campaign": (camp or "").split("|")[-1].strip() or camp, "type": res.camp_type(camp) or "—",
                 "cost": round(cost, 2), "conv": round(conv, 1), "conv_value": round(val, 2),
                 "cpa": round(cost / conv, 2) if conv else 0, "roas": round(val / cost, 2) if cost else 0}
                for camp, (cost, conv, val) in sorted(per.items(), key=lambda kv: -kv[1][0])]
    tc = sum(r["cost"] for r in rows_out); tv = sum(r["conv_value"] for r in rows_out)
    tn = sum(r["conv"] for r in rows_out)
    totals = {"cost": round(tc, 2), "conv": round(tn, 1), "conv_value": round(tv, 2),
              "cpa": round(tc / tn, 2) if tn else 0, "roas": round(tv / tc, 2) if tc else 0}
    trend = [{"Month": f"{y}-{mo:02d}", "Spend": round(v[0], 2), "Main Conv": round(v[1], 1),
              "conv_value": round(v[2], 2), "roas": round(v[2] / v[0], 2) if v[0] else 0}
             for (y, mo), v in sorted(monthly.items()) if (y, mo) <= cur_t][-12:]
    return {"has_shopping": True,
            "overview": {"month": cm["abbr"], "rows": rows_out, "totals": totals,
                         "account_cost": round(acct_cost, 2),
                         "share": round(tc / acct_cost, 4) if acct_cost else 0, "trend": trend},
            "products": _products_sold(engine, client_id, keep)}


def build_bundle(client_id, engine=None, date_from=None, date_to=None, filters=None,
                 compare="yoy", compare_from=None, compare_to=None):
    """Return the DATA bundle dict for a client, or None if there's no campaign data.
    date_from/date_to (YYYY-MM or YYYY-MM-DD) filter the month-grained series/KPIs; the global
    `filters` (seg/campaign/region/category/brand) re-compute every section server-side."""
    engine = engine or get_engine()
    rng_from, rng_to = _ym_bound(date_from), _ym_bound(date_to)
    config = get_config(client_id, engine) or {}
    # The central campaign mapping resolves brand/region/category for every view;
    # unmapped campaigns fall back to the name/config heuristics inside the resolver.
    res = _build_resolver(engine, client_id, config)
    keep, _flt_active = _row_filter(filters, config, engine, client_id, res)
    with engine.connect() as c:
        has = c.execute(text("SELECT COUNT(*) FROM raw_rows WHERE client_id=:c AND report_type='campaign_performance'"),
                        {"c": client_id}).scalar()
        if not has:
            return None

        # ---- monthly aggregates -> total_trend (row-level so the global filter applies) ----
        allrows = c.execute(text(
            "SELECT date, cost, clicks, conversions, row FROM raw_rows "
            "WHERE client_id=:c AND report_type='campaign_performance'"),
            {"c": client_id}).all()
        order = _slash_order(r[0] for r in allrows)
        magg = defaultdict(lambda: [0.0, 0.0, 0.0])
        for date, cost, clicks, conv, row in allrows:
            mk = _month_key(date, order)
            if not mk or not keep(_asdict(row)):
                continue
            m = magg[mk]; m[0] += float(cost or 0); m[1] += float(clicks or 0); m[2] += float(conv or 0)
        series = [(mk, v[0], v[1], v[2]) for mk, v in magg.items()]
        series.sort(key=lambda x: (x[0][0], x[0][1]))

        # A campaign_performance export with no parseable Month (no time segment, or a
        # format we don't recognize) yields no series — fall back to a single snapshot
        # for the export window so Business/Budget/Campaign still populate (no trend).
        dateless = not series

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
        elif dateless and cm:           # synthesize one period from the whole snapshot
            agg = [0.0, 0.0, 0.0]
            for date, cost, clicks, conv, row in allrows:
                if not keep(_asdict(row)):
                    continue
                agg[0] += float(cost or 0); agg[1] += float(clicks or 0); agg[2] += float(conv or 0)
            mk = (cm["year"], cm["month"], cm["ym"], cm["abbr"])
            series = [(mk, agg[0], agg[1], agg[2])]

        total_trend = [{
            "Month": mk[2],
            "Spend": round(cost, 2),
            "Clicks": round(clicks),
            "Main Conv": round(conv, 1),
            "CPA": round(cost / conv, 2) if conv else 0,
            "CVR": round(conv / clicks, 4) if clicks else 0,
        } for (mk, cost, clicks, conv) in series]

        # ---- KPI scorecard: current month vs a comparison period (YoY / MoM / Custom) ----
        compare = (compare or "yoy").lower()
        cmp_from, cmp_to = _ym_bound(compare_from), _ym_bound(compare_to)
        kpis, meta_periods = [], {}
        if series:
            by_key = {mk[2]: (cost, clicks, conv) for (mk, cost, clicks, conv) in series}
            cur_mk = series[-1][0]
            cur_label = cur_mk[3]
            cc, ccl, ccv = by_key[cur_mk[2]]

            if compare == "custom" and (cmp_from or cmp_to):
                lo = cmp_from or (0, 0)
                hi = cmp_to or (9999, 12)
                psel = [s for s in series if lo <= s[0][:2] <= hi and s[0][2] != cur_mk[2]]
                pc = sum(s[1] for s in psel); pcl = sum(s[2] for s in psel); pcv = sum(s[3] for s in psel)
                if psel:
                    prior_mk_label = psel[0][0][3] + ("–" + psel[-1][0][3] if len(psel) > 1 else "")
                else:
                    prior_mk_label = "—"
            elif compare == "mom":
                pmk = series[-2][0] if len(series) >= 2 else None
                pc, pcl, pcv = by_key.get(pmk[2], (0, 0, 0)) if pmk else (0, 0, 0)
                prior_mk_label = pmk[3] if pmk else "—"
            else:                                    # yoy (default): same month prior year, else prior month
                compare = "yoy"
                yk = f"{cur_mk[0]-1}-{cur_mk[1]:02d}"
                if yk in by_key:
                    pc, pcl, pcv = by_key[yk]; prior_mk_label = f"{MABBR[cur_mk[1]-1]} {cur_mk[0]-1}"
                elif len(series) >= 2:
                    pmk = series[-2][0]; pc, pcl, pcv = by_key[pmk[2]]; prior_mk_label = pmk[3]
                else:
                    pc, pcl, pcv = 0, 0, 0; prior_mk_label = "—"
            meta_periods = {"current": cur_label, "prior": prior_mk_label}

            # Day-range selections: recompute current vs prior from DAILY data so the KPI
            # scorecard reflects the exact selected window rather than its containing month.
            # Prior period = same window prior year (yoy) / immediately-preceding equal-length
            # window (mom) / the custom range. Only fires for a day-precise selection with
            # daily campaign data; month selections keep the calendar-month comparison above.
            if _has_day(date_from) or _has_day(date_to):
                span = c.execute(text(
                    "SELECT MIN(date_norm), MAX(date_norm) FROM raw_rows WHERE client_id=:c "
                    "AND report_type='campaign_performance' AND date_norm IS NOT NULL"),
                    {"c": client_id}).first()
                span_lo, span_hi = _as_date(span[0]), _as_date(span[1])
                cur_lo = _as_date(_date_bound(date_from, end=False)) or span_lo
                cur_hi = _as_date(_date_bound(date_to, end=True)) or span_hi
                if span_lo and cur_lo and cur_hi and cur_lo <= cur_hi:
                    if compare == "custom" and (compare_from or compare_to):
                        pri_lo = _as_date(_date_bound(compare_from, end=False)) or span_lo
                        pri_hi = _as_date(_date_bound(compare_to, end=True)) or (cur_lo - datetime.timedelta(days=1))
                    elif compare == "yoy":
                        pri_lo, pri_hi = _shift_year(cur_lo, -1), _shift_year(cur_hi, -1)
                    else:                                      # mom -> preceding equal-length window
                        pri_hi = cur_lo - datetime.timedelta(days=1)
                        pri_lo = pri_hi - (cur_hi - cur_lo)
                    cc, ccl, ccv = _cp_range_sums(c, client_id, keep, cur_lo, cur_hi)
                    pc, pcl, pcv = _cp_range_sums(c, client_id, keep, pri_lo, pri_hi)
                    cur_label = f"{cur_lo.isoformat()} – {cur_hi.isoformat()}"
                    prior_mk_label = f"{pri_lo.isoformat()} – {pri_hi.isoformat()}"
                    meta_periods = {"current": cur_label, "prior": prior_mk_label}

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

    # Day-level bounds for the snapshot builders (Search Terms / Geo / Ad Copy / LPs).
    # Rows without a date_norm (report not yet re-uploaded at day level) are kept, so
    # those tabs show their whole window until daily data arrives.
    d_from, d_to = _date_bound(date_from, end=False), _date_bound(date_to, end=True)

    # The analyzers + all section builders are independent (each opens its own connection).
    # Run them concurrently when reads go to BigQuery so their queries overlap instead of
    # running one-by-one; a plain-Postgres/SQLite engine runs them sequentially.
    _none = lambda: None
    _tasks = {
        "analyzers": (lambda: run_analyzers(engine, client_id, cm, config)) if cm else (lambda: []),
        "campaigns": (lambda: _campaigns(engine, client_id, cm, keep, dateless)) if cm else _none,
        "geo": lambda: _geo(engine, client_id, keep, d_from, d_to),
        "budget": (lambda: _budget(engine, client_id, cm, config, keep, dateless)) if cm else _none,
        "reconciliation": (lambda: _budget_reconciliation(engine, client_id, cm, config, dateless)) if cm else _none,
        "qscore": lambda: _quality_score(engine, client_id, cm, config, keep, d_from, d_to),
        "qs_break": lambda: _qs_breakdown(engine, client_id, cm, config, keep, d_from, d_to),
        "keyword": lambda: _keyword_section(engine, client_id, keep, d_from, d_to),
        "kw_regions": lambda: _keyword_regions(engine, client_id, config, keep, d_from, d_to),
        "reg_cat": lambda: _region_category(engine, client_id, config, keep, d_from, d_to, res),
        "st": lambda: _search_terms_section(engine, client_id, config, keep, d_from, d_to),
        "ads": lambda: _ads_section(engine, client_id, config, keep, d_from, d_to),
        "lps": lambda: _landing_pages(engine, client_id, config, keep, d_from, d_to),
        "lp_perf": lambda: _lp_performance(engine, client_id, config, keep, d_from, d_to),
        "lp_category_grid": lambda: _lp_category_grid(engine, client_id, config, keep, d_from, d_to),
        "nb_cats": (lambda: _nb_categories(engine, client_id, cm, config, keep, compare, res)) if cm else _none,
        "regions": (lambda: _regions(engine, client_id, cm, config, keep, compare, res)) if cm else _none,
        "shopping": (lambda: _shopping_section(engine, client_id, cm, config, keep, res, compare)) if cm else _none,
    }
    R = _run_sections(_tasks, parallel=bq.active())

    # ---- analyzers -> findings + recommendations ----
    analyzer_findings = R["analyzers"]
    findings = _to_overview_findings(analyzer_findings)
    recommendations = _to_recommendations(analyzer_findings, client_id)
    # read-only join of the decision-system lifecycle so Brief/Actions can honour
    # accept/dismiss/snooze without a second call (cache cleared on any transition)
    from ..decisions.service import load_action_status
    _status = load_action_status(engine, client_id)
    for _r in recommendations:
        _st = _status.get(_r.get("action_key"))
        _r["status"] = _st["status"] if _st else "proposed"
        _r["owner"] = _st["owner"] if _st else None
        _r["snooze_until"] = _st["snooze_until"] if _st else None

    campaigns = R["campaigns"]
    geo = R["geo"]
    budget = R["budget"]
    budget_sec = _budget_section(config)
    budget_sec["reconciliation"] = R["reconciliation"]
    qscore = R["qscore"]
    qs_break = R["qs_break"]
    keyword = R["keyword"]
    kw_regions = R["kw_regions"]
    reg_cat = R["reg_cat"]
    st = R["st"]
    if st is not None:
        # the search-terms export has no campaign/ad_group column, so those filters
        # cannot be resolved for this report — tell the UI rather than silently ignoring
        st["filters_ignored"] = [k for k in ("campaign", "region")
                                 if (filters or {}).get(k) not in (None, "", "all")]
    ads = R["ads"]
    lps = R["lps"]
    lp_perf = R["lp_perf"]                       # {"rows":[...], "grading":{...}} or None
    lp_rows = lp_perf["rows"] if lp_perf else None
    if lps is None and lp_rows:
        lps = {"count": len(lp_rows), "rows": [], "category_grid": None}
    if lps is not None:
        lps["performance"] = lp_rows
        lps["performance_grading"] = lp_perf["grading"] if lp_perf else None
        lps["category_grid"] = R["lp_category_grid"]
    nb_cats = R["nb_cats"]
    regions = R["regions"]
    shopping = R["shopping"]

    # Performance section — mirrors the reference nav order (Overview, Monthly Trends,
    # NB Categories, Regions, Campaign, Budget). NB Categories and Regions are both
    # campaign-derived YoY (the date-segmented source). All Brands / Brand Detail are
    # multi-brand only and never populate for a single-brand account, so they are absent.
    view_list = ["overview", "trends"]
    if nb_cats:
        view_list.append("nb-cats")
    if regions:
        view_list.append("regions")
    view_list += ["campaign-perf", "budget-intel", "budget", "pacing", "budget-input"]
    if shopping:
        view_list.append("shopping-overview")
        if shopping.get("products"):
            view_list.append("products-sold")
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
    view_list.append("auction-insights")   # Competition module (scaffold; data feature to come)
    view_list.append("recs")

    # Which tabs actually honour the date range = the always-dated campaign views plus
    # any snapshot report that has been re-uploaded at day level (has a date_norm). Tabs
    # not listed here still show their whole window and get the "whole-window" note.
    with engine.connect() as c:
        dated_reports = {r for (r,) in c.execute(text(
            "SELECT DISTINCT report_type FROM raw_rows WHERE client_id=:c AND date_norm IS NOT NULL"),
            {"c": client_id})}
        dvals = [_as_date(r[0]) for r in c.execute(text(
            "SELECT DISTINCT date_norm FROM raw_rows WHERE client_id=:c AND date_norm IS NOT NULL"),
            {"c": client_id})]
    # Finest granularity of the client's dated data — drives which date presets the UI
    # offers (a monthly client can't answer "yesterday"). Monthly = every date is a month
    # 1st; weekly = every date shares one weekday; otherwise daily.
    dvals = [d for d in dvals if d]
    if not dvals:
        granularity = "none"
    elif all(d.day == 1 for d in dvals):
        granularity = "monthly"
    elif len(dvals) >= 2 and len({d.weekday() for d in dvals}) == 1:
        granularity = "weekly"
    else:
        granularity = "daily"
    REPORT_VIEWS = {
        "search_terms": ("st-intent", "st-relevant", "st-competitor", "st-flagged"),
        "geographic": ("geo-perf",),
        "ads_performance": ("ad-copy", "ad-lp", "lp-perf", "lp-category"),
        "landing_pages": ("lp-perf", "lp-category"),
        "search_keyword_qs": ("kw-deep-dive", "qs-detail", "qs-breakdown"),
        "keyword_geo": ("region-category", "kw-deep-dive"),
        "auction_insights": ("auction-insights",),
    }
    windowed = {"overview", "trends", "campaign-perf", "pacing", "nb-cats", "regions"}
    for rt, views in REPORT_VIEWS.items():
        if rt in dated_reports:
            windowed.update(views)

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
                # finest resolution of the client's dated data: daily | weekly | monthly | none
                "granularity": granularity,
                # views that honour the range: campaign-based (always) + any snapshot
                # report re-uploaded at day level; the rest are whole-window (see note)
                "windowed_views": sorted(windowed),
            },
            "filters": {"seg": (filters or {}).get("seg") or "all", "campaign": (filters or {}).get("campaign") or "all",
                        "region": (filters or {}).get("region") or "all", "category": (filters or {}).get("category") or "all",
                        "brand": (filters or {}).get("brand") or "all", "type": (filters or {}).get("type") or "all",
                        "active": _flt_active},
            "compare": {"mode": compare, "from": compare_from, "to": compare_to,
                        "label": {"yoy": "YoY", "mom": "MoM", "custom": "vs " + (meta_periods.get("prior") or "custom")}.get(compare, "YoY")},
            "filters_meta": _filters_meta(engine, client_id, config, res),
            # central mapping review state: {pending, total} — drives the "new
            # campaigns need mapping review" notification in the UI
            "mapping": _mapping_pending(engine, client_id),
            "generated_from": "warehouse",
        },
        "total_trend": total_trend,
        "kpis": kpis,
        "findings": findings,
        "recommendations": recommendations,
        "campaigns": campaigns,
        "geo_performance": geo,
        "budget_pacing": budget,
        "budget_section": budget_sec,
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
        "shopping_section": shopping,
        "auction_insights_section": _auction_insights_section(engine, client_id, d_from, d_to),
    }
