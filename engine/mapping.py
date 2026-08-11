#!/usr/bin/env python3
"""Central campaign-mapping engine — the platform's single source of truth for
campaign → Brand / Region / Category (+ engine / type), per client.

Flow: when data is uploaded, every campaign seen in raw_rows is AUTO-MAPPED from
its name + the client's business context, stored with a deterministic confidence
score (0..1) and status 'pending'. The account manager then reviews in the
Campaign Mapping tab: approve, edit inline (→ source 'user', confidence 1), or
upload a mapping file (→ source 'file'). New campaigns in later uploads are
auto-mapped on sync and surfaced for review. Every view (filters, Regions,
NB Categories, KW by Region & Category, Budget Allocation) resolves campaign
dimensions through `resolver()` — mapping first, name-heuristics fallback for
anything not yet in the table. Mappings are strictly per-client.

Storage reuses bi_campaign_mappings (budget-intel already read it) extended with
source / confidence / status columns. No LLM anywhere — deterministic rules only.
"""
import datetime
import re

from sqlalchemy import select, delete, insert, update, text, inspect

from .budget_intel.tables import campaign_mappings, metadata as bi_metadata
from .budget.parse import _rows_from_csv, _rows_from_xlsx, _match_col

# ---------------------------------------------------------------- heuristics --

def region_of(name):
    """Region token parsed from a geo-tiered campaign name, e.g.
    'Search | Non-Brand | Tier A - NYC Metro Core' -> 'NYC Metro Core'. Short
    tokens (nyc, la) are upper-cased. None when the campaign carries no region."""
    m = re.search(r"tier\s+\S+\s*[-–:|]\s*(.+)$", (name or "").lower())
    if not m:
        return None
    raw = m.group(1).strip(" -–|")
    label = " ".join(w.upper() if len(w) <= 3 else w.capitalize() for w in raw.split())
    return label or None


def catkw_of(config):
    """product_categories -> {category: [keywords]} for name matching."""
    return {c: [w for w in re.findall(r"[a-z]+", c.lower()) if len(w) >= 4]
            for c in ((config or {}).get("product_categories") or [])}


def _auto_category(name, catkw, brand_terms):
    """(category_label, confidence, is_brand) from the campaign name. The branch
    that fires determines the confidence — explicit structural tokens score high,
    the catch-all 'General' scores low so reviewers know to look."""
    n = (name or "").lower()
    if "brand defense" in n or "| brand" in n or (brand_terms and any(bt in n for bt in brand_terms)):
        return "Brand", 0.95, True
    if "conquest" in n or "competitor" in n:
        return "Competitors", 0.9, False
    for cat, kws in catkw.items():
        if cat.lower() in n or any(w in n for w in kws):
            return cat[:1].upper() + cat[1:], 0.85, False
    if "non-brand" in n or "nonbrand" in n or "non brand" in n:
        return "General", 0.6, False
    if "pmax" in n or "performance max" in n:
        return "General", 0.5, False
    return "General", 0.35, False


def _auto_type(name):
    n = (name or "").lower()
    if "pmax" in n or "performance max" in n:
        return "PMax"
    if "shopping" in n:
        return "Shopping"
    if "display" in n:
        return "Display"
    return "Search"


def auto_map(name, config):
    """Deterministic auto-mapping for one campaign name. Returns the mapping row
    fields + an overall confidence (0..1): 70% category signal, 30% region signal
    (a parsed geo tier scores 0.9; no geo hint means 'All', a safe default, 0.7)."""
    config = config or {}
    brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
    category, cat_conf, is_brand = _auto_category(name, catkw_of(config), brand_terms)
    region = region_of(name)
    region_conf = 0.9 if region else 0.7
    brand_label = (config.get("brand_terms") or [None])[0]
    return {
        "brand": (brand_label[:1].upper() + brand_label[1:]) if brand_label else None,
        "region": region or "All",
        "category": category,
        "engine": "Google",
        "camp_type": _auto_type(name),
        "confidence": round(0.7 * cat_conf + 0.3 * region_conf, 2),
    }


# ------------------------------------------------------------------- storage --

_ensured = set()   # engine ids where the column migration already ran this process


def ensure_columns(engine):
    """Add source/confidence/status to bi_campaign_mappings if missing (existing
    DBs; create_all covers fresh ones). Legacy rows keep NULLs — read as
    user-entered, approved, confidence 1."""
    if id(engine) in _ensured:
        return
    engine = getattr(engine, "pg_engine", None) or engine
    bi_metadata.create_all(engine, tables=[campaign_mappings])
    have = {c["name"] for c in inspect(engine).get_columns("bi_campaign_mappings")}
    ddl = {"source": "VARCHAR(16)", "confidence": "FLOAT", "status": "VARCHAR(16)"}
    for col, typ in ddl.items():
        if col not in have:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE bi_campaign_mappings ADD COLUMN {col} {typ}"))
    _ensured.add(id(engine))


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _norm_row(r):
    """DB row -> API dict, normalizing legacy NULLs (pre-engine rows were entered
    by a user through the UI)."""
    d = dict(r)
    d["source"] = d.get("source") or "user"
    d["status"] = d.get("status") or "approved"
    d["confidence"] = 1.0 if d.get("confidence") is None else d["confidence"]
    d.pop("updated_at", None)
    return d


def _existing(conn, client_id):
    rows = conn.execute(select(campaign_mappings).where(
        campaign_mappings.c.client_id == client_id)).mappings().all()
    return {r["campaign"]: r for r in rows}


def sync(engine, client_id, config=None):
    """Auto-map every campaign present in the client's data but absent from the
    mapping table (source 'auto', status 'pending'). Existing rows — user, file,
    or prior auto — are never touched. Returns {"new": [names], "pending": n}."""
    ensure_columns(engine)
    with engine.connect() as c:
        seen = [r[0] for r in c.execute(text(
            "SELECT DISTINCT campaign FROM raw_rows WHERE client_id=:c "
            "AND campaign IS NOT NULL AND campaign<>''"), {"c": client_id}) if r[0]]
    now = _now()
    new = []
    with engine.begin() as c:
        have = set(_existing(c, client_id))
        for camp in seen:
            if camp in have:
                continue
            a = auto_map(camp, config)
            c.execute(insert(campaign_mappings).values(
                client_id=client_id, campaign=camp, brand=a["brand"], region=a["region"],
                category=a["category"], engine=a["engine"], camp_type=a["camp_type"],
                source="auto", confidence=a["confidence"], status="pending", updated_at=now))
            new.append(camp)
        pending = sum(1 for r in _existing(c, client_id).values()
                      if (r["status"] or "approved") == "pending")
    return {"new": new, "pending": pending}


def get_all(engine, client_id):
    """Every mapping row (normalized) + counts, sorted pending-first then by name."""
    ensure_columns(engine)
    with engine.connect() as c:
        rows = [_norm_row(r) for r in _existing(c, client_id).values()]
    rows.sort(key=lambda r: (0 if r["status"] == "pending" else 1, r["campaign"]))
    pending = sum(1 for r in rows if r["status"] == "pending")
    return {"mappings": rows, "pending": pending, "total": len(rows)}


def save_user(engine, client_id, rows, source="user"):
    """Upsert user-edited (or file-loaded) rows: full-row replace per campaign,
    approved, confidence 1 — a human said so, so it overrides auto."""
    ensure_columns(engine)
    now = _now()
    with engine.begin() as c:
        for r in rows:
            c.execute(delete(campaign_mappings).where(
                (campaign_mappings.c.client_id == client_id)
                & (campaign_mappings.c.campaign == r["campaign"])))
            c.execute(insert(campaign_mappings).values(
                client_id=client_id, campaign=r["campaign"],
                brand=r.get("brand"), region=r.get("region"), category=r.get("category"),
                engine=r.get("engine"), camp_type=r.get("camp_type"),
                source=source, confidence=1.0, status="approved", updated_at=now))
    return len(rows)


def approve(engine, client_id, campaigns=None):
    """Approve pending auto-mappings (all, or just `campaigns`). Keeps source and
    confidence — approval records review, not a value change."""
    ensure_columns(engine)
    w = ((campaign_mappings.c.client_id == client_id)
         & (campaign_mappings.c.status == "pending"))
    if campaigns:
        w = w & campaign_mappings.c.campaign.in_(list(campaigns))
    with engine.begin() as c:
        n = c.execute(update(campaign_mappings).where(w).values(
            status="approved", updated_at=_now())).rowcount
    return n or 0


def pending_counts(engine, client_id):
    """{pending, total} for the bundle meta badge; None if the table isn't there yet."""
    try:
        ensure_columns(engine)
        with engine.connect() as c:
            rows = c.execute(select(campaign_mappings.c.status).where(
                campaign_mappings.c.client_id == client_id)).all()
    except Exception:   # noqa: BLE001 — meta badge must never break a bundle build
        return None
    total = len(rows)
    pending = sum(1 for (s,) in rows if (s or "approved") == "pending")
    return {"pending": pending, "total": total}


# --------------------------------------------------------------- file upload --

_MAP_HDR = {
    "campaign": ("campaign",),
    "brand": ("brand", "bu", "business unit", "account"),
    "region": ("region", "state", "market", "metro", "geo", "territory"),
    "category": ("category", "categories", "cat", "product", "line", "vertical", "service"),
    "engine": ("engine", "network", "platform"),
    "camp_type": ("type", "format"),
}


def parse_mapping_file(data, filename):
    """Parse an uploaded mapping document (CSV/XLSX with a Campaign column plus
    any of Brand/Region/Category/Engine/Type) into upsert rows."""
    name = (filename or "").lower()
    rows = _rows_from_xlsx(data) if name.endswith(".xlsx") else _rows_from_csv(data)
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if len(rows) < 2:
        raise ValueError("mapping file has no data rows")
    header_idx, cols = None, None
    for i, r in enumerate(rows[:5]):
        c = {k: _match_col(r, keys) for k, keys in _MAP_HDR.items()}
        if c["campaign"] is not None and any(c[k] is not None for k in ("brand", "region", "category")):
            header_idx, cols = i, c
            break
    if cols is None:
        raise ValueError("could not detect a Campaign column plus at least one of Brand/Region/Category")
    out = []
    for r in rows[header_idx + 1:]:
        def cell(key):
            idx = cols[key]
            if idx is None or idx >= len(r):
                return None
            v = str(r[idx]).strip()
            return v or None
        camp = cell("campaign")
        if not camp:
            continue
        out.append({"campaign": camp, "brand": cell("brand"), "region": cell("region"),
                    "category": cell("category"), "engine": cell("engine"),
                    "camp_type": cell("camp_type")})
    if not out:
        raise ValueError("no valid mapping rows found")
    return out


# ------------------------------------------------------------------ resolver --

_ALL = ("", "all", "-", "—")


class Resolver:
    """campaign -> dimensions, mapping-first with name-heuristic fallback. This is
    what every view consumes, so the mapping table is the one place attribution
    lives. Region 'All' means account-wide (not a region slice) -> None."""

    def __init__(self, rows, config):
        self.map = {r["campaign"]: r for r in rows if r.get("campaign")}
        config = config or {}
        self.brand_terms = [b.lower() for b in (config.get("brand_terms") or []) if b]
        self.catkw = catkw_of(config)
        bl = (config.get("brand_terms") or [None])[0]
        self.brand_label = (bl[:1].upper() + bl[1:]) if bl else None

    def lookup(self, name):
        return self.map.get(name)

    def known(self, name):
        return name in self.map

    def is_brand(self, name):
        m = self.lookup(name)
        if m and (m.get("category") or "").strip():
            return m["category"].strip().lower() == "brand"
        return _auto_category(name, self.catkw, self.brand_terms)[2]

    def category(self, name):
        m = self.lookup(name)
        if m and (m.get("category") or "").strip():
            return m["category"].strip()
        return _auto_category(name, self.catkw, self.brand_terms)[0]

    def nb_category(self, name):
        """Category for non-brand views; None for brand campaigns (excluded)."""
        return None if self.is_brand(name) else self.category(name)

    def region(self, name):
        m = self.lookup(name)
        if m and m.get("region") is not None:
            r = str(m["region"]).strip()
            return None if r.lower() in _ALL else r
        return region_of(name)

    def brand(self, name):
        m = self.lookup(name)
        return (m.get("brand") or self.brand_label) if m else self.brand_label

    def camp_type(self, name):
        m = self.lookup(name)
        t = (m.get("camp_type") or "").strip() if m else ""
        return t or None

    def is_shopping(self, name):
        """True for Shopping / Performance Max campaigns (a feed + products, not keywords)."""
        t = (self.camp_type(name) or "").lower()
        return "shop" in t or "pmax" in t or "performance max" in t

    @property
    def types(self):
        return sorted({str(m["camp_type"]).strip() for m in self.map.values()
                       if m.get("camp_type") and str(m["camp_type"]).strip()})

    @property
    def regions(self):
        return sorted({str(m["region"]).strip() for m in self.map.values()
                       if m.get("region") and str(m["region"]).strip().lower() not in _ALL})

    @property
    def categories(self):
        return sorted({str(m["category"]).strip() for m in self.map.values()
                       if m.get("category") and str(m["category"]).strip()})

    @property
    def brands(self):
        return sorted({str(m["brand"]).strip() for m in self.map.values()
                       if m.get("brand") and str(m["brand"]).strip()})


def resolver(engine, client_id, config=None):
    """Build the Resolver for a client. engine=None (or a missing table) yields a
    pure-fallback resolver, so callers never crash on an un-migrated DB."""
    rows = []
    if engine is not None:
        try:
            ensure_columns(engine)
            with engine.connect() as c:
                rows = [dict(r) for r in _existing(c, client_id).values()]
        except Exception:   # noqa: BLE001 — resolution must never break a bundle build
            rows = []
    return Resolver(rows, config)
