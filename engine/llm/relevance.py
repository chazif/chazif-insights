#!/usr/bin/env python3
"""Search-term relevance classification.

The one scoped-AI step: given only the search-term TEXT + the business context
(what they sell, brand, competitors) — never account data or credentials — decide
whether each term is relevant to the business, for negative-keyword decisions.

Backends:
  * LLM (Anthropic) when ANTHROPIC_API_KEY is set — the real classifier.
  * Deterministic heuristic otherwise — keyword overlap with the product categories.
Results are cached per (client, term) so the LLM is called at most once per term.
"""
import os
import re
import json
import datetime
import urllib.request
from sqlalchemy import select, insert
from ..ingest.store import term_relevance

# Providers, in priority order: DeepSeek (OpenAI-compatible) -> Anthropic -> heuristic.
ANTHROPIC_MODEL = os.environ.get("RELEVANCE_MODEL", "claude-haiku-4-5-20251001")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_URL = os.environ.get("DEEPSEEK_URL", "https://api.deepseek.com/chat/completions")
MAX_TERMS = 40  # bound the classification set per build (cost/latency)


def _provider():
    if os.environ.get("DEEPSEEK_API_KEY"):
        return "deepseek"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    return None


def _keywords(categories):
    """Significant words from the product categories, for the heuristic backend."""
    stop = {"and", "the", "for", "goods", "supplies", "store", "products", "items"}
    kw = set()
    for cat in categories:
        for w in re.findall(r"[a-z]+", cat.lower()):
            if len(w) >= 4 and w not in stop:
                kw.add(w)
                if w.endswith("s"):
                    kw.add(w[:-1])   # crude singular
    return kw


def _classify_heuristic(terms, context):
    brand = [b.lower() for b in context.get("brand_terms", [])]
    conquest = [c.lower() for c in context.get("competitors_conquest", [])]
    kw = _keywords(context.get("product_categories", []))
    out = {}
    for t in terms:
        tl = (t or "").lower()
        words = set(re.findall(r"[a-z]+", tl))
        if brand and any(b in tl for b in brand):
            out[t] = {"relevant": True, "category": "brand", "reason": "brand term", "source": "heuristic"}
        elif conquest and any(c in tl for c in conquest):
            out[t] = {"relevant": True, "category": "competitor", "reason": "competitor term", "source": "heuristic"}
        elif kw and (words & kw):
            out[t] = {"relevant": True, "category": "product", "reason": "matches a product category", "source": "heuristic"}
        else:
            out[t] = {"relevant": False, "category": "unrelated", "reason": "no product/brand match", "source": "heuristic"}
    return out


def _build_prompt(terms, context):
    cats = ", ".join(context.get("product_categories", [])) or "(not specified)"
    brand = ", ".join(context.get("brand_terms", [])) or "(none)"
    listing = "\n".join(f"- {t}" for t in terms)
    return (
        "You classify Google Ads search terms as relevant or not to a business, to decide "
        "negative keywords. Be strict: a term is relevant only if someone searching it could "
        "plausibly buy from this business.\n\n"
        f"The business sells: {cats}.\nBrand names: {brand}.\n\n"
        "Return ONLY a JSON array, one object per term, no prose:\n"
        '[{"term":"<verbatim>","relevant":true|false,"category":"product|brand|competitor|unrelated","reason":"<max 8 words>"}]\n\n'
        f"Terms:\n{listing}"
    )


def _parse_response(text, terms, context, source):
    m = re.search(r"\[.*\]", text, re.S)
    data = json.loads(m.group(0) if m else text)
    out = {}
    for row in data:
        term = row.get("term")
        if term is None:
            continue
        out[term] = {"relevant": bool(row.get("relevant")),
                     "category": str(row.get("category", "unrelated"))[:64],
                     "reason": str(row.get("reason", ""))[:512], "source": source}
    missing = [t for t in terms if t not in out]   # anything the model dropped
    if missing:
        out.update(_classify_heuristic(missing, context))
    return out


def _classify_deepseek(terms, context):
    key = os.environ["DEEPSEEK_API_KEY"]
    body = json.dumps({"model": DEEPSEEK_MODEL, "temperature": 0, "max_tokens": 2000,
                       "messages": [{"role": "user", "content": _build_prompt(terms, context)}]}).encode("utf-8")
    req = urllib.request.Request(DEEPSEEK_URL, data=body, method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = payload["choices"][0]["message"]["content"]
    return _parse_response(text, terms, context, "deepseek")


def _classify_anthropic(terms, context):
    import anthropic  # lazy; only when a key is present
    client = anthropic.Anthropic()
    msg = client.messages.create(model=ANTHROPIC_MODEL, max_tokens=2000,
                                 messages=[{"role": "user", "content": _build_prompt(terms, context)}])
    text = "".join(getattr(b, "text", "") for b in msg.content)
    return _parse_response(text, terms, context, "llm")


def classify_terms(terms, context):
    p = _provider()
    try:
        if p == "deepseek":
            return _classify_deepseek(terms, context)
        if p == "anthropic":
            return _classify_anthropic(terms, context)
    except Exception:
        pass  # any LLM / network error -> deterministic fallback
    return _classify_heuristic(terms, context)


def get_or_classify(engine, client_id, terms, context):
    """Cache-first: return {term: {relevant, category, reason, source}} for the given
    terms, classifying (and caching) any not seen before. Bounded to MAX_TERMS."""
    terms = [t for t in terms if t][:MAX_TERMS]
    if not terms:
        return {}
    with engine.connect() as c:
        rows = c.execute(select(term_relevance).where(
            (term_relevance.c.client_id == client_id) & (term_relevance.c.term.in_(terms)))).all()
    cache = {r.term: {"relevant": r.relevant == "yes", "category": r.category,
                      "reason": r.reason, "source": r.source} for r in rows}
    missing = [t for t in terms if t not in cache]
    if missing:
        fresh = classify_terms(missing, context)
        now = datetime.datetime.now(datetime.timezone.utc)
        payload = [{"client_id": client_id, "term": t,
                    "relevant": "yes" if v["relevant"] else "no",
                    "category": v.get("category"), "reason": v.get("reason"),
                    "source": v.get("source"), "classified_at": now}
                   for t, v in fresh.items()]
        if payload:
            with engine.begin() as c:
                c.execute(insert(term_relevance), payload)
        cache.update(fresh)
    return cache
