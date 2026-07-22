#!/usr/bin/env python3
"""Client business-context config: the structured knowledge + overrides the
analyzers obey. Stored per client in clients.config (JSON). This is the
Phase-1 Business Context doc, turned into config that sharpens every analyzer.
"""
import copy

DEFAULT_CONFIG = {
    # brand & competitor knowledge
    "brand_terms": [],              # e.g. ["chiarelli", "chiarelli's"]
    "product_categories": [],       # what the business sells — the relevance signal
    "competitors_friendly": [],     # never conquest/negate (industry relationships)
    "competitors_conquest": [],     # real conquest targets
    # deterministic thresholds (override the analyzer defaults)
    "thresholds": {
        "smart_bidding_floor": 30,  # conv/mo for standalone Smart Bidding
        "low_vol_conv": 15,
        "low_vol_spend": 100,
        "qs_floor": 3,              # QS danger-zone ceiling
        "monthly_budget": None,     # target monthly spend, for Budget & Pacing
    },
    # "override the math" inputs
    "waste_exclusions": [],         # term substrings never flagged as waste
    "seasonality": [],              # [{"label": "...", "months": ["May"]}] — context, suppression later
    "notes": "",
    # dimensional monthly budgets (from an uploaded budget file); each line:
    # {"brand": .., "region": .., "category": .., "monthly": <float>} — dims may be None
    "budget_lines": [],
}


def merged(raw):
    """Merge a stored (possibly partial/None) config over the defaults."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if not raw:
        return cfg
    for k, v in raw.items():
        if k == "thresholds" and isinstance(v, dict):
            cfg["thresholds"].update({tk: tv for tk, tv in v.items() if tv is not None})
        elif k in cfg:
            cfg[k] = v
    return cfg


def _norm_list(v):
    if isinstance(v, str):
        return [s.strip() for s in v.replace("\n", ",").split(",") if s.strip()]
    if isinstance(v, list):
        return [str(s).strip() for s in v if str(s).strip()]
    return []


def sanitize(raw):
    """Coerce an incoming config payload into the stored shape (lists normalized,
    thresholds numeric). Unknown keys dropped."""
    out = {}
    for key in ("brand_terms", "product_categories", "competitors_friendly", "competitors_conquest", "waste_exclusions"):
        if key in raw:
            out[key] = _norm_list(raw[key])
    if isinstance(raw.get("thresholds"), dict):
        th = {}
        for tk, tv in raw["thresholds"].items():
            if tk in DEFAULT_CONFIG["thresholds"]:
                try:
                    th[tk] = float(tv) if tv is not None and tv != "" else None
                except (TypeError, ValueError):
                    pass
        out["thresholds"] = th
    if isinstance(raw.get("seasonality"), list):
        out["seasonality"] = raw["seasonality"]
    if "notes" in raw:
        out["notes"] = str(raw["notes"])[:4000]
    if isinstance(raw.get("budget_lines"), list):
        lines = []
        for r in raw["budget_lines"]:
            if not isinstance(r, dict):
                continue
            try:
                monthly = float(r.get("monthly"))
            except (TypeError, ValueError):
                continue
            def _s(x):
                x = (str(x).strip() if x not in (None, "") else None)
                return x
            lines.append({"brand": _s(r.get("brand")), "region": _s(r.get("region")),
                          "category": _s(r.get("category")), "monthly": round(monthly, 2)})
        out["budget_lines"] = lines
    return out
