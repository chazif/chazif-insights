#!/usr/bin/env python3
"""Parse Google Ads Report Editor CSV exports.

Reuses the proven approach from the audit loader: Google CSVs have a 3-line
header (report title, date range, column row) and a trailing Total row; numbers
carry $ , % formatting. Adds column-based report detection (robust to the AE-10
filename collision) and window-date parsing.
"""
import csv, re, datetime
from pathlib import Path

# canonical metric slug -> our column name
CORE_METRICS = {
    "clicks": "clicks",
    "impr": "impressions",
    "cost": "cost",
    "conversions": "conversions",
    "conv_value": "conv_value",
}

# region/location column slugs a Google Ads report may carry when segmented by
# geography (Report Editor "Segment > Geographic" or a Location column).
GEO_SLUGS = ("state_matched", "region", "region_user_location", "region_matched_location",
             "state", "metro", "metro_area", "city", "most_specific_location", "county")

# report_type -> (entity column slug, date/grain column slug or None)
ENTITY_COL = {
    "search_terms": "search_term",
    "keyword_geo": "search_keyword",
    "search_keyword_qs": "search_keyword",
    "ad_group_performance": "ad_group",
    "campaign_performance": "campaign",
    "ads_performance": "ad_name",
    "landing_pages": "landing_page",
    "pmax_placements": "performance_max_placement",
    "geographic": "state_matched",
    "audiences": "audience_segment",
    "products_sold": "product_title_sold",
    "distance_from_location": "distance_from_location_assets",
    "auction_insights": "display_url_domain",
    "schedule_dow_hod": None,
}
# Candidate date columns per report, most-preferred first. Campaign Performance may be
# exported segmented by Month OR by Day (daily export) — accept either.
DATE_COL = {"campaign_performance": ("month", "day"), "schedule_dow_hod": ("day",),
            "auction_insights": ("day",)}

# Account-identifying columns present only in MCC-level exports (Manager account).
ACCOUNT_ID_SLUGS = ("customer_id", "account_id")
ACCOUNT_NAME_SLUGS = ("account_name", "account")


def account_cols(header_slugs):
    """(customer_id_col, account_name_col) if this export is tagged by account, else (None, None)."""
    cols = set(header_slugs)
    cid = next((s for s in ACCOUNT_ID_SLUGS if s in cols), None)
    nm = next((s for s in ACCOUNT_NAME_SLUGS if s in cols), None)
    return cid, nm

# ordered detection rules: (required slug present) -> report_type. Specific first.
_DETECT = [
    ("search_term", "search_terms"),
    ("search_keyword", "search_keyword_qs"),
    ("performance_max_placement", "pmax_placements"),
    ("landing_page", "landing_pages"),
    ("hour_of_the_day", "schedule_dow_hod"),
    ("audience_segment", "audiences"),
    ("item_id_sold", "products_sold"),
    ("product_title_sold", "products_sold"),
    ("distance_from_location_assets", "distance_from_location"),
    ("display_url_domain", "auction_insights"),
    ("state_matched", "geographic"),
    ("headline_1", "ads_performance"),
    ("keywords_active", "ad_group_performance"),
]

# canonical report set we expect per account (for the present/missing inventory)
EXPECTED_REPORTS = [
    "campaign_performance", "ad_group_performance", "search_keyword_qs",
    "search_terms", "ads_performance", "landing_pages", "schedule_dow_hod",
    "audiences", "geographic", "pmax_placements", "distance_from_location",
    "products_sold",
]


def slug(col: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", col.lower().strip()).strip("_")
    return s or "col"


def dedupe(cols):
    seen, out = {}, []
    for c in cols:
        if c in seen:
            seen[c] += 1
            out.append(f"{c}_{seen[c]}")
        else:
            seen[c] = 0
            out.append(c)
    return out


def clean(v):
    if v is None:
        return None
    v = v.strip().strip('"').strip()
    return None if v in ("--", "", "< 10%", "<0.1") else v


def to_number(v):
    if v is None:
        return None
    s = v.replace(",", "").replace("$", "").replace("%", "").strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_window(raw: str):
    """'January 1, 2025 - July 13, 2026' -> (date(2025,1,1), date(2026,7,13))."""
    if not raw:
        return None, None
    parts = re.split(r"\s+-\s+", raw.strip())
    def one(s):
        for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d"):
            try:
                return datetime.datetime.strptime(s.strip(), fmt).date()
            except ValueError:
                continue
        return None
    if len(parts) == 2:
        return one(parts[0]), one(parts[1])
    d = one(parts[0]) if parts else None
    return d, d


def detect_report(header_slugs):
    cols = set(header_slugs)
    # A keyword report segmented by geography carries BOTH a keyword column and a
    # region column -> its own type, checked before the plain keyword-QS rule.
    if "search_keyword" in cols and (cols & set(GEO_SLUGS)):
        return "keyword_geo"
    for needle, rtype in _DETECT:
        if needle in cols:
            return rtype
    # campaign performance: campaign + type, but not an ad-group/keyword report
    if "campaign" in cols and "campaign_type" in cols and "ad_group" not in cols:
        return "campaign_performance"
    return None


def _read_google_header(f):
    """Consume the 3-line Google header from an open file object.
    Returns (window_raw, cols) or (None, None) if the file is too short."""
    f.readline()                                   # line 1: report title (ignored)
    window_line = f.readline()
    header_line = f.readline()
    if not header_line:
        return None, None
    window_raw = window_line.strip().strip('"').split('",')[0].strip('"')
    header = next(csv.reader([header_line]))
    while header and header[-1].strip() == "":
        header.pop()
    return window_raw, dedupe([slug(h) for h in header])


def stream_report(path):
    """Streaming counterpart to parse_csv for large exports: returns (info, rows_iter)
    where info carries report_type/columns/window_* and rows_iter yields cleaned row
    dicts ONE AT A TIME (constant memory, no full materialization). Skips the unused
    numeric-column scan. Returns (None, None) if the file is too short to parse.

    The caller must fully consume rows_iter or call rows_iter.close() to release the
    underlying file handle. csv.reader streams over the file object, so multi-line
    quoted fields are handled correctly."""
    f = open(path, encoding="utf-8-sig")
    window_raw, cols = _read_google_header(f)
    if not cols:
        f.close()
        return None, None
    ws, we = parse_window(window_raw)
    info = dict(report_type=detect_report(cols), columns=cols, window_raw=window_raw,
                window_start=ws, window_end=we)

    def rows_iter():
        try:
            for r in csv.reader(f):
                if not r or r[0].strip().lower() == "total":
                    continue
                if all((c or "").strip() == "" for c in r):
                    continue
                r = r[: len(cols)] + [None] * (len(cols) - len(r))
                yield {c: clean(v) for c, v in zip(cols, r)}
        finally:
            f.close()

    return info, rows_iter()


def parse_csv(path):
    """Return dict(report_type, columns, rows, window_raw, window_start, window_end,
    numeric_cols) where rows is a list of dict(slug->cleaned value)."""
    p = Path(path)
    with open(p, encoding="utf-8-sig") as f:
        lines = f.readlines()
    if len(lines) < 4:
        return None
    window_raw = lines[1].strip().strip('"').split('",')[0].strip('"')
    header = next(csv.reader([lines[2]]))
    while header and header[-1].strip() == "":
        header.pop()
    cols = dedupe([slug(h) for h in header])

    rows = []
    for r in csv.reader(lines[3:]):
        if not r or r[0].strip().lower() == "total":
            continue
        if all((c or "").strip() == "" for c in r):
            continue
        r = r[: len(cols)] + [None] * (len(cols) - len(r))
        rows.append({c: clean(v) for c, v in zip(cols, r)})

    # numeric columns: >=80% of non-null values parse as numbers
    numeric = set()
    for c in cols:
        vals = [row[c] for row in rows if row[c] is not None]
        if vals and sum(1 for v in vals if to_number(v) is not None) / len(vals) >= 0.8:
            numeric.add(c)

    rtype = detect_report(cols)
    ws, we = parse_window(window_raw)
    return dict(report_type=rtype, columns=cols, rows=rows, window_raw=window_raw,
                window_start=ws, window_end=we, numeric_cols=numeric)
