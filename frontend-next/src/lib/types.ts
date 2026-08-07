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

export interface Bundle {
  meta: BundleMeta;
  campaigns?: CampaignsSection | null;
  kpis?: KpiRow[];
  total_trend?: TrendPoint[];
  search_terms_section?: SearchTermsSection | null;
  geo_performance?: GeoSection | null;
  landing_pages_section?: { performance?: LpRow[] } | null;
  [k: string]: unknown;
}
