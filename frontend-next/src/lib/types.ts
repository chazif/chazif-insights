// Typed slices of the DATA bundle the FastAPI backend returns. Grows as screens are built.

export interface CampaignRow {
  campaign: string;
  type: string;
  clicks: number;
  cost: number;
  conv: number;
  cpa: number;
  cvr: number;
  share: number; // cost / total_cost (0..1)
  prior_conv: number | null;
  d_conv: number | null; // MoM conversion change (fraction), null if no prior
}

export interface CampaignsSection {
  month: string;
  prior_month: string;
  rows: CampaignRow[];
  totals: { clicks: number; cost: number; conv: number };
}

export interface KpiRow {
  Metric: string;
  Change: number | null;
  [k: string]: unknown;
}

export interface BundleMeta {
  client_id: string;
  name: string;
  periods?: { current?: string; prior?: string };
  compare?: { mode?: string; label?: string };
  [k: string]: unknown;
}

export interface IntentSegment {
  name: string;
  terms: number;
  spend: number;
  spend_share: number; // 0..1
}
export interface GradeRow {
  grade: string; // e.g. "A — Top Performer"
  terms: number;
  spend: number;
  spend_share: number;
  conv: number;
  cpa: number | null;
}
interface TermBase {
  term: string;
  campaign: string | null;
  ad_group: string | null;
  search_keyword: string | null;
  spend: number;
  clicks: number;
  conv: number;
  cvr: number;
}
export interface RelevantTerm extends TermBase {
  category: string;
  grade: string;
  status: string;
  cpc: number;
}
export interface CompetitorTerm extends TermBase {
  competitor: string;
  cpa: number | null;
}
export interface FlaggedTerm extends TermBase {
  intent: string;
  status: string;
  cpa: number | null;
}

export interface SearchTermsSection {
  total_spend: number;
  total_terms: number;
  source: string;
  intent_segments: IntentSegment[];
  grades: GradeRow[];
  relevant_terms: RelevantTerm[];
  competitor_terms: CompetitorTerm[];
  flagged_terms: FlaggedTerm[];
  relevant_total?: number;
  competitor_total?: number;
  flagged_total?: number;
  [k: string]: unknown;
}

export interface TrendPoint {
  Month: string;
  Spend: number;
  Clicks: number;
  "Main Conv": number;
  CPA: number;
  CVR: number;
}

export interface LpRow {
  url: string;
  cost: number;
  clicks: number;
  conv: number;
  cvr: number;
  cpa: number | null;
  score: string;
}

export interface GeoRow {
  location: string;
  clicks: number;
  impr: number;
  conv: number;
  conv_value: number;
  cost: number;
  cpa: number;
  cvr: number;
  ctr: number;
}
export interface GeoSection {
  dimension: string;
  rows: GeoRow[];
  totals: { clicks: number; impr: number; conv: number; conv_value: number; cost: number };
}

// ---- Non-Brand Categories ----
export interface NbCatRow {
  category: string;
  spend_prior: number;
  spend_cur: number;
  spend_chg: number | null;
  conv_prior: number;
  conv_cur: number;
  conv_chg: number | null;
  cpa_prior: number;
  cpa_cur: number;
  cpa_chg: number | null;
}
export interface NbCategoriesSection {
  prior_label: string;
  cur_label: string;
  rows: NbCatRow[];
  totals: NbCatRow;
}

// ---- Regions ----
export interface RegionCell {
  region: string;
  category: string;
  spend_prior: number;
  spend_cur: number;
  conv_prior: number;
  conv_cur: number;
}
export interface RegionsSection {
  prior_label: string;
  cur_label: string;
  categories: string[];
  cells: RegionCell[];
}

// ---- Keyword Deep Dive ----
export interface KeywordRow {
  keyword: string;
  match: string;
  qs: number | null;
  clicks: number;
  cost: number;
  conv: number;
  cpa: number;
}
export interface KwComponentRow {
  rating: string;
  keywords: number;
  cost: number;
}
export interface KeywordSection {
  deep_dive: KeywordRow[];
  components: Record<string, KwComponentRow[]>;
  below_ctr_spend: number;
  savings_estimate: number;
}

// ---- Quality Score ----
export interface QsPerRow {
  qs: number;
  keywords: number;
  kw_share: number;
  cost: number;
  spend_share: number;
  clicks: number;
  conv: number;
  cpc: number;
  ctr: number;
  conv_rate: number;
  cpa: number;
}
export interface QsBucket extends QsPerRow {
  label: string;
  lo: number;
  hi: number;
  color: string;
}
export interface QsTrendPoint {
  month: string;
  avg_qs: number;
  keywords: number;
}
export interface QualityScoreSection {
  month: string;
  non_brand: boolean;
  avg_qs: number;
  total_keywords: number;
  pct_weak: number;
  pct_strong: number;
  savings: { amount: number; cpc_weak: number; cpc_qs7: number };
  per_qs: QsPerRow[];
  buckets: QsBucket[];
  trend: QsTrendPoint[];
  totals: { keywords: number; cost: number; clicks: number; conv: number; cpc: number; ctr: number; conv_rate: number; cpa: number };
}

// ---- Quality Score by Component ----
export interface QsComponentRating {
  rating: string;
  keywords: number;
  kw_share: number;
  spend: number;
  cpc: number;
  ctr: number;
  conv_rate: number;
  cpa: number;
  conv: number;
  cpc_vs_avg: number | null;
}
export interface QsComponent {
  key: string;
  label: string;
  num: number;
  ratings: QsComponentRating[];
}
export interface QsOptKeyword {
  keyword: string;
  brand: string;
  region: string;
  category: string;
  qs: number;
  spend: number;
  clicks: number;
  cpc: number;
  ectr: string;
  ad_rel: string;
  lp_exp: string;
  conv: number;
}
export interface QsSavingsRow {
  brand: string;
  kws_weak: number;
  spend_weak: number;
  cpc_current: number;
  cpc_target: number;
  savings: number;
  pct_brand_spend: number;
  primary_gap: string;
}
export interface QsBreakdownSection {
  month: string;
  non_brand: boolean;
  avg_cpc: number;
  components: QsComponent[];
  savings_by_brand: QsSavingsRow[];
  opt_keywords: { total: number; shown: number; categories: string[]; regions: string[]; has_region: boolean; rows: QsOptKeyword[] };
}

// ---- KW by Region & Category ----
export interface RegCatRow {
  brand: string;
  region: string;
  category: string;
  total_spend: number;
  below_cpc: number | null;
  below_clicks: number;
  avg_cpc: number | null;
  avg_clicks: number;
  above_cpc: number | null;
  above_clicks: number;
  spread: number | null;
}
export interface RegCatComponent {
  key: string;
  label: string;
  total: number;
  rows: RegCatRow[];
}
export interface RegionCategorySection {
  components: RegCatComponent[];
  categories: string[];
  regions: string[];
}

// ---- Ad Copy ----
export interface AdGradeRow {
  grade: string;
  ads: number;
  impr: number;
  clicks: number;
  ctr: number;
  spend: number;
  spend_share: number;
  conv: number;
  cvr: number;
}
export interface AdRow {
  brand: string;
  category: string;
  region: string;
  ad_group: string;
  headline: string;
  grade: string;
  ctr_grade: string;
  lp_grade: string;
  ctr: number;
  impr: number;
  clicks: number;
  cpc: number;
  spend: number;
  conv: number;
  cvr: number;
}
export interface PairingCell {
  cvr_grade: string;
  ads: number;
  spend: number;
  pct: number;
}
export interface PairingRow {
  ctr_grade: string;
  cols: PairingCell[];
  total_ads: number;
  total_spend: number;
}
export interface AdPairing {
  grades: string[];
  rows: PairingRow[];
  col_totals: { cvr_grade: string; ads: number; spend: number }[];
  grand_ads: number;
  grand_spend: number;
}
export interface AdScale {
  count: number;
  grades: AdGradeRow[];
  rows: AdRow[];
  categories: string[];
  regions: string[];
  grade_labels: string[];
  has_region: boolean;
  pairing: AdPairing;
  stats: { total: number; aligned: number; fix_lp: number; fix_ad: number; low_vol: number; aligned_pct: number };
}
export interface AdsSection {
  count: number;
  ad_copy: { thresholds: { nonbranded: string; branded: string }; nonbranded: AdScale | null; branded: AdScale | null };
}

// ---- Landing pages ----
export interface LpCatGridRow {
  url: string;
  cost: number;
  clicks: number;
  conv: number;
  overall_cvr: number;
  n_cats: number;
  cvr_by_cat: Record<string, number | null>;
}
export interface LpCatSummary {
  category: string;
  lps_running: number;
  spend: number;
  min_cvr: number;
  median_cvr: number;
  max_cvr: number;
  best_lp: string;
  worst_lp: string;
}
export interface LpCategoryGrid {
  categories: string[];
  rows: LpCatGridRow[];
  summary: LpCatSummary[];
  total: number;
  stats: { landing_pages: number; spend: number; clicks: number; conversions: number; weighted_cvr: number; avg_cats: number };
}
export interface LandingPagesSection {
  count: number;
  performance?: LpRow[];
  category_grid?: LpCategoryGrid | null;
}

// ---- Auction Insights ----
export interface AuctionRow {
  domain: string;
  impr_share: number;
  overlap_rate: number;
  position_above: number;
  top_of_page: number;
  outranking: number;
}
export interface AuctionSection {
  rows: AuctionRow[];
  count: number;
  weighted: boolean;
}

// ---- Budget (Plan) ----
export interface BudgetCatRecon {
  category: string;
  budget: number;
  actual: number;
  variance: number;
  pct: number | null;
  status: string;
}
export interface BudgetReconciliation {
  month: string;
  total_budget: number;
  total_actual: number;
  variance: number;
  pct: number | null;
  status: string;
  by_category: BudgetCatRecon[] | null;
}
export interface BudgetLine {
  brand: string | null;
  region: string | null;
  category: string | null;
  monthly: number;
}
export interface BudgetSection {
  total_monthly: number | null;
  source: string; // file | manual | none
  manual: number | null;
  line_count: number;
  lines: BudgetLine[];
  rollups: Record<string, { key: string; monthly: number }[]>;
  reconciliation: BudgetReconciliation | null;
}

// ---- Pacing (Plan) ----
export interface PacingMonth {
  month: string;
  spend: number;
  budget: number | null;
  variance: number | null;
  pct: number | null;
}
export interface BudgetPacing {
  monthly_budget: number | null;
  months: PacingMonth[];
  latest: PacingMonth | null;
  status: string | null;
}

// ---- Findings + Recommendations (Today / Brief) ----
export interface Finding {
  topic: string;
  detail: string;
}
export interface RecEvidence {
  severity: string;
  module: string;
  observation: string;
  magnitude: string;
  impact: string;
  timing: string;
  data: { columns: string[]; rows: (string | number)[][] } | null;
}
export interface Recommendation {
  Priority: string;
  Category: string;
  Recommendation: string;
  Rationale: string;
  "Expected Impact": string;
  Effort: string;
  evidence: RecEvidence;
  action_key?: string | null;
  status?: ActionStatus;
  owner?: string | null;
  snooze_until?: string | null;
}

// ---- Decision system (Actions + Ledger) ----
export type ActionStatus = "proposed" | "accepted" | "snoozed" | "dismissed" | "done" | "resolved";

export interface ActionItem {
  action_key: string;
  title: string | null;
  priority: string | null;
  category: string | null;
  rationale: string | null;
  expected_impact: string | null;
  effort: string | null;
  evidence: RecEvidence | Record<string, never>;
  live: boolean;
  status: ActionStatus;
  raw_status: ActionStatus;
  owner: string | null;
  snooze_until: string | null;
  dismiss_reason: string | null;
  still_detected: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  updated_at: string | null;
}
export interface TransitionBody {
  to: "accepted" | "snoozed" | "dismissed" | "done" | "reopened";
  note?: string;
  owner?: string;
  snooze_until?: string; // ISO date
  actor?: string;
}
export interface LedgerEvent {
  event_id: number;
  action_key: string;
  ts: string | null;
  actor: string | null;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  evidence: RecEvidence | null;
  title: string | null;
}
export interface LedgerActionSummary {
  action_key: string;
  title: string | null;
  category: string | null;
  priority: string | null;
  status: ActionStatus;
  owner: string | null;
  still_detected: boolean;
  first_seen_at: string | null;
  updated_at: string | null;
}
export interface LedgerResponse {
  events: LedgerEvent[];
  actions: LedgerActionSummary[];
}

export interface Bundle {
  meta: BundleMeta;
  campaigns?: CampaignsSection | null;
  kpis?: KpiRow[];
  total_trend?: TrendPoint[];
  search_terms_section?: SearchTermsSection | null;
  geo_performance?: GeoSection | null;
  landing_pages_section?: LandingPagesSection | null;
  nb_categories_section?: NbCategoriesSection | null;
  regions_section?: RegionsSection | null;
  keyword_section?: KeywordSection | null;
  quality_score?: QualityScoreSection | null;
  qs_breakdown_section?: QsBreakdownSection | null;
  region_category_section?: RegionCategorySection | null;
  ads_section?: AdsSection | null;
  auction_insights_section?: AuctionSection | null;
  budget_section?: BudgetSection | null;
  budget_pacing?: BudgetPacing | null;
  recommendations?: Recommendation[];
  findings?: Finding[];
  [k: string]: unknown;
}
