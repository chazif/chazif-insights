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
    "account_spend": "account_name",
    "distance_from_location": "distance_from_location_assets",
    "auction_insights": "display_url_domain",
    "schedule_dow_hod": None,
    "bid_strategies": "bid_strategy",
}
# Row-level calendar date column, detected generically for ANY report (finest first).
# 'day'/'week' are literal calendar columns; schedule's "Day of the week" slugs to
# 'day_of_the_week', so it isn't matched here (correct — that's categorical, not a date).
DATE_SLUGS = ("day", "date", "week", "month")


def date_column(columns):
    """The report's row-level calendar date column, or None if it isn't date-segmented."""
    cols = set(columns)
    return next((s for s in DATE_SLUGS if s in cols), None)


_MONTHS_FULL = {m: i for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"], 1)}
_MONTHS_ABBR = {m[:3]: i for m, i in _MONTHS_FULL.items()}


def infer_date_order(values):
    """'dmy' vs 'mdy' for D/M or M/D slash dates: scan for a disambiguating component
    (>12); default 'mdy' (Google US) if none found. Short-circuits on first hit."""
    for v in values:
        m = re.match(r"^\s*(\d{1,2})/(\d{1,2})/\d{2,4}\s*$", str(v or ""))
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > 12:
                return "dmy"
            if b > 12:
                return "mdy"
    return "mdy"


def normalize_date(raw, order="mdy"):
    """Google date cell -> datetime.date (day precision; month-only -> 1st); None if
    unparseable. Accepts 'March 2026'/'Mar 2026', '2026-03'/'2026-03-15'/'2026/03/15',
    'M/YYYY', and day dates '23/10/2025' / '10/23/2025' (order-disambiguated)."""
    if not raw:
        return None
    s = str(raw).strip()
    y = mo = d = None
    m = re.match(r"^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$", s)          # 2026-03 / 2026-03-15 / 2026/03/15
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3) or 1)
    elif re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s):                # D/M/Y or M/D/Y
        a, b, yr = (int(x) for x in re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", s).groups())
        y = yr + (2000 if yr < 100 else 0)
        d, mo = (a, b) if order == "dmy" else (b, a)
        if not 1 <= mo <= 12:                                            # impossible month -> swap
            mo, d = d, mo
    elif re.match(r"^(\d{1,2})/(\d{2,4})$", s):                          # M/YYYY
        mm, yr = (int(x) for x in re.match(r"^(\d{1,2})/(\d{2,4})$", s).groups())
        y, mo, d = yr + (2000 if yr < 100 else 0), mm, 1
    else:
        parts = s.split()                                               # March 2026 / Mar 2026
        if len(parts) == 2:
            mo = _MONTHS_FULL.get(parts[0].lower()) or _MONTHS_ABBR.get(parts[0][:3].lower())
            try:
                y, d = int(parts[1]), 1
            except ValueError:
                return None
    if not (y and mo):
        return None
    try:
        return datetime.date(y, mo, d)
    except ValueError:
        try:
            return datetime.date(y, mo, 1)
        except ValueError:
            return None

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
    # Budget Intelligence (docs/budget-intel): bid-strategy exports carry tCPA
    ("bid_strategy_type", "bid_strategies"),
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
    # NB: "< 10%" is kept (not nulled) — it's a Google impression-share bucket that
    # impr_share_frac() maps to 0.05. It only ever appears in share columns.
    return None if v in ("--", "", "<0.1") else v


# Column slugs that carry a Search impression share (entity reports: campaign / ad
# group / keyword). NOT the auction-insights one (search_impr_share_auction_insights),
# which is handled separately with a campaign×day join.
SHARE_SLUGS = ("search_impr_share", "search_impression_share", "impr_share", "impression_share")


def impr_share_frac(v):
    """Impression-share cell -> fraction. Google buckets the extremes and can't give an
    exact value there, so (per product decision) '< 10%' -> 0.05 and '> 90%' -> 0.95.
    '34.78%' -> 0.3478; '--'/blank -> None."""
    if v is None:
        return None
    s = str(v).replace("%", "").replace(",", "").strip()
    if s in ("", "--", "-"):
        return None
    if s.startswith("<"):
        return 0.05
    if s.startswith(">"):
        return 0.95
    try:
        return float(s) / 100.0
    except ValueError:
        return None


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


def is_total_row(first_cell):
    """Google's trailing totals row. The first cell is 'Total' or 'Total: <report>'
    (older exports) — matching only the exact word missed the 'Total:' form, letting a
    totals row leak in and inflate sums."""
    s = (first_cell or "").strip().lower()
    return s == "total" or s.startswith("total:")


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
    # campaign report without a type column but carrying impression share (the
    # Budget Intelligence "Campaign - Raw" export shape) — same report type
    if "campaign" in cols and "ad_group" not in cols and (cols & set(SHARE_SLUGS)):
        return "campaign_performance"
    # MCC account-level daily-spend / "Pacing" export: a date + cost tagged by account,
    # with no campaign / ad-group / keyword breakdown. Feeds daily pacing.
    if "cost" in cols and (cols & (set(ACCOUNT_ID_SLUGS) | set(ACCOUNT_NAME_SLUGS))) \
            and not (cols & {"campaign", "ad_group", "search_keyword", "search_term"}):
        return "account_spend"
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
                if not r or is_total_row(r[0]):
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
        if not r or is_total_row(r[0]):
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


def read_csv_header(path):
    """Cheap header-only read: parse just the 3-line preamble (title, date range,
    column row) and return report_type/columns/window WITHOUT loading any data rows.
    Constant memory regardless of file size. Returns None if the file is too short.

    Use this + iter_csv_rows() instead of parse_csv() when you don't need the whole
    file materialized (e.g. previewing/counting a large MCC export) — parse_csv reads
    the entire file into a list of dicts and will OOM the worker on big exports."""
    p = Path(path)
    with open(p, encoding="utf-8-sig") as f:
        f.readline()                      # line 0: report title
        line1 = f.readline()              # line 1: date range
        line2 = f.readline()              # line 2: column header
        if not line2:
            return None
    window_raw = line1.strip().strip('"').split('",')[0].strip('"')
    header = next(csv.reader([line2]))
    while header and header[-1].strip() == "":
        header.pop()
    cols = dedupe([slug(h) for h in header])
    ws, we = parse_window(window_raw)
    return dict(report_type=detect_report(cols), columns=cols, window_raw=window_raw,
                window_start=ws, window_end=we)


def iter_csv_rows(path, cols):
    """Stream the data rows (everything after the 3-line preamble) one dict at a time,
    slug->cleaned value, keyed by `cols` (from read_csv_header). Constant memory: never
    builds a list. Skips Total/blank rows exactly like parse_csv. Multi-line quoted
    fields are handled because csv.reader consumes the file iterator directly."""
    p = Path(path)
    with open(p, encoding="utf-8-sig") as f:
        f.readline(); f.readline(); f.readline()     # skip the 3-line preamble
        for r in csv.reader(f):
            if not r or is_total_row(r[0]):
                continue
            if all((c or "").strip() == "" for c in r):
                continue
            r = r[: len(cols)] + [None] * (len(cols) - len(r))
            yield {c: clean(v) for c, v in zip(cols, r)}
