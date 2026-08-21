"""Report registry: one GAQL query per report type, plus the field->slug mapping that
turns an API row into the SAME slugged-dict the CSV parser emits (engine/ingest/parser.py).

Each ReportSpec lists (gaql_path, slug, kind) triples. `slug` is the parser's column slug
(so downstream ingest/mapping/bundle code is identical to the CSV path); `kind` says how to
coerce the API value to the string form the parser produces (numbers carry no $/%; the
loader's to_number/impr_share_frac re-parse them). build_query() builds the SELECT from the
paths; convert_row() applies the mapping.

Metric slugs MUST match parser.CORE_METRICS keys: clicks, impr, cost, conversions, conv_value.
Every spec here is date-segmented (segments.date -> slug "date"), so ingest merges by window.

NOTE: the exact GAQL field names below are validated against the live API in Phase 2 (needs
credentials). Auction Insights is intentionally absent — Google does not expose it via API, so
it stays a manual CSV upload. geographic/audiences/schedule reports need criterion-id -> name
resolution and are deferred to a later pass; they remain uploadable as CSV.
"""


class ReportSpec:
    __slots__ = ("report_type", "resource", "fields", "dated", "where")

    def __init__(self, report_type, resource, fields, dated=True, where=None):
        self.report_type = report_type
        self.resource = resource
        self.fields = fields          # list[(gaql_path, slug, kind)]
        self.dated = dated
        self.where = where            # extra GAQL condition ANDed onto the date window

    def paths(self):
        seen = []
        for p, _slug, _kind in self.fields:
            if p not in seen:
                seen.append(p)
        return seen


# --- value coercion: API primitive (enums already flattened to their .name) -> parser string
def _numstr(x):
    """Compact numeric string, no trailing zeros: 12.34 -> '12.34', 100.0 -> '100'."""
    x = float(x)
    return str(int(x)) if x == int(x) else repr(round(x, 6))


def _conv(kind, v):
    if v is None or v == "":
        return None
    try:
        if kind == "text":
            s = str(v).strip()
            return s or None
        if kind == "date":
            return str(v)
        if kind == "int":
            return str(int(round(float(v))))
        if kind == "num":
            return _numstr(v)
        if kind == "micros":            # cost_micros -> dollars
            return _numstr(float(v) / 1_000_000)
        if kind == "share":             # API fraction (0.3478) -> percent string ("34.78")
            return _numstr(float(v) * 100)
        if kind in ("channel", "enum_title"):   # SEARCH -> "Search"; PERFORMANCE_MAX -> "Performance Max"
            return str(v).replace("_", " ").title()
        if kind == "enum":              # keep the raw enum name (QS labels: ABOVE_AVERAGE ...)
            return str(v)
    except (TypeError, ValueError):
        return None
    return str(v)


def convert_row(spec, flat):
    """API row (already flattened to {gaql_path: primitive}) -> parser-shaped slugged dict.

    Two list-aware kinds mirror how Google's UI exports repeated fields as numbered columns:
    - "text_list": a repeated field (RSA headlines/descriptions) -> slug_1..slug_N
    - "first_text": a repeated field where the CSV carried one value (final URLs) -> first item
    """
    out = {}
    for path, slug, kind in spec.fields:
        v = flat.get(path)
        if kind == "text_list":
            items = v if isinstance(v, (list, tuple)) else ([] if v in (None, "") else [v])
            for i, item in enumerate(items, 1):
                s = _conv("text", item)
                if s is not None:
                    out[f"{slug}_{i}"] = s
            continue
        if kind == "first_text":
            if isinstance(v, (list, tuple)):
                v = v[0] if v else None
            out[slug] = _conv("text", v)
            continue
        out[slug] = _conv(kind, v)
    return out


def build_query(spec, start, end):
    """GAQL for one report over [start, end] (inclusive)."""
    q = f"SELECT {', '.join(spec.paths())} FROM {spec.resource}"
    conds = []
    if spec.dated:
        conds.append(f"segments.date BETWEEN '{start:%Y-%m-%d}' AND '{end:%Y-%m-%d}'")
    if spec.where:
        conds.append(spec.where)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    return q


_DATE = ("segments.date", "date", "date")
_CORE = [
    ("metrics.clicks", "clicks", "int"),
    ("metrics.impressions", "impr", "int"),
    ("metrics.cost_micros", "cost", "micros"),
    ("metrics.conversions", "conversions", "num"),
    ("metrics.conversions_value", "conv_value", "num"),
]

DEFAULT_SPECS = [
    # Account-level daily spend — the pacing feed (mirrors the MCC "Pacing" CSV export).
    ReportSpec("account_spend", "customer", [
        ("customer.descriptive_name", "account_name", "text"),
        ("customer.id", "customer_id", "text"),
        ("metrics.cost_micros", "cost", "micros"),
        _DATE,
    ]),
    ReportSpec("campaign_performance", "campaign", [
        ("campaign.name", "campaign", "text"),
        ("campaign.advertising_channel_type", "campaign_type", "channel"),
        ("campaign.bidding_strategy_type", "bid_strategy_type", "enum_title"),
        ("campaign.target_cpa.target_cpa_micros", "target_cpa", "micros"),
        *_CORE,
        ("metrics.search_impression_share", "search_impr_share", "share"),
        _DATE,
    ]),
    ReportSpec("ad_group_performance", "ad_group", [
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        *_CORE,
        _DATE,
    ]),
    ReportSpec("search_terms", "search_term_view", [
        ("search_term_view.search_term", "search_term", "text"),
        ("segments.search_term_match_type", "search_terms_match_type", "enum_title"),
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        *_CORE,
        _DATE,
    ]),
    # Ads: the Ad Copy + Ad↔LP views read every RSA headline/description as numbered columns,
    # plus the final URL and ad type. The API returns headlines/descriptions as repeated assets,
    # flattened here to headline_1..N / description_1..N (mirroring Google's own CSV export).
    ReportSpec("ads_performance", "ad_group_ad", [
        ("ad_group_ad.ad.name", "ad_name", "text"),
        ("ad_group_ad.ad.type", "ad_type", "enum_title"),
        ("ad_group_ad.ad.responsive_search_ad.headlines", "headline", "text_list"),
        ("ad_group_ad.ad.responsive_search_ad.descriptions", "description", "text_list"),
        ("ad_group_ad.ad.final_urls", "ad_final_url", "first_text"),
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        *_CORE,
        _DATE,
    ]),
    ReportSpec("landing_pages", "landing_page_view", [
        ("landing_page_view.unexpanded_final_url", "landing_page", "text"),
        *_CORE,
        _DATE,
    ]),
    ReportSpec("products_sold", "shopping_performance_view", [
        ("segments.product_title", "product_title_sold", "text"),
        ("segments.product_item_id", "item_id_sold", "text"),
        *_CORE,
        ("metrics.units_sold", "units_sold", "num"),
        _DATE,
    ]),
    # Performance Max placements — impressions only (all Google exposes). Feeds has_pmax + list.
    ReportSpec("pmax_placements", "performance_max_placement_view", [
        ("performance_max_placement_view.display_name", "performance_max_placement", "text"),
        ("performance_max_placement_view.placement_type", "placement_type", "enum_title"),
        ("campaign.name", "campaign", "text"),
        ("metrics.impressions", "impr", "int"),
        _DATE,
    ]),
    # Audience performance (not consumed by a view yet — pulled for upcoming features).
    ReportSpec("audiences", "ad_group_audience_view", [
        ("ad_group_criterion.display_name", "audience_segment", "text"),
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        *_CORE,
        _DATE,
    ]),
    # Distance from location assets (not consumed yet — pulled for future use).
    ReportSpec("distance_from_location", "distance_view", [
        ("distance_view.distance_bucket", "distance_from_location_assets", "enum_title"),
        ("campaign.name", "campaign", "text"),
        *_CORE,
        _DATE,
    ]),
    # Portfolio bid strategies — a config snapshot (undated): name, type, tCPA/tROAS targets.
    ReportSpec("bid_strategies", "bidding_strategy", [
        ("bidding_strategy.name", "bid_strategy", "text"),
        ("bidding_strategy.type", "bid_strategy_type", "enum_title"),
        ("bidding_strategy.target_cpa.target_cpa_micros", "target_cpa", "micros"),
        ("bidding_strategy.target_roas.target_roas", "target_roas", "num"),
    ], dated=False),
    # Ad-schedule performance by day-of-week × hour (undated — an all-time pattern snapshot).
    ReportSpec("schedule_dow_hod", "campaign", [
        ("campaign.name", "campaign", "text"),
        ("segments.day_of_week", "day_of_the_week", "enum_title"),
        ("segments.hour", "hour_of_the_day", "int"),
        *_CORE,
    ], dated=False),
    # Keyword report carrying Historical Quality Score — the loader freezes each day's QS
    # into qs_history (append-only). Enum labels map to the parser's hist_* QS slugs.
    ReportSpec("search_keyword_qs", "keyword_view", [
        ("ad_group_criterion.keyword.text", "search_keyword", "text"),
        ("ad_group_criterion.keyword.match_type", "search_keyword_match_type", "enum_title"),
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        ("metrics.historical_quality_score", "hist_quality_score", "int"),
        ("metrics.historical_search_predicted_ctr", "hist_exp_ctr", "enum"),
        ("metrics.historical_creative_quality_score", "hist_ad_relevance", "enum"),
        ("metrics.historical_landing_page_quality_score", "hist_landing_page_exper", "enum"),
        *_CORE,
        ("metrics.search_impression_share", "search_impr_share", "share"),
        _DATE,
    ]),
]

SPECS_BY_TYPE = {s.report_type: s for s in DEFAULT_SPECS}


def all_field_paths():
    """Every distinct GAQL field path across all specs, in first-seen order."""
    seen = []
    for spec in DEFAULT_SPECS:
        for p in spec.paths():
            if p not in seen:
                seen.append(p)
    return seen
