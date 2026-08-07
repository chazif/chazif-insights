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

export interface Bundle {
  meta: BundleMeta;
  campaigns?: CampaignsSection | null;
  kpis?: KpiRow[];
  [k: string]: unknown;
}
