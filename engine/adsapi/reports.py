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
    __slots__ = ("report_type", "resource", "fields", "dated")

    def __init__(self, report_type, resource, fields, dated=True):
        self.report_type = report_type
        self.resource = resource
        self.fields = fields          # list[(gaql_path, slug, kind)]
        self.dated = dated

    def paths(self):
        return [p for p, _slug, _kind in self.fields]


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
    """API row (already flattened to {gaql_path: primitive}) -> parser-shaped slugged dict."""
    return {slug: _conv(kind, flat.get(path)) for path, slug, kind in spec.fields}


def build_query(spec, start, end):
    """GAQL for one report over [start, end] (inclusive)."""
    q = f"SELECT {', '.join(spec.paths())} FROM {spec.resource}"
    if spec.dated:
        q += f" WHERE segments.date BETWEEN '{start:%Y-%m-%d}' AND '{end:%Y-%m-%d}'"
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
        ("campaign.name", "campaign", "text"),
        ("ad_group.name", "ad_group", "text"),
        *_CORE,
        _DATE,
    ]),
    ReportSpec("ads_performance", "ad_group_ad", [
        ("ad_group_ad.ad.name", "ad_name", "text"),
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
        _DATE,
    ]),
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
