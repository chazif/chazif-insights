#!/usr/bin/env python3
"""Budget Intelligence service layer: warehouse -> cells -> allocation runs.

Reads the existing Layer-1 warehouse (engine/ingest/store.py raw_rows) through
bi_campaign_mappings, merges bi_business_metrics, and persists allocation runs.
All queries are client_id-isolated. No LLM anywhere in this module.
"""
import datetime
import json
from collections import defaultdict

from sqlalchemy import select, insert, delete, text

from .model import Cell, mround
from .tables import (campaign_mappings, business_metrics, simulator_snapshots,
                     allocation_runs, allocation_results, predictions,
                     goal_config, goal_values, guard_config)
from .curves import (get_active_curves, spend_curve_from_master,
                     spend_curve_from_points, sum_curves, pool)
from .allocate import run_allocation, run_allocation_v2

# Google conversion rungs (always available; present on every campaign row) and the
# business rungs (available per client only when data exists). main_conv is the curve.
GOOGLE_RUNGS = ("main_conv", "all_conv")
BUSINESS_RUNGS = ("transactions", "customers", "new_customers", "revenue")
# Legacy goal names accepted by create_run, mapped onto V2 rungs (back-compat).
LEGACY_GOAL_ALIAS = {"car_count": "transactions", "gp": "transactions", "revenue": "revenue"}


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _jrow(v):
    """raw_rows.row via text() SQL arrives as a dict (BQ JSON / PG jsonb) or a
    JSON string (SQLite) — and double-encoded when a caller stored a pre-dumped
    string through the JSON column type. Decode until it's a dict."""
    for _ in range(2):
        if not isinstance(v, str):
            break
        try:
            v = json.loads(v)
        except (ValueError, TypeError):
            return {}
    return v if isinstance(v, dict) else {}


# ---- mappings --------------------------------------------------------------

def upsert_mappings(engine, client_id, rows):
    """rows: [{campaign, brand, region, category, engine?, camp_type?}].
    Full-row replace per campaign (idempotent)."""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            c.execute(delete(campaign_mappings).where(
                (campaign_mappings.c.client_id == client_id)
                & (campaign_mappings.c.campaign == r["campaign"])))
            c.execute(insert(campaign_mappings).values(
                client_id=client_id, campaign=r["campaign"],
                brand=r.get("brand"), region=r.get("region"),
                category=r.get("category"), engine=r.get("engine"),
                camp_type=r.get("camp_type"), updated_at=now))
    return len(rows)


def get_mappings(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(campaign_mappings).where(
            campaign_mappings.c.client_id == client_id)).mappings().all()
    return [dict(r) for r in rows]


def suggest_mapping(campaign):
    """Parse BRAND_ENGINE_TYPE_REGION-style names into a suggested mapping."""
    parts = (campaign or "").split("_")
    if len(parts) >= 4:
        return {"campaign": campaign, "brand": parts[0], "engine": parts[1],
                "camp_type": parts[2], "region": "_".join(parts[3:]),
                "category": parts[2]}
    return {"campaign": campaign, "brand": None, "engine": None,
            "camp_type": None, "region": None, "category": None}


def unmapped_campaigns(engine, client_id):
    """Campaigns present in the warehouse but absent from mappings — blocks runs."""
    with engine.connect() as c:
        seen = {r[0] for r in c.execute(text(
            "SELECT DISTINCT campaign FROM raw_rows "
            "WHERE client_id = :cid AND report_type = 'campaign_performance' "
            "AND campaign IS NOT NULL"), {"cid": client_id})}
        mapped = {r[0] for r in c.execute(select(campaign_mappings.c.campaign).where(
            campaign_mappings.c.client_id == client_id))}
    return sorted(seen - mapped)


# ---- business metrics -------------------------------------------------------

def upsert_business_metrics(engine, client_id, rows):
    """rows: [{brand, region, category, period_start(iso), revenue_per_conv,
    gp_pct, car_count?, source?}]"""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            period = r.get("period_start")
            if isinstance(period, str):
                period = datetime.date.fromisoformat(period)
            where = ((business_metrics.c.client_id == client_id)
                     & (business_metrics.c.brand == r["brand"])
                     & (business_metrics.c.region == r["region"])
                     & (business_metrics.c.category == r["category"])
                     & (business_metrics.c.period_start == period))
            c.execute(delete(business_metrics).where(where))
            c.execute(insert(business_metrics).values(
                client_id=client_id, brand=r["brand"], region=r["region"],
                category=r["category"], period_start=period,
                revenue_per_conv=r.get("revenue_per_conv"),
                gp_pct=r.get("gp_pct"), car_count=r.get("car_count"),
                source=r.get("source", "config"), updated_at=now))
    return len(rows)


def get_business_metrics(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(business_metrics).where(
            business_metrics.c.client_id == client_id)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("period_start"), (datetime.date, datetime.datetime)):
            d["period_start"] = d["period_start"].isoformat()
        out.append(d)
    return out


# ---- goal ladder (V2 §2): observed units per rung + a value on every rung -----

def upsert_goal_values(engine, client_id, rows):
    """rows: [{campaign?, period_start(iso), goal_key, units, source?}]. campaign omitted
    or '' = account-level (distributes proportional to main_conv). Full-row replace per key."""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            period = r.get("period_start")
            if isinstance(period, str):
                period = datetime.date.fromisoformat(period)
            camp = r.get("campaign") or ""
            where = ((goal_values.c.client_id == client_id)
                     & (goal_values.c.campaign == camp)
                     & (goal_values.c.period_start == period)
                     & (goal_values.c.goal_key == r["goal_key"]))
            c.execute(delete(goal_values).where(where))
            c.execute(insert(goal_values).values(
                client_id=client_id, campaign=camp, period_start=period,
                goal_key=r["goal_key"], units=r.get("units"),
                source=r.get("source", "upload"), updated_at=now))
    return len(rows)


def get_goal_values(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(goal_values).where(
            goal_values.c.client_id == client_id)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("period_start"), (datetime.date, datetime.datetime)):
            d["period_start"] = d["period_start"].isoformat()
        out.append(d)
    return out


def upsert_goal_config(engine, client_id, rows):
    """rows: [{goal_key, value_per_unit?, margin_pct?, label?}]. A null value_per_unit
    leaves the rung volume-maximizing."""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            where = ((goal_config.c.client_id == client_id)
                     & (goal_config.c.goal_key == r["goal_key"]))
            c.execute(delete(goal_config).where(where))
            c.execute(insert(goal_config).values(
                client_id=client_id, goal_key=r["goal_key"],
                value_per_unit=r.get("value_per_unit"), margin_pct=r.get("margin_pct"),
                label=r.get("label"), updated_at=now))
    return len(rows)


def get_goal_config(engine, client_id):
    """{goal_key: {value_per_unit, margin_pct, label}} — the value on every rung."""
    with engine.connect() as c:
        rows = c.execute(select(goal_config).where(
            goal_config.c.client_id == client_id)).mappings().all()
    return {r["goal_key"]: {"value_per_unit": r["value_per_unit"],
                            "margin_pct": r["margin_pct"], "label": r["label"]} for r in rows}


def migrate_business_metrics(engine, client_id):
    """One-time bridge (V2 §2): seed bi_goal_config['transactions'] from the client's
    business metrics — value_per_unit = avg revenue_per_conv, margin_pct = avg gp_pct — so
    the `transactions` rung (fed by car_count in build_cells) becomes a valued goal without
    manual config. Idempotent: only writes when transactions isn't already configured."""
    cfg = get_goal_config(engine, client_id)
    if "transactions" in cfg and cfg["transactions"].get("value_per_unit") is not None:
        return False
    bms = get_business_metrics(engine, client_id)
    rpc = [b["revenue_per_conv"] for b in bms if b.get("revenue_per_conv")]
    gpp = [b["gp_pct"] for b in bms if b.get("gp_pct") is not None]
    if not rpc:
        return False
    upsert_goal_config(engine, client_id, [{
        "goal_key": "transactions", "label": "Transactions",
        "value_per_unit": sum(rpc) / len(rpc),
        "margin_pct": (sum(gpp) / len(gpp)) if gpp else None,
    }])
    return True


# ---- guard config (V2 §5): per-cell change limit, resolved most-specific-first ----

DEFAULT_GUARD_BAND = 0.30
LOST_RANK_CAUTION = 0.35            # V2 §6: above this, budget alone won't buy the share


def _lost_rank_caution(is_lost_rank):
    """Display-only caution (V2 §6): high IS-lost-to-rank means spend alone won't fix it."""
    if is_lost_rank is not None and is_lost_rank >= LOST_RANK_CAUTION:
        return "budget alone is unlikely to buy this share — pair with the tCPA move"
    return None


def upsert_guard_config(engine, client_id, rows):
    """rows: [{brand?, region?, category?, max_change_pct}] — omitted/'' = any on a dimension."""
    now = _now()
    with engine.begin() as c:
        for r in rows:
            b, rg, cat = r.get("brand") or "", r.get("region") or "", r.get("category") or ""
            where = ((guard_config.c.client_id == client_id) & (guard_config.c.brand == b)
                     & (guard_config.c.region == rg) & (guard_config.c.category == cat))
            c.execute(delete(guard_config).where(where))
            c.execute(insert(guard_config).values(
                client_id=client_id, brand=b, region=rg, category=cat,
                max_change_pct=r.get("max_change_pct"), updated_at=now))
    return len(rows)


def get_guard_config(engine, client_id):
    with engine.connect() as c:
        rows = c.execute(select(guard_config).where(
            guard_config.c.client_id == client_id)).mappings().all()
    return [dict(r) for r in rows]


def resolve_guard_band(guard_rows, brand, region, category, default=DEFAULT_GUARD_BAND):
    """Most-specific match wins (category > region > brand > client); `default` when none
    matches (V2 §5). A dimension left '' on a rule means 'any'."""
    best, best_rank = default, -1
    for g in guard_rows:
        gb, gr, gc = g.get("brand") or "", g.get("region") or "", g.get("category") or ""
        if (gb and gb != brand) or (gr and gr != region) or (gc and gc != category):
            continue
        rank = (4 if gc else 0) + (2 if gr else 0) + (1 if gb else 0)
        if rank > best_rank:
            best_rank, best = rank, g.get("max_change_pct")
    return best


# ---- reference period (V2 §5): the actuals/guard window --------------------

def _frac(v):
    """A percentage-or-fraction cell -> fraction (0.35 or 35 -> 0.35); None if unparseable."""
    try:
        f = float(str(v).replace("%", "").replace(",", "")) if v is not None else None
    except (TypeError, ValueError):
        return None
    if f is None:
        return None
    return f / 100.0 if f > 1.0 else f


def _as_date(v):
    if isinstance(v, datetime.datetime):
        return v.date()
    if isinstance(v, datetime.date):
        return v
    if isinstance(v, str) and v:
        try:
            return datetime.date.fromisoformat(v[:10])
        except ValueError:
            return None
    return None


def _resolve_window(dates, reference):
    """(lo, hi, exclude_set) for build_cells. reference: {mode: week|trailing, period_start,
    weeks, exclude[]}. None -> (None, None, set()) = aggregate everything (back-compat).
    'trailing' / a missing period_start use the latest dated day as the window's end."""
    if not reference:
        return None, None, set()
    exclude = {d for d in (_as_date(x) for x in (reference.get("exclude") or [])) if d}
    ps = _as_date(reference.get("period_start"))
    weeks = int(reference.get("weeks") or 1)
    span = datetime.timedelta(days=7 * weeks - 1)
    mode = reference.get("mode") or ("week" if ps else "trailing")
    if mode == "week" and ps:
        return ps, ps + span, exclude
    real = [d for d in dates if d]                      # trailing / latest complete window
    if not real:
        return None, None, exclude
    hi = max(real)
    return hi - span, hi, exclude


# ---- simulator snapshots ----------------------------------------------------

def add_snapshot(engine, client_id, points, source="manual", campaign=None,
                 sim_type="budget", x_axis="is_share"):
    with engine.begin() as c:
        c.execute(insert(simulator_snapshots).values(
            client_id=client_id, campaign=campaign, taken_at=_now(),
            source=source, points=points, sim_type=sim_type, x_axis=x_axis))
    from . import bq_mirror
    bq_mirror.mirror_snapshot(client_id, points, source, campaign)  # fail-soft


def get_snapshots(engine, client_id, campaigns=None, sim_type="budget"):
    """Simulator snapshots for a client, optionally filtered to a set of campaigns and a
    sim_type (default 'budget'; TARGET_CPA sims are stored but ignored by the model in V2)."""
    with engine.connect() as c:
        rows = c.execute(select(simulator_snapshots).where(
            simulator_snapshots.c.client_id == client_id)).mappings().all()
    out = []
    for r in rows:
        if sim_type and (r.get("sim_type") or "budget") != sim_type:
            continue
        if campaigns is not None and r["campaign"] not in campaigns:
            continue
        out.append(dict(r))
    return out


def _cell_campaigns(engine, client_id):
    """{cell_key: [campaign, ...]} from the mappings — which campaigns roll up to each cell."""
    out = defaultdict(list)
    for m in get_mappings(engine, client_id):
        if m.get("brand"):
            out[(m["brand"], m["region"], m["category"])].append(m["campaign"])
    return out


def resolve_cell_curve(engine, client_id, cell_key, account_master, cell_campaigns=None,
                       snapshots=None, k=8):
    """Build a cell's response curve + diagnostics (V2 §6): sum the cell's per-campaign
    BUDGET-simulator curves on a shared spend grid, then PARTIAL-POOL toward the account fit
    (w = n/(n+k)); fall back to the account fit when the cell has no campaign points. Returns
    (SpendCurve, diagnostics{scope, source, points, w, campaigns})."""
    account_curve = spend_curve_from_master(account_master)
    camps = set((cell_campaigns or _cell_campaigns(engine, client_id)).get(cell_key, []))
    snaps = snapshots if snapshots is not None else get_snapshots(engine, client_id, camps)
    camp_curves, n_points = [], 0
    for s in snaps:
        if s["campaign"] in camps and s.get("points"):
            pts = s["points"] if isinstance(s["points"], list) else json.loads(s["points"])
            sc = spend_curve_from_points(pts)
            if sc.spend:
                camp_curves.append(sc)
                n_points += len(pts)
    if camp_curves:
        pooled, w = pool(sum_curves(camp_curves), account_curve, n_points, k=k)
        return pooled, {"scope": "cell", "source": "simulator", "points": n_points,
                        "w": round(w, 4), "campaigns": len(camp_curves)}
    return account_curve, {"scope": "account", "source": "simulator", "points": 0,
                           "w": 0.0, "campaigns": 0}


def cell_curve_diagnostics(engine, client_id, cells, account_master):
    """{cell_key: diagnostics} so every result can name the curve that produced it. Fail-soft."""
    camp_map = _cell_campaigns(engine, client_id)
    snaps = get_snapshots(engine, client_id)
    out = {}
    for cell in cells:
        try:
            _, diag = resolve_cell_curve(engine, client_id, cell.key, account_master,
                                         cell_campaigns=camp_map, snapshots=snaps)
        except Exception:   # noqa: BLE001
            diag = None
        out[cell.key] = diag
    return out


def simulations_compare(engine, client_id, n=20):
    """Budget vs target-CPA (V2 §6d, evaluate-only): the budget curve's implied CPA at each
    spend against the stored TARGET_CPA simulation. No model change — the calibration loop
    decides which to trust before either is used jointly. Returns
    {budget:[{spend,conversions,implied_cpa}], target_cpa:[{spend,conversions,cpa}], available}."""
    budget = []
    try:
        acct = spend_curve_from_master(get_active_curves(engine, client_id))
        if acct.spend:
            hi = acct.max_spend
            for i in range(n):
                s = hi * (i + 1) / n
                cv = acct.conv_at(s)
                budget.append({"spend": round(s, 2), "conversions": round(cv, 2),
                               "implied_cpa": round(s / cv, 4) if cv else None})
    except LookupError:
        pass
    tcpa = []
    for snap in get_snapshots(engine, client_id, sim_type="target_cpa"):
        pts = snap["points"] if isinstance(snap["points"], list) else json.loads(snap["points"])
        for p in pts:
            spend = p.get("spend_week", p.get("spend"))
            conv = p.get("conversions", p.get("leads_week", p.get("leads")))
            if spend is None or not conv:
                continue
            cpa = p.get("target_cpa")
            if cpa is None:
                cpa = float(spend) / float(conv)
            tcpa.append({"spend": round(float(spend), 2), "conversions": round(float(conv), 2),
                         "cpa": round(float(cpa), 4)})
    tcpa.sort(key=lambda x: x["spend"])
    return {"budget": budget, "target_cpa": tcpa, "available": bool(tcpa)}


# ---- actuals builder (the programmatic Actuals sheet) ------------------------

def build_cells(engine, client_id, reference=None):
    """Aggregate mapped campaign_performance rows to Brand × Region × Category
    Cells, merging tCPA (cost-weighted, where the export carries target_cpa) and
    the latest business metrics per cell. MODEL_SPEC §1 semantics.

    `reference` (V2 §5) selects the actuals/guard window — {mode, period_start, weeks,
    exclude[]}; None aggregates everything. Both the projection baseline and the guard
    read this window. IS aggregation: eligible impressions = impr / IS per campaign;
    cell IS = sum(impr) / sum(eligible)."""
    mappings = {m["campaign"]: m for m in get_mappings(engine, client_id)}
    # text() SQL, not a Core select: the BigQuery RouterEngine (engine/warehouse/
    # analytics.py) routes raw text touching raw_rows to BigQuery after cutover,
    # while Core selects always go to Postgres. Column list is the intersection
    # of the PG and BQ raw_rows schemas.
    with engine.connect() as c:
        rows = c.execute(text(
            "SELECT campaign, clicks, impressions, cost, conversions, date_norm, row "
            "FROM raw_rows WHERE client_id = :cid "
            "AND report_type = 'campaign_performance'"),
            {"cid": client_id}).mappings().all()

    lo, hi, exclude = _resolve_window([_as_date(r["date_norm"]) for r in rows], reference)

    agg = {}
    for r in rows:
        m = mappings.get(r["campaign"])
        if not m or not m.get("brand"):
            continue
        d = _as_date(r["date_norm"])
        if d is not None and ((lo and d < lo) or (hi and d > hi) or d in exclude):
            continue                                    # dated row outside the reference window

        key = (m["brand"], m["region"], m["category"])
        a = agg.setdefault(key, dict(impr=0.0, clicks=0.0, cost=0.0, conv=0.0,
                                     eligible=0.0, tcpa_wsum=0.0, tcpa_w=0.0, all_conv=0.0,
                                     lb_wsum=0.0, lr_wsum=0.0))
        j = _jrow(r["row"])
        impr = r["impressions"] or 0.0
        a["impr"] += impr
        a["clicks"] += r["clicks"] or 0.0
        a["cost"] += r["cost"] or 0.0
        a["conv"] += r["conversions"] or 0.0
        try:
            allc = j.get("all_conv")
            if allc is not None:
                a["all_conv"] += float(allc)
        except (TypeError, ValueError):
            pass
        is_frac = j.get("search_impr_share")
        try:
            is_frac = float(is_frac) if is_frac is not None else None
        except (TypeError, ValueError):
            is_frac = None
        if is_frac and impr:
            el = impr / is_frac
            a["eligible"] += el
            lb, lr = _frac(j.get("search_lost_is_budget")), _frac(j.get("search_lost_is_rank"))
            if lb is not None:
                a["lb_wsum"] += lb * el          # eligible-impression weighted (V2 §6)
            if lr is not None:
                a["lr_wsum"] += lr * el
        tcpa = j.get("target_cpa")
        try:
            tcpa = float(str(tcpa).replace("$", "").replace(",", ""))
        except (TypeError, ValueError):
            tcpa = None
        if tcpa and r["cost"]:
            a["tcpa_wsum"] += tcpa * r["cost"]
            a["tcpa_w"] += r["cost"]

    # latest business metrics per cell
    bm = {}
    for r in get_business_metrics(engine, client_id):
        key = (r["brand"], r["region"], r["category"])
        if key not in bm or (r["period_start"] or "") > (bm[key]["period_start"] or ""):
            bm[key] = r

    # V2 goal ladder units per cell: uploaded per-campaign business outcomes roll up to
    # cells via the mappings; account-level rows (campaign='') distribute proportional to
    # main_conv. (Reference-period windowing lands in PR3 — here we aggregate what's loaded.)
    sum_main = sum(a["conv"] for a in agg.values()) or 1.0
    per_cell_goals = {key: {} for key in agg}
    account_goals = defaultdict(float)
    for gv in get_goal_values(engine, client_id):
        gvd = _as_date(gv["period_start"])
        if gvd and ((lo and gvd < lo) or (hi and gvd > hi) or gvd in exclude):
            continue                                    # outside the reference window
        gk, u, camp = gv["goal_key"], (gv["units"] or 0.0), gv["campaign"]
        if camp:
            m = mappings.get(camp)
            if not m or not m.get("brand"):
                continue
            k = (m["brand"], m["region"], m["category"])
            if k in per_cell_goals:
                per_cell_goals[k][gk] = per_cell_goals[k].get(gk, 0.0) + u
        else:
            account_goals[gk] += u

    cells = []
    for key, a in sorted(agg.items()):
        brand, region, category = key
        conv, cost = a["conv"], a["cost"]
        is_share = (a["impr"] / a["eligible"]) if a["eligible"] else 0.0
        b = bm.get(key, {})
        car_count = b.get("car_count") or conv          # fallback: conv == car
        rev_per_car = b.get("revenue_per_conv") or 0.0
        gp_pct = b.get("gp_pct") or 0.0
        goals = dict(per_cell_goals.get(key, {}))
        for gk, total in account_goals.items():         # distribute account-level by main_conv
            goals[gk] = goals.get(gk, 0.0) + total * (conv / sum_main)
        if b.get("car_count"):                          # migration: car_count -> transactions rung
            goals["transactions"] = b["car_count"]
        if a.get("all_conv"):                           # Google all-conv rung
            goals["all_conv"] = a["all_conv"]
        cells.append(Cell(
            brand=brand, region=region, category=category,
            impr=a["impr"], clicks=a["clicks"], cost=cost, main_conv=conv,
            cpa=cost / conv if conv else 0.0,
            tcpa=a["tcpa_wsum"] / a["tcpa_w"] if a["tcpa_w"] else 0.0,
            is_share=is_share,
            rev_per_car=rev_per_car, gp_per_car=rev_per_car * gp_pct,
            gp_pct=gp_pct,
            cost_per_car=cost / car_count if car_count else 0.0,
            car_count=car_count,
            is_current=max(1, min(100, mround(is_share * 100))) if is_share else 0,
            is_lost_budget=(a["lb_wsum"] / a["eligible"]) if a["eligible"] else 0.0,
            is_lost_rank=(a["lr_wsum"] / a["eligible"]) if a["eligible"] else 0.0,
            goal_units=goals,
        ))
    return cells


# ---- allocation runs ----------------------------------------------------------

def available_goals(cells):
    """The rungs a run can score, DERIVED FROM DATA (never configured, V2 §2): main_conv
    always; all_conv and each business rung only when some cell carries units for it.
    Ordered Google-first, then business."""
    present = set()
    for c in cells:
        present |= set((c.goal_units or {}).keys())
    goals = ["main_conv"]
    if "all_conv" in present:
        goals.append("all_conv")
    goals += [g for g in BUSINESS_RUNGS if g in present]
    return goals


def _disagreements(scenarios):
    """Cells whose recommended direction (sign of rec_spend − lw_spend) differs across the
    computed goals — the 'this goal says up, that goal says down' conflicts — sorted by the
    largest spend move (V2 §4)."""
    dirs, mag = defaultdict(dict), defaultdict(float)
    for g, results in scenarios.items():
        for r in results:
            key = (r["brand"], r["region"], r["category"])
            d = r["rec_spend"] - r["lw_spend"]
            dirs[key][g] = 1 if d > 1e-6 else -1 if d < -1e-6 else 0
            mag[key] = max(mag[key], abs(d))
    out = []
    for key, by_goal in dirs.items():
        if len({s for s in by_goal.values() if s != 0}) > 1:
            out.append({"brand": key[0], "region": key[1], "category": key[2],
                        "directions": by_goal, "magnitude": round(mag[key], 2)})
    out.sort(key=lambda x: -x["magnitude"])
    return out


def create_run(engine, client_id, goal, budget, mode="greedy_marginal",
               run_params=None, created_by="api", notes=None, cells=None):
    """Build cells (unless supplied), resolve curves, and compute ONE allocation per
    available goal (V2 §4 scenarios), persisting them all. `goal` becomes the requested
    default view (legacy names aliased onto V2 rungs). Returns (run_id, results) where
    results is the default goal's scenario. Raises ValueError on unmapped campaigns or
    unusable inputs."""
    unmapped = unmapped_campaigns(engine, client_id)
    if unmapped and cells is None:
        raise ValueError(f"unmapped campaigns block the run: {unmapped[:10]}"
                         + (f" (+{len(unmapped)-10} more)" if len(unmapped) > 10 else ""))
    reference = (run_params or {}).get("reference")
    if cells is None:
        migrate_business_metrics(engine, client_id)          # seed the transactions value once
        cells = build_cells(engine, client_id, reference=reference)
    cells = [c for c in cells if c.is_current and c.cost > 0]
    if not cells:
        raise ValueError("no usable cells: need mapped campaign data with "
                         "impression share > 0")
    curves = get_active_curves(engine, client_id)
    gcfg = get_goal_config(engine, client_id)
    goals = available_goals(cells)
    default_goal = LEGACY_GOAL_ALIAS.get(goal, goal)
    if default_goal not in goals:
        default_goal = goals[0]

    # Resolve the guard band per cell (hierarchy). Active when guard rules exist (or a flat
    # max_change_pct is passed); otherwise the run is unguarded (back-compat).
    guard_rows = get_guard_config(engine, client_id)
    rp = dict(run_params or {})
    if guard_rows:
        rp["guard_bands"] = {c.key: resolve_guard_band(guard_rows, *c.key) for c in cells}
    scenarios = {g: run_allocation_v2(cells, curves, goal=g, budget=budget,
                                      goal_config=gcfg, run_params=rp) for g in goals}
    # Name the curve that produced each cell (V2 §6): per-campaign fits pooled toward account.
    curve_diag = cell_curve_diagnostics(engine, client_id, cells, curves)
    for results in scenarios.values():
        for r in results:
            r["curve"] = curve_diag.get((r["brand"], r["region"], r["category"]))
    with engine.begin() as c:
        run_id = c.execute(insert(allocation_runs).values(
            client_id=client_id, run_at=_now(), created_by=created_by,
            goal=default_goal, budget=budget, mode=mode, params=run_params or {},
            status="draft", notes=notes, goals_computed=goals, chosen_goal=None
        )).inserted_primary_key[0]
        for results in scenarios.values():
            for r in results:
                c.execute(insert(allocation_results).values(run_id=run_id, **r))
    return run_id, scenarios[default_goal]


def get_run(engine, client_id, run_id):
    """The run plus its per-goal scenarios and cross-goal disagreements. `results` is the
    chosen (or requested-default) goal's scenario, for callers that want one view."""
    with engine.connect() as c:
        run = c.execute(select(allocation_runs).where(
            (allocation_runs.c.id == run_id)
            & (allocation_runs.c.client_id == client_id))).mappings().first()
        if not run:
            return None
        rows = c.execute(select(allocation_results).where(
            allocation_results.c.run_id == run_id)).mappings().all()
    out = dict(run)
    if isinstance(out.get("run_at"), datetime.datetime):
        out["run_at"] = out["run_at"].isoformat()
    scenarios = defaultdict(list)
    for r in rows:
        d = dict(r)
        caution = _lost_rank_caution(d.get("is_lost_rank"))   # V2 §6 display signal
        if caution:
            d["caution"] = caution
        scenarios[d.get("goal") or ""].append(d)
    out["scenarios"] = dict(scenarios)
    default = out.get("chosen_goal") or out.get("goal")
    out["results"] = scenarios.get(default) or next(iter(scenarios.values()), [])
    out["disagreements"] = _disagreements(scenarios)
    # held-back reporting (V2 §5): what the change limit withheld, per goal.
    out["held_back_total"] = {g: round(sum((r.get("held_back") or 0.0) for r in rs), 2)
                              for g, rs in scenarios.items()}
    return out


def list_runs(engine, client_id, limit=20):
    with engine.connect() as c:
        rows = c.execute(select(allocation_runs).where(
            allocation_runs.c.client_id == client_id)
            .order_by(allocation_runs.c.id.desc()).limit(limit)).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("run_at"), datetime.datetime):
            d["run_at"] = d["run_at"].isoformat()
        out.append(d)
    return out


def finalize_run(engine, client_id, run_id, goal=None, created_by="api"):
    """Pick a goal (V2 §4), mark the run final, and stamp predictions FOR THAT GOAL ONLY for
    the calibration loop. `goal` defaults to the run's requested view; predictions are keyed
    by goal so scenarios don't collide. Idempotent."""
    run = get_run(engine, client_id, run_id)
    if not run:
        raise LookupError(f"run {run_id} not found for client {client_id}")
    if run["status"] == "final":
        return run
    chosen = goal or run.get("chosen_goal") or run.get("goal")
    results = run["scenarios"].get(chosen) or run["results"]
    with engine.begin() as c:
        c.execute(allocation_runs.update().where(
            allocation_runs.c.id == run_id).values(status="final", chosen_goal=chosen))
        for r in results:
            c.execute(insert(predictions).values(
                run_id=run_id, goal=chosen, brand=r["brand"], region=r["region"],
                category=r["category"],
                predicted={"is": r["expected_is"], "cpa": r["expected_cpa"],
                           "units": r["expected_cars"], "spend": r["rec_spend"]}))
    _create_lifecycle_actions(engine, client_id, run_id, chosen, results)   # V2 §6
    run["status"] = "final"
    run["chosen_goal"] = chosen
    run["results"] = results
    from . import bq_mirror
    bq_mirror.mirror_finalized_run(run)   # fail-soft analytical mirror
    return run


def override_run(engine, client_id, run_id, cell_key, spend, reason, actor, goal=None):
    """Audited override (V2 §5): set rec_spend for one cell past the guard band, recompute its
    held_back, and record the override in run.params.overrides[] with actor + reason — never
    silent. (Decision-ledger action lands with the lifecycle hookup in PR4.) Returns the
    updated result row. Raises LookupError/ValueError when the run or cell is missing."""
    run = get_run(engine, client_id, run_id)
    if not run:
        raise LookupError(f"run {run_id} not found for client {client_id}")
    if not reason or not actor:
        raise ValueError("override requires an actor and a reason (never silent)")
    g = goal or run.get("chosen_goal") or run.get("goal")
    brand, region, category = cell_key
    where = ((allocation_results.c.run_id == run_id) & (allocation_results.c.goal == g)
             & (allocation_results.c.brand == brand) & (allocation_results.c.region == region)
             & (allocation_results.c.category == category))
    with engine.begin() as c:
        res = c.execute(select(allocation_results).where(where)).mappings().first()
        if not res:
            raise ValueError(f"cell {cell_key} not in run {run_id} for goal {g}")
        base = res["proposed_spend"] if res["proposed_spend"] is not None else res["rec_spend"]
        c.execute(allocation_results.update().where(where).values(
            rec_spend=spend, held_back=round(base - spend, 4)))
        params = dict(run.get("params") or {})
        params["overrides"] = list(params.get("overrides") or []) + [{
            "goal": g, "cell": list(cell_key), "spend": spend, "reason": reason,
            "actor": actor, "at": _now().isoformat()}]
        c.execute(allocation_runs.update().where(
            allocation_runs.c.id == run_id).values(params=params))
    # Also record the override in the decision ledger (V2 §5, wired with the §6 lifecycle).
    try:
        from ..decisions.service import create_action
        from ..decisions.keys import action_key
        cell = "/".join(cell_key)
        create_action(engine, client_id, action_key(client_id, {"key": f"bi:run{run_id}:{g}:{cell}:override"}),
                      title=f"Override {cell} spend to ${spend:,.0f} — {reason}",
                      category="Budget", module="budget_intel", actor=actor,
                      evidence={"cell": list(cell_key), "spend": spend, "reason": reason, "actor": actor})
    except Exception:
        pass                                    # ledger write is best-effort; the audit lives on the run
    return {"run_id": run_id, "goal": g, "cell": list(cell_key), "rec_spend": spend,
            "held_back": round(base - spend, 4), "reason": reason, "actor": actor}


# ---- calibration loop (V2 §6): close predicted vs actual, measure optimism ---

LIFECYCLE_THRESHOLD = 0.05          # |Δspend|/lw above which finalize files a decision action


def _create_lifecycle_actions(engine, client_id, run_id, goal, results, threshold=LIFECYCLE_THRESHOLD):
    """On finalize, file a decision action for each cell whose spend move exceeds `threshold`
    (default 5%), plus a second action for its tCPA move — into the existing decision system,
    idempotent per (run_id, goal, cell). V2 §6. Fully fail-soft: a ledger hiccup (or an
    uninitialized decisions schema) must never fail a finalize."""
    try:
        from ..decisions.service import create_action
        from ..decisions.keys import action_key
        for r in results:
            lw = r.get("lw_spend") or 0.0
            if lw <= 0 or abs(r["rec_spend"] - lw) / lw <= threshold:
                continue
            cell = f'{r["brand"]}/{r["region"]}/{r["category"]}'
            base = f"bi:run{run_id}:{goal}:{cell}"
            up = r["rec_spend"] > lw
            create_action(engine, client_id, action_key(client_id, {"key": base + ":spend"}),
                          title=f'{"Increase" if up else "Decrease"} {cell} spend ${lw:,.0f} → ${r["rec_spend"]:,.0f}',
                          category="Budget", module="budget_intel", evidence=r)
            tc, tr = r.get("tcpa_current") or 0.0, r.get("tcpa_recommended") or 0.0
            if abs(tr - tc) > 1e-9:
                create_action(engine, client_id, action_key(client_id, {"key": base + ":tcpa"}),
                              title=f'Adjust {cell} tCPA ${tc:,.2f} → ${tr:,.2f}',
                              category="Bidding", module="budget_intel", evidence=r)
    except Exception:   # noqa: BLE001
        pass


def _shift_reference(reference):
    """The period immediately following a run's reference window (same length). None when the
    run has no explicit period_start (a trailing/all-data window can't be shifted here)."""
    if not reference:
        return None
    ps = _as_date(reference.get("period_start"))
    if not ps:
        return None
    weeks = int(reference.get("weeks") or 1)
    nxt = ps + datetime.timedelta(days=7 * weeks)
    return {"mode": "week", "period_start": nxt.isoformat(), "weeks": weeks}


def reconcile_predictions(engine, client_id):
    """For every finalized run whose predictions still lack an actual, measure the period
    FOLLOWING the run's reference window (build_cells) and write {is, cpa, units, spend} +
    measured_at (V2 §6). Never overwrites an existing actual. Returns rows written."""
    with engine.connect() as c:
        runs = c.execute(select(allocation_runs).where(
            (allocation_runs.c.client_id == client_id)
            & (allocation_runs.c.status == "final"))).mappings().all()
    written = 0
    for run in runs:
        with engine.connect() as c:
            preds = c.execute(select(predictions).where(
                (predictions.c.run_id == run["id"]) & (predictions.c.actual.is_(None)))).mappings().all()
        if not preds:
            continue
        nxt = _shift_reference((run["params"] or {}).get("reference"))
        actuals = {cell.key: cell for cell in build_cells(engine, client_id, reference=nxt)}
        goal = run["chosen_goal"] or run["goal"]
        for p in preds:
            key = (p["brand"], p["region"], p["category"])
            cell = actuals.get(key)
            if not cell:
                continue
            units = cell.main_conv if goal == "main_conv" else (cell.goal_units or {}).get(goal, cell.main_conv)
            actual = {"is": round(cell.is_share * 100, 4), "cpa": round(cell.cpa, 4),
                      "units": round(units, 4), "spend": round(cell.cost, 4)}
            with engine.begin() as c:
                res = c.execute(predictions.update().where(
                    (predictions.c.run_id == p["run_id"]) & (predictions.c.goal == p["goal"])
                    & (predictions.c.brand == key[0]) & (predictions.c.region == key[1])
                    & (predictions.c.category == key[2]) & (predictions.c.actual.is_(None))
                ).values(actual=actual, measured_at=_now()))
                written += res.rowcount or 0
    return written


def _mape_bias(pairs):
    """pairs: [(predicted, actual)]. (MAPE, bias) over non-zero actuals, or (None, None).
    bias > 0 means predicted ran high (optimistic)."""
    errs = [(pd - ac) / ac for pd, ac in pairs if ac]
    if not errs:
        return None, None
    return round(sum(abs(e) for e in errs) / len(errs), 4), round(sum(errs) / len(errs), 4)


def calibration_report(engine, client_id):
    """Predicted-vs-actual per cell/goal with MAPE + bias, plus simulator-vs-actual — the curve
    is simulator-fit, so the units bias measures Google's optimism (V2 §6)."""
    with engine.connect() as c:
        rows = c.execute(select(
            predictions.c.run_id, predictions.c.goal, predictions.c.brand,
            predictions.c.region, predictions.c.category, predictions.c.predicted,
            predictions.c.actual
        ).select_from(predictions.join(allocation_runs, predictions.c.run_id == allocation_runs.c.id))
         .where((allocation_runs.c.client_id == client_id)
                & (predictions.c.actual.isnot(None)))).mappings().all()
    by_cell = defaultdict(list)
    for r in rows:
        by_cell[(r["goal"], r["brand"], r["region"], r["category"])].append(
            {"run_id": r["run_id"], "predicted": r["predicted"], "actual": r["actual"]})
    cells, all_units = [], []
    for (goal, b, rg, cat), hist in sorted(by_cell.items()):
        metrics = {}
        for m in ("is", "cpa", "units", "spend"):
            pairs = [(h["predicted"].get(m), h["actual"].get(m)) for h in hist
                     if h["predicted"] and h["actual"]
                     and h["predicted"].get(m) is not None and h["actual"].get(m) is not None]
            mape, bias = _mape_bias(pairs)
            metrics[m] = {"mape": mape, "bias": bias, "n": len(pairs)}
            if m == "units":
                all_units += pairs
        cells.append({"goal": goal, "brand": b, "region": rg, "category": cat,
                      "history": hist, "metrics": metrics})
    sim_mape, sim_bias = _mape_bias(all_units)
    return {"cells": cells,
            "simulator_vs_actual": {"units_mape": sim_mape, "units_bias": sim_bias}}
