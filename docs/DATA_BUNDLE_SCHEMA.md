# DATA Bundle Schema — v0.1 (as-extracted)

The **bundle** is the single JSON contract between the engine (producer) and the
frontend (consumer). The frontend fetches one bundle per `(client, period)` from
`GET /api/bundle` and renders every view from it — no computation in the browser.

> **Status:** v0.1 is *descriptive* — reverse-engineered from the Mavis
> single-file dashboard (48 top-level keys, ~20 MB for a 5-brand account). It is
> the ground truth the engine must reproduce. It will be *formalized* (typed,
> versioned, with a `meta` block and a complexity profile) as the engine is built
> in Phase 2. Keys marked **by_brand** are objects keyed by brand code; their
> absence is how single-brand accounts naturally degrade.

## Envelope (to add in v0.2)
A `meta` block will front the bundle: `schema_version`, `client`, `period`,
`generated_at`, `account_type`, and the **complexity profile** (brand/market/
category counts, `brands_share_zips`, `has_pmax`, `devices_tracked`) that decides
which views render.

## Keys by view group

### Account & brand overview
| Key | Type | Feeds |
|---|---|---|
| `kpis` | array | Overview scorecard (Metric / prior / current / change / trend) |
| `total_trend` | array | Overview + Monthly Trends charts (15-mo: Spend, Clicks, Main Conv, CPA, CVR) |
| `brand_trends` | object · by brand | Same charts, brand-filtered |
| `search_trend` / `pmx_trend` | array | Campaign-type trend split |
| `campaign_type_search_totals` / `campaign_type_pmx_totals` | object | Overview campaign-type totals |
| `campaign_type_search_by_brand` / `campaign_type_pmx_by_brand` | object · by brand | Campaign-type split per brand |
| `brand_yoy` | array | All Brands · YoY comparison |
| `brand_regions` | object · by brand | Brand Detail · region YoY |
| `brand_region_category` | object · by brand | Brand Detail / Regions category cut |
| `region_performance` | object · by brand | Regions view |
| `nb_categories` / `nb_category_list` | object / array | NB Categories |
| `findings` | array | Overview "Key findings" |

### Keyword & Quality Score
| Key | Type | Feeds |
|---|---|---|
| `keyword_deep_dive` | object | Keyword Deep Dive |
| `keyword_status_summary` | object | Keyword status totals |
| `qs_overview` | object | QS Overview (kpis, distribution, buckets) |
| `qs_breakdown` | object | QS Breakdown (components, three-component grid, opportunities, savings) |
| `qs_region_category` | object | Region & Category CPC-by-component |

### Search terms
| Key | Type | Feeds |
|---|---|---|
| `intent_summary` / `intent_summary_by_brand` | object | Intent & Grades summary |
| `performance_grades` / `performance_grades_by_brand` | array / object | Grade term counts |
| `service_categories` / `service_categories_by_brand` | array / object | Service categories by spend |
| `competitor_breakdown` / `competitor_breakdown_by_brand` | array / object | Competitor type summary |
| `relevant_terms` | array | Relevant Terms |
| `competitor_terms` | array | Competitor Terms |
| `flagged_terms` | array | Flagged / Review |

### Ads
| Key | Type | Feeds |
|---|---|---|
| `ad_copy_rows` | array | Ad Copy (row-level, 8k+ rows for Mavis) |
| `ad_copy_grade_summary` / `_by_brand` | object | Ad Copy grade summary |
| `ad_lp_pairing_grid` / `_by_brand` | object | Ad ↔ LP Pairing grid |
| `lp_mismatches` | array | Ad ↔ LP final-URL mismatches |

### Landing pages
| Key | Type | Feeds |
|---|---|---|
| `landing_pages` | array | LP Performance |
| `lp_categories` / `lp_category_cols` | array | LP Category Grid |
| `lp_device` | array | LP Device Grid |

### Geo
| Key | Type | Feeds |
|---|---|---|
| `zip_overlap_grid` / `zip_overlap_cat_cols` | array | ZIP Overlap Grid |
| `zip_state_map` | object | ZIP → state/city lookup |
| `brand_overlap_regions` | array | Brand overlap by region |
| `overlap_summary` | array | Overlap summary tiles |
| *(planned)* `geo_performance` | object | **Geo Performance** — presence/interest × region/metro/city/ZIP |

### Output
| Key | Type | Feeds |
|---|---|---|
| `recommendations` | array | Recommendations (Priority, Category, Recommendation, Rationale, Expected Impact, Effort) |

## Notes for the engine (Phase 2)
- The frontend already tolerates missing keys (`DATA.foo || []`), which is the
  mechanism behind graceful degradation — the engine simply omits keys for
  dimensions a client lacks.
- `recommendations` and `findings` are the seed of the structured recommendation
  objects; Phase 5 adds a stable id + lifecycle state to each.
- Row-heavy keys (`ad_copy_rows`, `zip_state_map`) dominate bundle size; when the
  API era arrives, consider lazy per-view endpoints for the largest tables.
