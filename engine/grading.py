#!/usr/bin/env python3
"""Account-relative grading.

The old grades used hard-coded absolute bands (e.g. LP "Average" = 20–30% CVR).
Those quietly assume an industry / intent / seasonality profile we can't know, so
an account whose CVR genuinely runs 0–16% grades entirely "Below Average" — which
tells you nothing about *which* entities to act on. A grade's real job is triage
*within the account*.

So we grade each entity against **its own cohort's distribution**: the anchor is the
cohort's volume-weighted median (its data already embodies its industry, intent mix,
and season), and bands are ratios of that anchor. "C" means "around the norm for this
account"; A / F mean genuine outliers. Guardrails keep it honest (volume gates,
zero-conversion floor, small-cohort fallback to the static bands). An account manager
can override the anchor with a manual industry benchmark.

Deterministic — no AI. See docs/GRADING_LOGIC.md.
"""

# Ratio bands: value ÷ cohort-anchor → label. Descending; the last entry is the floor.
GRADE_BANDS = [(1.5, "A — Top Performer"), (1.15, "B — Good"), (0.85, "C — Average"),
               (0.5, "D — Below Average"), (0.0, "F — Poor / No Conversions")]
# Landing-page Score uses its own 4-label vocabulary.
SCORE_BANDS = [(1.5, "Excellent"), (1.15, "Strong"), (0.85, "Average"), (0.0, "Below Avg")]

MIN_COHORT = 5          # fewer gradeable entities than this → fall back to static bands
ZERO_CONV_CLICKS = 20   # ≥ this many clicks with 0 conversions → forced floor grade


def median(values):
    """Plain median of `values`. None if empty. Used where each entity should count once
    (CTR: weighting by impressions lets a few high-impression campaigns drag the anchor down
    and inflate everyone else to A)."""
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return None
    n = len(vs)
    return vs[n // 2] if n % 2 else (vs[n // 2 - 1] + vs[n // 2]) / 2.0


def wmedian(pairs):
    """Volume-weighted median of (value, weight) pairs (weight ≤ 0 ignored). None if empty.
    Weighting by clicks means a high-traffic entity anchors more than a tiny one — the right
    "typical" for CVR, where the business norm is 'where half the traffic converts'."""
    vw = sorted((v, w) for v, w in pairs if w and w > 0)
    if not vw:
        return None
    half = sum(w for _, w in vw) / 2.0
    acc = 0.0
    for v, w in vw:
        acc += w
        if acc >= half:
            return v
    return vw[-1][0]


def grade_by_ratio(value, anchor, bands):
    """Grade `value` as a multiple of `anchor` against `bands`. None if anchor ≤ 0."""
    if not anchor or anchor <= 0:
        return None
    r = value / anchor
    for mn, g in bands:
        if r >= mn:
            return g
    return bands[-1][1]


def cohort_grader(rows, *, rate, in_scope, static_fn, bands, weight=None,
                  mode="relative", benchmark=None, zero_conv=None, min_cohort=MIN_COHORT):
    """Return `(grade_of, meta)`.

    `grade_of(row) -> label` is a drop-in replacement for the static grader: it applies the
    same volume gate (delegating to `static_fn` when a row is out of scope, so the Low
    Volume / "—" label is preserved), then grades the row relative to the cohort anchor or a
    manual `benchmark`. The anchor is the volume-weighted median when `weight` is given (CVR),
    else a plain median (CTR — so a few high-impression campaigns can't drag it down and
    inflate everyone to A).

    Falls back to `static_fn` entirely when: mode == 'static'; the cohort has fewer than
    `min_cohort` gradeable rows; or the anchor is zero/unknown. `meta` reports the anchor and
    the A/C thresholds for the UI caption. `rate`/`in_scope`/`weight`/`zero_conv` are callables
    on a row; `static_fn(row) -> label`."""
    if mode == "static":
        return static_fn, {"mode": "static", "anchor": None}
    scoped = [r for r in rows if in_scope(r)]
    is_bench = bool(benchmark and benchmark > 0)
    if is_bench:
        anchor = benchmark
    elif weight is None:
        anchor = median([rate(r) for r in scoped])
    else:
        anchor = wmedian([(rate(r), weight(r)) for r in scoped])
    if not anchor or anchor <= 0 or (not is_bench and len(scoped) < min_cohort):
        return static_fn, {"mode": "static", "anchor": None,
                           "reason": "small_cohort" if scoped else "no_data"}
    floor = bands[-1][1]

    def grade_of(r):
        if not in_scope(r):
            return static_fn(r)
        if zero_conv and zero_conv(r):
            return floor
        return grade_by_ratio(rate(r), anchor, bands) or static_fn(r)

    return grade_of, {"mode": "benchmark" if is_bench else "relative", "anchor": round(anchor, 4),
                      "a_min": round(anchor * 1.5, 4), "c_lo": round(anchor * 0.85, 4),
                      "c_hi": round(anchor * 1.15, 4), "n": len(scoped),
                      "labels": [b[1] for b in bands]}
